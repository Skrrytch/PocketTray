// PocketTray - a system tray with a pocket for the icons you rarely need.
//
// Replaces both stock tray applets (systray@cinnamon.org for legacy X11
// icons, xapp-status@cinnamon.org for XApp/StatusNotifier icons) and sorts
// every tray icon either into the panel or into a pocket that opens from a
// button next to the icons.
//
// Structure (all modules in lib/):
//
//   applet.js           this file: Cinnamon lifecycle, settings, wiring
//   lib/xembedHost.js   legacy X11 icons via Main.statusIconDispatcher
//   lib/xappHost.js     XApp status icons via XApp.StatusIconMonitor
//   lib/xappStatusIcon.js  a single XApp icon, screen-recording indicator
//   lib/hiddenList.js   which icon ids belong into the pocket
//   lib/pocketButton.js the button in the panel and its icon
//   lib/pocket.js       the popup holding the hidden icons, click/hover
//   lib/iconMenu.js     context menu: one switch per icon
//   lib/appInfo.js      launcher entry, name, icon and tooltip text of an app
//   lib/rivalGuard.js   steps back when another tray applet is enabled
//   lib/i18n.js         translations
//
// Data flow: a host gets an icon -> applet.placeIcon() asks the hidden list
// and puts the icon into panelBox or pocket.box -> applet.iconsChanged()
// lets the pocket show or hide its button. When the hidden list changes,
// both hosts re-sort their icons.

const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const SignalManager = imports.misc.signalManager;

// Modules in lib/ are loaded with Cinnamon's require(). Unlike the classic
// per-applet importer (imports.ui.appletManager.applets[uuid]), whose modules
// stay cached until Cinnamon restarts, require() notices changed files, so an
// applet update takes effect on reload. require() is deprecated as of
// Cinnamon 6.8; switch to its replacement once that version can be tested.
const { HiddenList } = require('./lib/hiddenList');
const { PocketButton } = require('./lib/pocketButton');
const { Pocket } = require('./lib/pocket');
const { XEmbedHost } = require('./lib/xembedHost');
const { XAppHost } = require('./lib/xappHost');
const { IconMenuSection } = require('./lib/iconMenu');
const RivalGuard = require('./lib/rivalGuard');

// Value of the "pocket-position" setting that puts the button first.
const BUTTON_BEFORE_ICONS = "left";
// Value of the "pocket-layout" setting for rows with name and status text.
const STATUS_LAYOUT = "status";
// Value of "pocket-layout" that shows application names next to the icons.
const NAMES_LAYOUT = "names";
// Free space next to each icon in the name rows, on top of the icon size.
const NAME_ROW_ICON_PADDING = 8;
// Values of "pocket-order"; any other value keeps the order of appearance.
const ORDER_BY_NAME = "name";
const ORDER_BY_LIST = "list";
// Name of the keyboard shortcut registered with Cinnamon.
const SHORTCUT_NAME = "toggle-pocket";

class PocketTrayApplet extends Applet.Applet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        // Look like the stock tray: no box around the whole applet
        this.actor.remove_style_class_name("applet-box");
        this.actor.set_style_class_name("systray");
        this.actor.set_important(true);

        this.orientation = orientation;
        this._uuid = metadata.uuid;
        this._instanceId = instanceId;
        this._retired = false;
        this._shortcutActive = false;
        this._signals = new SignalManager.SignalManager(null);
        this._scaleUpdateId = 0;
        // icon actor -> { id, name }, for sorting the pocket
        this._iconInfo = new WeakMap();

        this._bindSettings();

        // Icons that stay in the panel
        this.panelBox = new St.BoxLayout({ vertical: this.isVertical() });
        this.actor.add_actor(this.panelBox);

        this.pocketButton = new PocketButton(this, this.config);
        this.actor.add_actor(this.pocketButton.actor);
        this._updateButtonPosition();

        this.pocket = new Pocket(this, this.config, this.pocketButton);
        this.pocket.setVertical(this._pocketVertical());

        this.hiddenList = new HiddenList(this.settings, () => this._onHiddenListChanged());
        this._xembed = new XEmbedHost(this);
        this._xapp = new XAppHost(this);
        this._iconMenu = new IconMenuSection(this._applet_context_menu, [this._xembed, this._xapp], this.hiddenList);
    }

    // Settings about the hidden icons are bound in HiddenList; all others end
    // up in this.config, which PocketButton and Pocket read from.
    _bindSettings() {
        this.settings = new Settings.AppletSettings(this, this._uuid, this._instanceId);
        this.config = {};
        const bind = (key, prop, onChange) =>
            this.settings.bindWithObject(this.config, key, prop, onChange || null);

        bind("open-trigger", "openTrigger");
        bind("hover-delay", "hoverDelay");
        bind("close-delay", "closeDelay");
        bind("pocket-position", "pocketPosition", () => this._updateButtonPosition());
        bind("pocket-icon", "pocketIcon", () => this.pocketButton.update());
        bind("custom-icon", "customIcon", () => this.pocketButton.update());
        bind("pocket-shortcut", "pocketShortcut", () => this._updateShortcut());
        bind("surface-on-change", "surfaceOnChange", () => {
            if (!this.config.surfaceOnChange) this._xapp.endSurfacing();
        });
        bind("surface-duration", "surfaceDuration");
        bind("pocket-layout", "pocketLayout", () => this._applyPocketLayout());
        bind("pocket-order", "pocketOrder", () => this._sortPocket());
    }

    // ------------------------------------------------------------------
    // Interface for the hosts (XEmbedHost, XAppHost)
    // ------------------------------------------------------------------
    isVertical() {
        return this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT;
    }

    // Puts an icon actor into the pocket or the panel, depending on the
    // hidden list; moves it if it is in the wrong one. Returns true for the
    // pocket.
    // options.name:          display name, used to sort the pocket
    // options.atStart:       insert as first icon instead of last
    // options.provisionalId: the id is not final yet (see XAppStatusIcon);
    //                        don't record it as a known icon
    // options.surfaced:      belongs into the pocket, but is shown in the
    //                        panel for a while because it changed (XAppHost)
    placeIcon(actor, id, { name = id, atStart = false, provisionalId = false, surfaced = false } = {}) {
        if (!provisionalId) {
            this.hiddenList.noticeIcon(id);
        }
        this._iconInfo.set(actor, { id, name });
        const toPocket = this.hiddenList.has(id) && !surfaced;
        const target = toPocket ? this.pocket.box : this.panelBox;
        const parent = actor.get_parent();

        if (parent !== target) {
            if (parent) parent.remove_child(actor);
            if (atStart) {
                target.insert_child_at_index(actor, 0);
            } else {
                target.add_child(actor);
            }
        }
        if (toPocket) {
            this._sortPocket();   // also when only the name changed
        }
        return toPocket;
    }

    // Whether an icon actor is shown as a name row: only in the pocket, and
    // only with a layout that has names.
    showsNames(actor) {
        return this._nameRows() && actor.get_parent() === this.pocket.box;
    }

    // Width of the icon slot in the name rows, in physical pixels like all
    // actor sizes (getPanelIconSize() is in logical pixels). One size for
    // every icon type, so the names start in the same column.
    statusSlotSize() {
        const symbolic = this.getPanelIconSize(St.IconType.SYMBOLIC);
        const fullColor = this.getPanelIconSize(St.IconType.FULLCOLOR);
        return (Math.max(symbolic, fullColor) + NAME_ROW_ICON_PADDING) * global.ui_scale;
    }

    // Icons were added, removed, moved or hidden.
    iconsChanged() {
        this.pocket.updateVisibility();
    }

    // ------------------------------------------------------------------
    // Cinnamon applet lifecycle
    // ------------------------------------------------------------------
    on_applet_added_to_panel() {
        const rivals = RivalGuard.findRivalTrays(this._uuid);
        if (rivals) {
            // Never touch the tray icons while another tray applet runs.
            this._retire(rivals, false);
            return;
        }

        this._xembed.start();
        this._xapp.start();

        this._shortcutActive = true;
        this._updateShortcut();

        this._signals.connect(global, "scale-changed", this._onUiScaleChanged, this);
        this._signals.connect(global.settings, "changed::panel-edit-mode", this.on_panel_edit_mode_changed, this);
        this._signals.connect(global.settings, "changed::enabled-applets", this._onEnabledAppletsChanged, this);
    }

    on_applet_removed_from_panel() {
        this._stopAll();
        this.settings.finalize();
        this.pocket.destroy();
    }

    // The X11 tray dispatcher keeps running across an applet reload;
    // XEmbedHost.start() reads this flag to not start it a second time.
    on_applet_reloaded() {
        global.trayReloading = true;
    }

    on_applet_clicked(event) {
        // Clicks go to the icons and the pocket button.
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this.panelBox.set_vertical(this.isVertical());
        this.pocket.setVertical(this._pocketVertical());
        this.pocketButton.update();
        this._xembed.updateOrientation();
        this._xapp.refresh();
    }

    on_panel_icon_size_changed(size) {
        this._resizeIcons();
    }

    on_panel_edit_mode_changed() {
        const reactive = !global.settings.get_boolean("panel-edit-mode");
        this._xapp.setReactive(reactive);
        this._xembed.setReactive(reactive);
        this._resizeIcons();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    _onHiddenListChanged() {
        this._xembed.redisplay();   // X11 icons are re-added and re-sorted
        this._xapp.sync();          // XApp icons are moved directly
    }

    _updateButtonPosition() {
        if (!this.pocketButton) return;   // settings callback during construction
        const index = this.config.pocketPosition === BUTTON_BEFORE_ICONS ? 0 : this.actor.get_n_children() - 1;
        this.actor.set_child_at_index(this.pocketButton.actor, index);
    }

    // (Re-)registers the keyboard shortcut; an empty setting removes it.
    _updateShortcut() {
        if (!this._shortcutActive) return;   // not on the panel (yet), or retired
        Main.keybindingManager.addXletHotKey(this, SHORTCUT_NAME, this.config.pocketShortcut,
            () => this.pocket.toggle());
    }

    // Rows with application names (and optionally status text) are stacked;
    // plain icons follow the panel orientation.
    _nameRows() {
        const layout = this.config.pocketLayout;
        return layout === NAMES_LAYOUT || layout === STATUS_LAYOUT;
    }

    // Whether the rows also carry the tooltip text.
    showsStatusText() {
        return this.config.pocketLayout === STATUS_LAYOUT;
    }

    _pocketVertical() {
        return this._nameRows() || this.isVertical();
    }

    // Sorts the pocket by name or by the hidden-icons list, if chosen.
    // Otherwise new icons keep their place: X11 icons in front, XApp icons
    // behind (as the hosts insert them). Switching back to that order takes
    // effect when the icons appear again, e.g. after a restart.
    _sortPocket() {
        const order = this.config.pocketOrder;
        if (order !== ORDER_BY_NAME && order !== ORDER_BY_LIST) return;

        const box = this.pocket.box;
        const info = (actor) => this._iconInfo.get(actor) || { id: "", name: "" };
        const byName = (a, b) => GLib.utf8_collate(info(a).name.toLowerCase(), info(b).name.toLowerCase());
        const byList = (a, b) =>
            this.hiddenList.position(info(a).id) - this.hiddenList.position(info(b).id) || byName(a, b);

        const sorted = box.get_children().sort(order === ORDER_BY_LIST ? byList : byName);
        sorted.forEach((actor, index) => {
            if (box.get_child_at_index(index) !== actor) {
                box.set_child_at_index(actor, index);
            }
        });
    }

    _applyPocketLayout() {
        this.pocket.setVertical(this._pocketVertical());
        this._xapp.updateNameRows();
        this._xembed.redisplay();   // X11 rows are rebuilt with or without name
    }

    _resizeIcons() {
        this.pocketButton.update();
        this._xapp.refresh();
        this._xembed.resize();
    }

    // UI scale changes come in bursts; resize once they have settled.
    _onUiScaleChanged() {
        if (this._scaleUpdateId > 0) {
            Mainloop.source_remove(this._scaleUpdateId);
        }
        this._scaleUpdateId = Mainloop.timeout_add(1500, () => {
            this._scaleUpdateId = 0;
            this._resizeIcons();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onEnabledAppletsChanged() {
        const rivals = RivalGuard.findRivalTrays(this._uuid);
        if (rivals) {
            this._retire(rivals, true);
        }
    }

    // Steps back for another tray applet (see lib/rivalGuard.js).
    // wasRunning: PocketTray already hosted icons and has to hand them over.
    _retire(rivals, wasRunning) {
        if (this._retired) return;
        this._retired = true;

        if (wasRunning) {
            this._stopAll();
            RivalGuard.handOverIcons(rivals);
        }
        RivalGuard.retire(this._uuid, this._instanceId, rivals);
    }

    // Stops hosting icons and listening to anything. Safe to call twice:
    // retiring is followed by on_applet_removed_from_panel().
    _stopAll() {
        if (this._scaleUpdateId > 0) {
            Mainloop.source_remove(this._scaleUpdateId);
            this._scaleUpdateId = 0;
        }
        this._signals.disconnectAllSignals();
        if (this._shortcutActive) {
            Main.keybindingManager.removeXletHotKey(this, SHORTCUT_NAME);
            this._shortcutActive = false;
        }
        this.pocket.close();
        this._xembed.stop();
        this._xapp.stop();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new PocketTrayApplet(metadata, orientation, panelHeight, instanceId);
}
