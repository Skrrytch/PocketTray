// PocketTray - based on systray@cinnamon.org (linuxmint/cinnamon, GPL-2.0+)
// Milestone 1: XEmbed icons only. Icons whose role is on the "hidden-apps"
// list go into a collapsible pocket instead of the main panel box.
// TODO milestone 2: same split for XApp/SNI icons (xapp-status@cinnamon.org).

const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const SignalManager = imports.misc.signalManager;
const Gettext = imports.gettext;
const AppletManager = imports.ui.appletManager;

const UUID = "PocketTray@spex";
Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
function _(str) {
    return Gettext.dgettext(UUID, str);
}

// Applets that host the XEmbed tray but do not declare "role": "tray".
// Applets that do declare the role are detected via their metadata.json.
const KNOWN_TRAY_APPLETS = [
    "systray@cinnamon.org",
    "collapsible-systray@feuerfuchs.eu"
];
// Bundled pocket icons (icons/pockettray-<key>-symbolic.svg). All of them
// are drawn for a bottom panel; directional ones get rotated to point to
// where the pocket opens.
const POCKET_ICONS = {
    arrow:  { directional: true,  flipWhenOpen: true  },
    drawer: { directional: true,  flipWhenOpen: false },
    pocket: { directional: false, flipWhenOpen: false },
    dots:   { directional: false, flipWhenOpen: false },
    grid:   { directional: false, flipWhenOpen: false }
};

const APPLET_DIRS = [
    GLib.get_home_dir() + "/.local/share/cinnamon/applets",
    "/usr/share/cinnamon/applets"
];

class PocketTrayApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.actor.remove_style_class_name('applet-box');
        this.actor.set_style_class_name('systray');
        this.actor.set_important(true);

        this._uuid_ = metadata.uuid;
        this._instanceId = instance_id;
        this._shuttingDown = false;

        this._signalManager = new SignalManager.SignalManager(null);
        this._scaleUpdateId = 0;
        this._hoverOpenId = 0;
        this._hoverCloseId = 0;

        this.orientation = orientation;
        this.icon_size = this.getPanelIconSize(St.IconType.FULLCOLOR) * global.ui_scale;

        // --- Settings ---------------------------------------------------
        this.hiddenApps = [];
        this.openTrigger = "click";
        this.hoverDelay = 300;
        this.closeDelay = 500;
        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("hidden-apps", "hiddenApps", this._onHiddenAppsChanged.bind(this));
        this.settings.bind("open-trigger", "openTrigger");
        this.settings.bind("hover-delay", "hoverDelay");
        this.settings.bind("close-delay", "closeDelay");
        this.pocketIcon = "theme";
        this.customIcon = "";
        this.settings.bind("pocket-icon", "pocketIcon", () => this._updateToggleIcon());
        this.settings.bind("custom-icon", "customIcon", () => this._updateToggleIcon());

        // Make the bundled SVGs available as themed (recolourable) icons.
        Gtk.IconTheme.get_default().append_search_path(metadata.path + "/icons");

        // --- Main box: icons that stay permanently visible ---------------
        this.button_box = new St.BoxLayout({ vertical: this._isVertical() });
        this.actor.add_actor(this.button_box);
        this.button_box.show();

        // --- Pocket toggle button (only visible when the pocket has icons)
        this.pocket_toggle = new St.Button({
            style_class: 'applet-box',
            reactive: true,
            track_hover: true,
            can_focus: true,
            visible: false
        });
        this.pocket_toggle_icon = new St.Icon({
            icon_type: St.IconType.SYMBOLIC,
            icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC)
        });
        this.pocket_toggle_icon.set_pivot_point(0.5, 0.5);  // rotate around centre
        this.pocket_toggle.set_child(this.pocket_toggle_icon);
        this._updateToggleIcon();
        this.pocket_toggle.connect('clicked', () => this._onToggleClicked());
        this.pocket_toggle.connect('enter-event', () => this._onToggleEnter());
        this.pocket_toggle.connect('leave-event', () => this._onPocketLeave());
        this.actor.add_actor(this.pocket_toggle);

        // --- Pocket container: popup that holds the hidden icons ---------
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        // Anchor the pocket to the toggle button instead of the whole applet:
        // PopupMenu centres itself on sourceActor and clamps to the monitor.
        this.menu.sourceActor = this.pocket_toggle;
        this.menuManager.addMenu(this.menu);
        this.menu.connect('open-state-changed', (menu, open) => {
            this._updateToggleIcon();
            this.pocket_toggle.change_style_pseudo_class("checked", open);
        });
        this.menu.actor.connect('enter-event', () => this._cancelHoverClose());
        this.menu.actor.connect('leave-event', () => this._onPocketLeave());

        this.pocket_box = new St.BoxLayout({ vertical: this._isVertical() });
        let pocketItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        pocketItem.addActor(this.pocket_box, { expand: true });
        this.menu.addMenuItem(pocketItem);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    _isVertical() {
        return [St.Side.LEFT, St.Side.RIGHT].includes(this.orientation);
    }

    _toggleIconName(open) {
        switch (this.orientation) {
            case St.Side.TOP:    return open ? "pan-up-symbolic"    : "pan-down-symbolic";
            case St.Side.BOTTOM: return open ? "pan-down-symbolic"  : "pan-up-symbolic";
            case St.Side.LEFT:   return open ? "pan-start-symbolic" : "pan-end-symbolic";
            default:             return open ? "pan-end-symbolic"   : "pan-start-symbolic";
        }
    }

    // Rotation that turns an upward-pointing icon towards the pocket.
    _openDirectionAngle() {
        switch (this.orientation) {
            case St.Side.TOP:   return 180;   // pocket opens downwards
            case St.Side.LEFT:  return 90;    // ... to the right
            case St.Side.RIGHT: return 270;   // ... to the left
            default:            return 0;     // bottom panel: upwards
        }
    }

    _updateToggleIcon() {
        const icon = this.pocket_toggle_icon;
        if (!icon) return;  // settings callback before construction finished

        const open = this.menu ? this.menu.isOpen : false;
        let angle = 0;

        icon.set_icon_size(this.getPanelIconSize(St.IconType.SYMBOLIC));

        if (this.pocketIcon === "custom" && this.customIcon) {
            // iconfilechooser gives either an absolute path or an icon name
            if (this.customIcon.startsWith("/")) {
                icon.set_gicon(new Gio.FileIcon({ file: Gio.File.new_for_path(this.customIcon) }));
            } else {
                icon.set_icon_name(this.customIcon);
            }
        } else if (POCKET_ICONS[this.pocketIcon]) {
            const def = POCKET_ICONS[this.pocketIcon];
            icon.set_icon_name("pockettray-" + this.pocketIcon + "-symbolic");
            if (def.directional) angle = this._openDirectionAngle();
            if (def.flipWhenOpen && open) angle += 180;
        } else {
            // "theme" (default) or custom without a file: theme arrow
            icon.set_icon_name(this._toggleIconName(open));
        }

        icon.rotation_angle_z = angle % 360;
    }

    _isHidden(role) {
        const r = String(role).toLowerCase().trim();
        return (this.hiddenApps || []).some(
            (entry) => entry && entry.name && entry.name.toLowerCase().trim() === r);
    }

    _updatePocketToggle() {
        const count = this.pocket_box.get_n_children();
        this.pocket_toggle.visible = count > 0;
        if (count === 0 && this.menu.isOpen) {
            this.menu.close();
        }
    }

    _onHiddenAppsChanged() {
        // Re-sort every icon: the dispatcher re-emits status-icon-added
        // for each one, so _onTrayIconAdded picks the right container.
        Main.statusIconDispatcher.redisplay();
    }

    // ------------------------------------------------------------------
    // Pocket open/close
    // ------------------------------------------------------------------
    _onToggleClicked() {
        this._cancelHoverOpen();
        this.menu.toggle();
    }

    _onToggleEnter() {
        if (this.openTrigger !== "hover") return;
        this._cancelHoverClose();
        if (this.menu.isOpen || this._hoverOpenId > 0) return;
        this._hoverOpenId = Mainloop.timeout_add(this.hoverDelay, () => {
            this._hoverOpenId = 0;
            this.menu.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onPocketLeave() {
        this._cancelHoverOpen();
        if (this.openTrigger !== "hover" || !this.menu.isOpen) return;
        this._cancelHoverClose();
        this._hoverCloseId = Mainloop.timeout_add(this.closeDelay, () => {
            this._hoverCloseId = 0;
            this.menu.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverOpen() {
        if (this._hoverOpenId > 0) {
            Mainloop.source_remove(this._hoverOpenId);
            this._hoverOpenId = 0;
        }
    }

    _cancelHoverClose() {
        if (this._hoverCloseId > 0) {
            Mainloop.source_remove(this._hoverCloseId);
            this._hoverCloseId = 0;
        }
    }

    // ------------------------------------------------------------------
    // Applet lifecycle (adapted from systray@cinnamon.org)
    // ------------------------------------------------------------------
    on_applet_clicked(event) {
    }

    on_orientation_changed(neworientation) {
        this.orientation = neworientation;
        this.button_box.set_vertical(this._isVertical());
        this.pocket_box.set_vertical(this._isVertical());
        this._updateToggleIcon();
        this.update_na_tray_orientation();
    }

    update_na_tray_orientation() {
        switch (this.orientation) {
            case St.Side.LEFT:
            case St.Side.RIGHT:
                Main.statusIconDispatcher.set_tray_orientation(Clutter.Orientation.VERTICAL);
                break;
            default:
                Main.statusIconDispatcher.set_tray_orientation(Clutter.Orientation.HORIZONTAL);
                break;
        }
    }

    on_applet_reloaded() {
        global.trayReloading = true;
    }

    on_applet_removed_from_panel() {
        this._cancelHoverOpen();
        this._cancelHoverClose();
        this._signalManager.disconnectAllSignals();
        this.settings.finalize();
        this._clearIcons();
    }

    // ------------------------------------------------------------------
    // Conflict guard: only one applet may own the XEmbed tray icons
    // ------------------------------------------------------------------
    _readMetadata(uuid) {
        for (const dir of APPLET_DIRS) {
            const path = dir + "/" + uuid + "/metadata.json";
            try {
                if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue;
                const [ok, bytes] = GLib.file_get_contents(path);
                if (ok) return JSON.parse(new TextDecoder().decode(bytes));
            } catch (e) {
                global.logWarning("PocketTray: cannot read " + path + ": " + e);
            }
        }
        return null;
    }

    // Returns { uuid, name } of another enabled tray applet, or null.
    _findRivalTray() {
        const enabled = global.settings.get_strv("enabled-applets");
        for (const entry of enabled) {
            const uuid = entry.split(":")[3];
            if (!uuid || uuid === this._uuid_) continue;

            const meta = this._readMetadata(uuid);
            const roles = (meta && meta.role) ? meta.role.replace(/ /g, "").split(",") : [];
            if (KNOWN_TRAY_APPLETS.includes(uuid) || roles.includes("tray")) {
                return { uuid: uuid, name: (meta && meta.name) ? meta.name : uuid };
            }
        }
        return null;
    }

    _onEnabledAppletsChanged() {
        const rival = this._findRivalTray();
        if (rival) this._shutdownBecauseOf(rival, true);
    }

    // Hand the icons back, tell the user, and remove this instance from the
    // panel. The settings file is kept, so re-adding PocketTray restores them.
    _shutdownBecauseOf(rival, wasRunning) {
        const rivalName = rival.name;
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        global.logWarning("PocketTray: another tray applet is active (" + rivalName + "), shutting down");

        if (wasRunning) {
            this._signalManager.disconnectAllSignals();
            this._cancelHoverOpen();
            this._cancelHoverClose();
            this._clearIcons();
            PocketTrayApplet._handOverIcons(rival.uuid);
        }

        Main.warningNotify(
            _("PocketTray has been removed from the panel"),
            _("The applet \"%s\" already shows the tray icons. Two tray applets at the same time can crash Cinnamon. Remove \"%s\" from the panel first, then add PocketTray again.")
                .replace(/%s/g, rivalName),
            new St.Icon({ icon_name: "dialog-warning-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: 24 })
        );

        // Defer: never change enabled-applets while the applet manager is
        // still busy adding or reacting to a change.
        Mainloop.idle_add(() => {
            const id = String(this._instanceId);
            const list = global.settings.get_strv("enabled-applets").filter((entry) => {
                const info = entry.split(":");
                return !(info[3] === this._uuid_ && info[4] === id);
            });
            global.settings.set_strv("enabled-applets", list);
            return GLib.SOURCE_REMOVE;
        });
    }

    // The rival applet is usually loaded *after* this change notification,
    // so wait until it runs, then re-emit all icons for it. Static on
    // purpose: this instance is gone by the time the timer fires.
    static _handOverIcons(rivalUuid) {
        let tries = 0;
        Mainloop.timeout_add(250, () => {
            tries++;
            let running = false;
            try {
                running = AppletManager.getRunningInstancesForUuid(rivalUuid).length > 0;
            } catch (e) {
                global.logWarning("PocketTray: cannot query " + rivalUuid + ": " + e);
            }
            if (running || tries >= 20) {
                Main.statusIconDispatcher.redisplay();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    on_applet_added_to_panel() {
        const rival = this._findRivalTray();
        if (rival) {
            // Do not touch the status icon dispatcher at all.
            this._shutdownBecauseOf(rival, false);
            return;
        }

        if (!global.trayReloading) {
            Main.statusIconDispatcher.start(this.actor.get_parent().get_parent());
        }

        this.update_na_tray_orientation();

        this._signalManager.connect(Main.statusIconDispatcher, 'status-icon-added', this._onTrayIconAdded, this);
        this._signalManager.connect(Main.statusIconDispatcher, 'status-icon-removed', this._onTrayIconRemoved, this);
        this._signalManager.connect(Main.statusIconDispatcher, 'before-redisplay', this._onBeforeRedisplay, this);
        this._signalManager.connect(Main.systrayManager, "changed", Main.statusIconDispatcher.redisplay, Main.statusIconDispatcher);
        this._signalManager.connect(global, "scale-changed", this.uiScaleChanged, this);
        this._signalManager.connect(global.settings, 'changed::panel-edit-mode', this.on_panel_edit_mode_changed, this);
        this._signalManager.connect(global.settings, 'changed::enabled-applets', this._onEnabledAppletsChanged, this);

        // Always ask for the icons again. When PocketTray is added while the
        // tray manager already runs (e.g. replacing the stock systray), the
        // dispatcher does not re-emit existing icons on its own. Deferred so
        // that a tray applet removed in the same change has cleaned up first.
        global.trayReloading = false;
        Mainloop.idle_add(() => {
            if (!this._shuttingDown) {
                Main.statusIconDispatcher.redisplay();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearIcons() {
        [this.button_box, this.pocket_box].forEach((box) => {
            box.get_children().forEach((button) => this._destroyButton(button));
        });
        this._updatePocketToggle();
    }

    // St.Bin asserts (and kills Cinnamon) if it is destroyed while it still
    // references a child. Always detach the icon first; never touch a child
    // that is already gone or that another container has taken over.
    _destroyButton(button) {
        if (!button || button.is_finalized()) return;
        try {
            const child = button.get_child();
            if (child) {
                button.set_child(null);
            }
        } catch (e) {
            global.logError("PocketTray: detaching icon failed: " + e);
        }
        button.destroy();
    }

    _isOurButton(actor) {
        if (!actor) return false;
        const box = actor.get_parent();
        return box === this.button_box || box === this.pocket_box;
    }

    resizeIcons() {
        this.icon_size = this.getPanelIconSize() * global.ui_scale;
        this._updateToggleIcon();
        Main.statusIconDispatcher.redisplay();
    }

    on_panel_icon_size_changed(size) {
        this.resizeIcons();
    }

    on_panel_edit_mode_changed() {
        this.resizeIcons();
    }

    uiScaleChanged() {
        if (this._scaleUpdateId > 0) {
            Mainloop.source_remove(this._scaleUpdateId);
        }

        this._scaleUpdateId = Mainloop.timeout_add(1500, () => {
            this.resizeIcons();
            this._scaleUpdateId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBeforeRedisplay() {
        this._clearIcons();
    }

    // ------------------------------------------------------------------
    // Icon handling: the one place where the tray is split in two
    // ------------------------------------------------------------------
    _onTrayIconAdded(o, icon, role) {
        try {
            let hiddenIcons = Main.systrayManager.getRoles();

            if (hiddenIcons.indexOf(role.toLowerCase()) != -1) {
                // A dedicated applet handles that one
                global.log("Hiding systray: " + role);
                return;
            }

            if (icon.get_parent()) {
                // Another tray applet (e.g. the stock systray) already holds
                // this icon. Stealing it would leave that applet with a stale
                // St.Bin and crash Cinnamon on its next cleanup.
                global.logWarning("PocketTray: icon '" + role + "' already has a parent - is a second tray applet running?");
                return;
            }

            const toPocket = this._isHidden(role);
            global.log("PocketTray: icon role '" + role + "' -> " + (toPocket ? "pocket" : "panel"));

            let button = new St.Bin({
                style_class: "applet-box",
                child: icon
            });

            icon.set_x_align(Clutter.ActorAlign.CENTER);
            icon.set_y_align(Clutter.ActorAlign.FILL);
            button.set_y_align(Clutter.ActorAlign.FILL);

            icon.visible = false;
            icon.opacity = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (button.is_finalized()) {
                    return GLib.SOURCE_REMOVE;
                }
                if (icon.is_finalized()) {
                    this._destroyButton(button);
                    this._updatePocketToggle();
                    return GLib.SOURCE_REMOVE;
                }

                icon.reactive = true;
                icon.visible = true;
                icon.set_size(this.icon_size, this.icon_size);
                icon.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

                icon.connect("event", (actor, event) => this._onEvent(actor, event));
                return GLib.SOURCE_REMOVE;
            });

            if (toPocket) {
                this.pocket_box.insert_child_at_index(button, 0);
            } else {
                this.button_box.insert_child_at_index(button, 0);
            }
            this._updatePocketToggle();
        } catch (e) {
            global.logError(e);
        }
    }

    _onEvent(icon, event) {
        let etype = event.type();
        const button = icon.get_parent();

        if (button == null) {
            return GLib.SOURCE_REMOVE;
        }

        if (etype === Clutter.EventType.BUTTON_PRESS) {
            global.begin_modal(Meta.ModalOptions.POINTER_ALREADY_GRABBED, event.time);
        } else if (etype === Clutter.EventType.ENTER) {
            button.add_style_pseudo_class("hover");
        } else if (etype === Clutter.EventType.LEAVE) {
            button.remove_style_pseudo_class("hover");
        }

        let ret = icon.handle_event(etype, event);

        if (etype === Clutter.EventType.BUTTON_PRESS) {
            global.end_modal(event.time);
        }

        return ret;
    }

    _onTrayIconRemoved(o, icon) {
        const parent = icon.get_parent();

        if (!this._isOurButton(parent)) {
            // Not ours (hidden role, other applet, or already cleared)
            return;
        }
        this._destroyButton(parent);
        this._updatePocketToggle();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new PocketTrayApplet(metadata, orientation, panel_height, instance_id);
}
