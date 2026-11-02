// Everything about recognising the application behind a tray icon: its
// launcher (.desktop) entry, icons for the context menu, a display name and
// the status text of its tooltip.
//
// Tray icons only carry technical ids (WM_CLASS, StatusIcon name, process
// name); the launcher entry turns these into the name and icon the user
// knows from the menu.

const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Cinnamon = imports.gi.Cinnamon;

const DEFAULT_ICON_SIZE = 16;

// Shortest name searched for in all launchers; shorter ones match too much.
const MIN_SEARCH_LENGTH = 3;
// Only the best-ranked groups of search results are considered.
const SEARCH_GROUPS = 2;

// Lower case, letters and digits only: "Proton Mail Bridge",
// "protonmail-bridge" and "protonmail_bridge" all become "protonmailbridge".
function plainName(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Whether two names mean the same, e.g. "Vorta" and "vorta", "OTP Scout"
// and "otp-scout".
function sameName(a, b) {
    return plainName(a) === plainName(b);
}

// Launcher entry of the first application matching one of the candidate
// names (WM_CLASS, id), or null. Exact lookups come first; then a search
// through all launchers, e.g. "mumble" -> info.mumble.Mumble.desktop. A
// search hit only counts if its file or application name contains the
// candidate, so "process-monitor" doesn't end at an unrelated system monitor.
function findApp(candidates) {
    const appSys = Cinnamon.AppSystem.get_default();
    const names = candidates.filter((name) => !!name);
    for (const name of names) {
        const app = appSys.lookup_desktop_wmclass(name) || appSys.lookup_app(name.toLowerCase() + ".desktop");
        if (app) return app;
    }
    for (const name of names) {
        const app = _searchApp(appSys, name);
        if (app) return app;
    }
    return null;
}

function _searchApp(appSys, name) {
    const wanted = plainName(name);
    if (wanted.length < MIN_SEARCH_LENGTH) return null;

    for (const group of Gio.DesktopAppInfo.search(name).slice(0, SEARCH_GROUPS)) {
        for (const desktopId of group) {
            const app = appSys.lookup_app(desktopId);
            if (!app) continue;
            const fileName = plainName(desktopId.replace(/\.desktop$/, ""));
            if (fileName.includes(wanted) || plainName(app.get_name()).includes(wanted)) {
                return app;
            }
        }
    }
    return null;
}

// Name of the application as shown in the menu (e.g. "Vorta"), or null.
function appName(candidates) {
    const app = findApp(candidates);
    return app ? app.get_name() : null;
}

// Launcher icon of the matching application, or a generic placeholder.
function makeAppIcon(candidates, size = DEFAULT_ICON_SIZE) {
    const app = findApp(candidates);
    if (app) return app.create_icon_texture(size);
    return new St.Icon({
        icon_name: "application-x-executable-symbolic",
        icon_type: St.IconType.SYMBOLIC,
        icon_size: size
    });
}

// Icon from what an application reports: a theme icon name or an image
// path. Falls back to makeAppIcon(fallbackCandidates).
function makeIconFromName(iconName, fallbackCandidates, size = DEFAULT_ICON_SIZE) {
    if (iconName && iconName.trim()) {
        if (iconName.includes("/")) {
            return new St.Icon({
                gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(iconName) }),
                icon_size: size
            });
        }
        return new St.Icon({
            icon_name: iconName,
            icon_type: iconName.includes("symbolic") ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR,
            icon_size: size
        });
    }
    return makeAppIcon(fallbackCandidates, size);
}

// Tooltip as plain text lines: markup removed, empty lines dropped.
// Some applications send a literal "\n" instead of a line break.
function tooltipLines(tooltip) {
    return (tooltip || "")
        .replace(/<[^>]*>/g, "")
        .split(/\n|\\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

// Label for the context menu: the display name, followed by the id when
// it differs, because the hidden-icons list in the settings uses ids.
function menuLabel(name, id) {
    return sameName(name, id) ? name : name + "  (" + id + ")";
}

module.exports = {
    findApp, appName, makeAppIcon, makeIconFromName, tooltipLines,
    plainName, sameName, menuLabel
};
