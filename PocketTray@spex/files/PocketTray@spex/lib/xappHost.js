// XApp status icons, adapted from xapp-status@cinnamon.org
// (linuxmint/cinnamon, GPL-2.0-or-later).
//
// XApp.StatusIconMonitor reports every XApp status icon on the session bus.
// StatusNotifierItems (Electron, Qt, KDE apps) arrive here too: the
// xapp-sn-watcher service turns them into XApp status icons as long as a
// monitor like this one exists. Without any monitor they fall back to
// legacy X11 icons that are all called "xapp-sn-watcher".
//
// Unlike X11 icons, these icons are drawn by PocketTray itself
// (XAppStatusIcon), so they can be moved between panel and pocket directly.
//
// Surfacing (setting "surface-on-change", off by default): when an icon that
// lives in the pocket reports activity, it is shown in the panel for
// "surface-duration" seconds; every further activity restarts the time, a
// click ends it. The hidden list itself is never changed.
//
// Owner interface (implemented by PocketTrayApplet):
//   owner.panel, owner.orientation, owner.getPanelIconSize(), owner.isVertical()
//   owner.panelBox, owner.pocket, owner.hiddenList
//   owner.config.surfaceOnChange, owner.config.surfaceDuration
//   owner.placeIcon(actor, id, options) -> true if it went into the pocket
//   owner.showsNames(actor) -> whether the actor is shown as a name row
//   owner.statusSlotSize() -> width of the icon slot in name rows
//   owner.iconsChanged()

const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;
const XApp = imports.gi.XApp;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const SignalManager = imports.misc.signalManager;
const { XAppStatusIcon, RecorderIcon } = require('./lib/xappStatusIcon');
const { appName, makeIconFromName, tooltipLines, sameName, menuLabel } = require('./lib/appInfo');

// Longer status texts are cut off in the pocket's status layout.
const STATUS_MAX_CHARS = 60;
// Names taken from a tooltip line are cut off after this many characters.
const NAME_MAX_CHARS = 40;

// After a click on a surfaced icon it goes back into the pocket, slightly
// delayed so the application can open its menu at the icon's position first.
const SURFACE_END_AFTER_CLICK_MS = 1000;

class XAppHost {
    constructor(owner) {
        this._owner = owner;
        this._signals = new SignalManager.SignalManager(null);
        this._monitor = null;
        this._recorder = null;
        // Every proxy the monitor reported, and the icons actually shown
        // (proxies claimed by a dedicated applet have no icon). Both keyed
        // by _key(proxy).
        this._proxies = new Map();
        this._icons = new Map();
        // key -> timeout id, for icons currently shown in the panel because
        // of activity although they belong into the pocket
        this._surfaced = new Map();
    }

    // --- Facade for XAppStatusIcon / RecorderIcon ----------------------
    get orientation() {
        return this._owner.orientation;
    }

    getPanelIconSize(type) {
        return this._owner.getPanelIconSize(type);
    }

    isVertical() {
        return this._owner.isVertical();
    }

    // --- Lifecycle -----------------------------------------------------
    start() {
        if (this._monitor) return;

        // Screen-recording indicator, part of the stock xapp-status applet
        this._recorder = new RecorderIcon(this);
        this._owner.panelBox.add_child(this._recorder.actor);

        this._monitor = new XApp.StatusIconMonitor();
        this._signals.connect(this._monitor, "icon-added", this._onProxyAdded, this);
        this._signals.connect(this._monitor, "icon-removed", this._onProxyRemoved, this);
        this._signals.connect(Gtk.IconTheme.get_default(), "changed", this.refresh, this);
        // An applet claimed or released a role (e.g. the network applet)
        this._signals.connect(Main.systrayManager, "changed", this.sync, this);
        // Like xapp-status: listen to the panel directly, the built-in
        // on_panel_icon_size_changed() only fires for one icon type.
        this._signals.connect(this._owner.panel, "icon-size-changed", this.refresh, this);
    }

    // Safe to call more than once.
    stop() {
        this._signals.disconnectAllSignals();
        this._clearSurfacing();
        for (const icon of this._icons.values()) {
            icon.destroy();
        }
        this._icons.clear();
        this._proxies.clear();
        if (this._recorder) {
            this._recorder.destroy();
            this._recorder = null;
        }
        this._monitor = null;
        this._owner.iconsChanged();
    }

    // Creates, removes and moves icons so they match the known proxies, the
    // systray roles and the hidden list.
    sync() {
        if (!this._monitor) return;

        for (const [key, proxy] of this._proxies) {
            let icon = this._icons.get(key);

            if (this._isClaimedByApplet(proxy)) {
                if (icon) {
                    global.log("PocketTray: XApp icon '" + icon.id + "' is handled by another applet");
                    this._icons.delete(key);
                    icon.destroy();
                }
                continue;
            }

            if (!icon) {
                icon = new XAppStatusIcon(this, proxy);
                this._icons.set(key, icon);
            }
            this._place(icon);
        }

        // Keep the recording indicator at the end of the panel box
        if (this._recorder) {
            this._owner.panelBox.set_child_at_index(this._recorder.actor, -1);
        }
        this._owner.iconsChanged();
    }

    // Icon theme, panel orientation or icon size changed.
    refresh() {
        for (const icon of this._icons.values()) {
            icon.refresh();
        }
        if (this._recorder) {
            this._recorder.refresh();
        }
    }

    // Icons must not react to clicks while the panel is being edited.
    setReactive(reactive) {
        for (const icon of this._icons.values()) {
            icon.actor.reactive = reactive;
        }
    }

    // Name of an icon in the pocket rows, the context menu and for sorting:
    // the launcher name, or the first tooltip line for unnamed
    // StatusNotifierItems (it usually is the application's name), else the id.
    displayName(icon) {
        return this._nameAndTooltip(icon).name;
    }

    // Name and status line for the pocket's name rows. The status line is
    // the tooltip without what only repeats the name, and only in the status
    // layout.
    statusTexts(icon) {
        const { name, lines } = this._nameAndTooltip(icon);
        const first = lines.length > 0 ? lines[0] : "";
        if (first && (sameName(first, name) || name.toLowerCase().includes(first.toLowerCase()))) {
            lines.shift();   // "Vorta" for Vorta
        } else if (first.toLowerCase().startsWith(name.toLowerCase())) {
            // "Mumble — 1.5.517" for Mumble: keep "1.5.517"
            const rest = first.slice(name.length).replace(/^[\s\-–—:·|]+/, "");
            if (rest) lines[0] = rest; else lines.shift();
        }
        let status = this._owner.showsStatusText() ? lines.join(" · ") : "";
        if (status.length > STATUS_MAX_CHARS) {
            status = status.slice(0, STATUS_MAX_CHARS - 1) + "…";
        }
        return { name, status };
    }

    // Pocket layout changed: show or hide the names and status texts.
    updateNameRows() {
        for (const icon of this._icons.values()) {
            icon.setNameVisible(this._owner.showsNames(icon.actor));
        }
    }

    statusSlotSize() {
        return this._owner.statusSlotSize();
    }

    // Entries for the context menu: [{ id, label, makeIcon }].
    menuEntries() {
        const entries = [];
        for (const icon of this._icons.values()) {
            if (!icon.id) continue;
            const iconName = icon.proxy ? icon.proxy.icon_name : null;
            entries.push({
                id: icon.id,
                label: menuLabel(this.displayName(icon), icon.id),
                makeIcon: (size) => makeIconFromName(iconName, [icon.id], size)
            });
        }
        return entries;
    }

    // --- Callbacks from XAppStatusIcon ---------------------------------
    // Name, process name or visibility changed.
    onIconChanged(icon) {
        if (this._icons.get(this._key(icon.proxy)) === icon) {
            this._place(icon);
            this._owner.iconsChanged();
        }
    }

    // A click is about to be forwarded to the application.
    onIconActivated(icon) {
        this._owner.pocket.closeIfContains(icon.actor);
        const key = this._key(icon.proxy);
        if (this._surfaced.has(key)) {
            this._surface(key, SURFACE_END_AFTER_CLICK_MS);
        }
    }

    // The icon got a new picture or label.
    onIconActivity(icon) {
        const key = this._key(icon.proxy);
        if (!this._owner.config.surfaceOnChange || this._icons.get(key) !== icon) return;
        if (!this._owner.hiddenList.has(icon.id)) return;   // already in the panel

        if (!this._surfaced.has(key)) {
            global.log("PocketTray: XApp icon '" + icon.id + "' changed, showing it in the panel");
        }
        this._surface(key, this._owner.config.surfaceDuration * 1000);
        this._place(icon);
        this._owner.iconsChanged();
    }

    // Ends all surfacing, e.g. when the setting was switched off.
    endSurfacing() {
        this._clearSurfacing();
        this.sync();
    }

    // --- Internals -----------------------------------------------------
    _key(proxy) {
        return proxy.get_name() + proxy.get_object_path();
    }

    _onProxyAdded(monitor, proxy) {
        this._proxies.set(this._key(proxy), proxy);
        this.sync();
    }

    _onProxyRemoved(monitor, proxy) {
        const key = this._key(proxy);
        this._proxies.delete(key);
        this._unsurface(key);
        const icon = this._icons.get(key);
        if (icon) {
            global.log("PocketTray: removing XApp icon '" + icon.id + "'");
            this._icons.delete(key);
            icon.destroy();
        }
        this._owner.iconsChanged();
    }

    // A dedicated applet (e.g. network, sound) shows this icon itself.
    _isClaimedByApplet(proxy) {
        return Main.systrayManager.getRoles().indexOf((proxy.name || "").toLowerCase()) !== -1;
    }

    // (Re)starts the time an icon stays surfaced in the panel.
    _surface(key, ms) {
        this._unsurface(key);
        const id = Mainloop.timeout_add(ms, () => {
            this._surfaced.delete(key);
            const icon = this._icons.get(key);
            if (icon) {
                this._place(icon);
                this._owner.iconsChanged();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._surfaced.set(key, id);
    }

    _unsurface(key) {
        const id = this._surfaced.get(key);
        if (id) {
            Mainloop.source_remove(id);
            this._surfaced.delete(key);
        }
    }

    _clearSurfacing() {
        for (const key of [...this._surfaced.keys()]) {
            this._unsurface(key);
        }
    }

    _place(icon) {
        const parent = icon.actor.get_parent();
        const toPocket = this._owner.placeIcon(icon.actor, icon.id, {
            name: this.displayName(icon),
            provisionalId: icon.idIsProvisional,
            surfaced: this._surfaced.has(this._key(icon.proxy))
        });
        if (icon.actor.get_parent() !== parent) {
            global.log("PocketTray: XApp icon '" + icon.id + "' -> " + (toPocket ? "pocket" : "panel"));
        }
        icon.setNameVisible(this._owner.showsNames(icon.actor));
    }

    // See displayName(). The tooltip lines are returned for statusTexts().
    _nameAndTooltip(icon) {
        const lines = tooltipLines(icon.proxy ? icon.proxy.tooltip_text : "");
        const first = lines.length > 0 ? lines[0] : "";
        let name = appName([icon.id]);
        if (!name && first && (icon.anonymous || sameName(first, icon.id))) {
            name = first.slice(0, NAME_MAX_CHARS);   // e.g. "Microsoft Teams"
        }
        return { name: name || icon.id, lines };
    }
}

module.exports = { XAppHost };
