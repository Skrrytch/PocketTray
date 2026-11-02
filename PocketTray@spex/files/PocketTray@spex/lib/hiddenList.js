// Which tray icons live in the pocket.
//
// Settings used:
//   "hidden-apps"     the icons in the pocket
//   "known-apps"      every icon id seen so far (no widget, type "generic")
//   "hide-new-icons"  put icons that were never seen before into the pocket
//
// The settings widget is a one-column "list", so every entry is an object
// { name: "<id>" }. Ids are compared case-insensitively and without
// surrounding whitespace; normalizeId() is the single place that defines
// this, used for both the stored entries and the ids of tray icons.
//
// Who provides which id:
//   - legacy XEmbed icons: their role / WM_CLASS        (xembedHost.js)
//   - XApp status icons:   their name or process name   (xappStatusIcon.js)

function normalizeId(id) {
    return String(id || "").trim().toLowerCase();
}

class HiddenList {
    // settings:  the applet's AppletSettings
    // onChanged: called after every change of the list, whether it was made
    //            in the settings dialog or through setHidden()
    constructor(settings, onChanged) {
        this._onChanged = onChanged;
        this._entries = [];
        this._known = [];
        this.hideNew = false;
        // Each bound property reads the stored value; assigning saves it.
        settings.bindWithObject(this, "hidden-apps", "_entries", () => this._onChanged());
        settings.bindWithObject(this, "known-apps", "_known");
        settings.bindWithObject(this, "hide-new-icons", "hideNew");
    }

    // Called for every icon placed in panel or pocket. Remembers ids seen for
    // the first time; with "hide-new-icons" on, such an icon is put into the
    // pocket right away. Doesn't call onChanged: the caller places the icon
    // right after, and has(id) already reflects the change.
    noticeIcon(id) {
        const wanted = normalizeId(id);
        const known = this._known || [];
        if (!wanted || known.includes(wanted)) return;

        this._known = known.concat([wanted]);   // saves the setting
        if (this.hideNew && !this.has(wanted)) {
            global.log("PocketTray: new icon '" + wanted + "' goes into the pocket");
            this._entries = (this._entries || []).concat([{ name: wanted }]);
        }
    }

    // Whether the icon with this id belongs into the pocket.
    has(id) {
        const wanted = normalizeId(id);
        return (this._entries || []).some((entry) => entry && normalizeId(entry.name) === wanted);
    }

    // Moves an icon into the pocket (hidden = true) or back to the panel.
    setHidden(id, hidden) {
        const wanted = normalizeId(id);
        const list = (this._entries || []).filter((entry) => entry && normalizeId(entry.name) !== wanted);
        if (hidden) {
            list.push({ name: wanted });
        }
        this._entries = list;   // saves the setting
        this._onChanged();
    }
}

module.exports = { HiddenList, normalizeId };
