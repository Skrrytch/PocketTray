// Translation helper shared by all PocketTray modules.
//
// Usage in a module:
//     const { _ } = require('./lib/i18n');
//     label.text = _("Show in panel:");
//
// Note: require() paths are always relative to the applet directory, also
// when the requiring file itself lives in lib/.
//
// The .po files live in po/. `cinnamon-xlet-makepot <applet dir>` collects
// every _("...") string from all modules into the .pot template.

const Gettext = imports.gettext;
const GLib = imports.gi.GLib;

const UUID = "PocketTray@spex";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

module.exports = { UUID, _ };
