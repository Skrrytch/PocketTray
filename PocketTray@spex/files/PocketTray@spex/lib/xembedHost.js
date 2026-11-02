// Legacy X11 tray icons (XEmbed), adapted from systray@cinnamon.org
// (linuxmint/cinnamon, GPL-2.0-or-later).
//
// Cinnamon's Main.statusIconDispatcher owns the X11 tray. It emits
// "status-icon-added" for every icon, with the icon's role (WM_CLASS) as
// id. Icons can't be moved around freely: redisplay() makes the dispatcher
// drop and re-emit all of them, which is how they get re-sorted after the
// hidden list changed.
//
// Owner interface (implemented by PocketTrayApplet):
//   owner.actor, owner.orientation, owner.getPanelIconSize(), owner.pocket
//   owner.placeIcon(actor, id, options) -> true if it went into the pocket
//   owner.showsNames(actor) -> whether the actor is shown as a name row
//   owner.statusSlotSize() -> width of the icon slot in name rows
//   owner.iconsChanged()
//
// Each icon sits in an St.Bin ("button"), which sits in a row together with
// a name label; the label is only visible in the pocket's name rows.
// Legacy icons have no tooltip, so they show their name only.

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const SignalManager = imports.misc.signalManager;
const { normalizeId } = require('./lib/hiddenList');
const { appName, makeAppIcon } = require('./lib/appInfo');

class XEmbedHost {
    constructor(owner) {
        this._owner = owner;
        this._signals = new SignalManager.SignalManager(null);
        this._redisplayIdleId = 0;
        this._started = false;
        // tray icon actor -> { row, button: St.Bin, nameLabel, id, wmClass }
        this._icons = new Map();
        this._iconSize = owner.getPanelIconSize(St.IconType.FULLCOLOR) * global.ui_scale;
    }

    // Connects to the dispatcher and asks it for all current icons.
    start() {
        if (this._started) return;
        this._started = true;

        // After an applet reload the dispatcher is still running
        // (see PocketTrayApplet.on_applet_reloaded).
        if (!global.trayReloading) {
            Main.statusIconDispatcher.start(this._owner.actor.get_parent().get_parent());
        }
        this.updateOrientation();

        const dispatcher = Main.statusIconDispatcher;
        this._signals.connect(dispatcher, "status-icon-added", this._onIconAdded, this);
        this._signals.connect(dispatcher, "status-icon-removed", this._onIconRemoved, this);
        this._signals.connect(dispatcher, "before-redisplay", this._clear, this);
        // An applet claimed or released a role (e.g. the network applet)
        this._signals.connect(Main.systrayManager, "changed", this.redisplay, this);

        // When PocketTray replaces another tray applet at runtime, the
        // dispatcher does not re-emit existing icons by itself. Deferred so a
        // tray applet removed in the same change has cleaned up first.
        global.trayReloading = false;
        this._redisplayIdleId = Mainloop.idle_add(() => {
            this._redisplayIdleId = 0;
            this.redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Safe to call more than once.
    stop() {
        if (this._redisplayIdleId > 0) {
            Mainloop.source_remove(this._redisplayIdleId);
            this._redisplayIdleId = 0;
        }
        this._signals.disconnectAllSignals();
        this._clear();
        this._started = false;
    }

    // Drop and re-add all icons, e.g. after the hidden list changed.
    redisplay() {
        Main.statusIconDispatcher.redisplay();
    }

    // Panel icon size or UI scale changed.
    resize() {
        this._iconSize = this._owner.getPanelIconSize() * global.ui_scale;
        this.redisplay();
    }

    updateOrientation() {
        const vertical = [St.Side.LEFT, St.Side.RIGHT].includes(this._owner.orientation);
        Main.statusIconDispatcher.set_tray_orientation(
            vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL);
    }

    // Entries for the context menu: [{ id, label, makeIcon }]. Legacy icons
    // carry no icon name, so the menu shows the application's launcher icon.
    menuEntries() {
        return [...this._icons.values()].map(({ id, wmClass }) => ({
            id: id,
            label: id,
            makeIcon: (size) => makeAppIcon([wmClass, id], size)
        }));
    }

    // Name rows: the button gets the same icon slot as the XApp rows, so the
    // names start in one column. Other layouts keep the natural width.
    _applyRowLayout(entry) {
        const { row, button, nameLabel } = entry;
        const show = this._owner.showsNames(row);
        nameLabel.visible = show;
        if (show) {
            const padding = button.get_theme_node().get_horizontal_padding();
            button.set_width(this._owner.statusSlotSize() + padding);
            button.set_x_align(Clutter.ActorAlign.CENTER);
        } else {
            button.set_width(-1);
        }
    }

    // ------------------------------------------------------------------
    // Dispatcher callbacks
    // ------------------------------------------------------------------
    _onIconAdded(dispatcher, icon, role) {
        try {
            if (Main.systrayManager.getRoles().indexOf(role.toLowerCase()) !== -1) {
                // A dedicated applet shows this one (e.g. network, sound)
                global.log("PocketTray: icon '" + role + "' is handled by another applet");
                return;
            }
            if (icon.get_parent()) {
                // Another tray applet already holds this icon. Taking it
                // would leave that applet with a stale St.Bin, which crashes
                // Cinnamon on its next cleanup (see _destroyButton()).
                global.logWarning("PocketTray: icon '" + role + "' already has a parent - is a second tray applet running?");
                return;
            }

            const id = normalizeId(role);
            const wmClass = icon.wm_class || role;
            const button = new St.Bin({ style_class: "applet-box", child: icon });
            button.set_y_align(Clutter.ActorAlign.FILL);
            icon.set_x_align(Clutter.ActorAlign.CENTER);
            icon.set_y_align(Clutter.ActorAlign.FILL);

            const nameLabel = new St.Label({
                text: appName([wmClass, id]) || id,
                style: "font-weight: bold;",
                y_align: Clutter.ActorAlign.CENTER,
                visible: false
            });
            const row = new St.BoxLayout({ style: "spacing: 8px;" });
            row.set_y_align(Clutter.ActorAlign.FILL);
            row.add_actor(button);
            row.add_actor(nameLabel);
            this._icons.set(icon, { row, button, nameLabel, id, wmClass });

            // Like the stock systray: show the icon only after its X window
            // had time to settle, then fade it in.
            icon.visible = false;
            icon.opacity = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (button.is_finalized()) {
                    return GLib.SOURCE_REMOVE;
                }
                if (icon.is_finalized()) {
                    this._removeIcon(icon);
                    return GLib.SOURCE_REMOVE;
                }
                icon.reactive = true;
                icon.visible = true;
                icon.set_size(this._iconSize, this._iconSize);
                icon.ease({ opacity: 255, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                this._connectIconEvents(icon, button, row);
                return GLib.SOURCE_REMOVE;
            });

            const toPocket = this._owner.placeIcon(row, id, { atStart: true });
            this._applyRowLayout(this._icons.get(icon));
            global.log("PocketTray: X11 icon '" + id + "' -> " + (toPocket ? "pocket" : "panel"));
            this._owner.iconsChanged();
        } catch (e) {
            global.logError(e);
        }
    }

    _onIconRemoved(dispatcher, icon) {
        // Unknown icons were skipped above or belong to another applet.
        this._removeIcon(icon);
    }

    // Forwards pointer events to the embedded X window.
    //
    // While a mouse button is held, Cinnamon has the pointer grabbed, so the
    // application could not open its menu. The stock systray works around
    // this with a global modal grab; here the press is swallowed and sent to
    // the application on release instead, when the grab is gone (as in
    // collapsible-systray@feuerfuchs.eu). Inside the pocket, the pocket then
    // closes so that its own modal grab doesn't block the menu either.
    _connectIconEvents(icon, button, row) {
        icon.connect("button-press-event", () => Clutter.EVENT_STOP);
        icon.connect("button-release-event", (actor, event) => {
            const result = icon.handle_event(Clutter.EventType.BUTTON_PRESS, event);
            this._owner.pocket.closeIfContains(row);
            return result;
        });
        icon.connect("enter-event", (actor, event) => {
            button.add_style_pseudo_class("hover");
            return icon.handle_event(Clutter.EventType.ENTER, event);
        });
        icon.connect("leave-event", (actor, event) => {
            button.remove_style_pseudo_class("hover");
            return icon.handle_event(Clutter.EventType.LEAVE, event);
        });
    }

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    _removeIcon(icon) {
        const entry = this._icons.get(icon);
        if (!entry) return;
        this._icons.delete(icon);
        this._destroyEntry(entry);
        this._owner.iconsChanged();
    }

    _clear() {
        for (const entry of this._icons.values()) {
            this._destroyEntry(entry);
        }
        this._icons.clear();
        this._owner.iconsChanged();
    }

    // St.Bin asserts - and takes Cinnamon down - when it is destroyed while
    // it still references a child. Always detach the icon first, then
    // destroy the row (and with it the empty button and the label).
    _destroyEntry({ row, button }) {
        try {
            if (!button.is_finalized() && button.get_child()) {
                button.set_child(null);
            }
        } catch (e) {
            global.logError("PocketTray: detaching icon failed: " + e);
        }
        if (!row.is_finalized()) {
            row.destroy();
        }
    }
}

module.exports = { XEmbedHost };
