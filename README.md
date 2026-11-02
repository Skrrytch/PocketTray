# PocketTray

Cinnamon applet: a system tray with a pocket for the tray icons you rarely
need. Handles legacy X11 icons as well as modern XApp/StatusNotifier icons.

The applet lives in [`PocketTray@spex/`](PocketTray@spex/) in the layout used
by [Cinnamon Spices](https://cinnamon-spices.linuxmint.com/); see its
[README](PocketTray@spex/README.md) for usage and settings.

## Development

```bash
git clone https://github.com/Skrrytch/PocketTray.git
ln -s "$PWD/PocketTray/PocketTray@spex/files/PocketTray@spex" \
      ~/.local/share/cinnamon/applets/PocketTray@spex
```

- Reload after code changes:
  `dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.ReloadXlet string:'PocketTray@spex' string:'APPLET'`
- Logs: Looking Glass (`Alt+F2`, `lg`) or `~/.xsession-errors`, lines start with `PocketTray:`
- Translations: `cinnamon-xlet-makepot PocketTray@spex/files/PocketTray@spex` updates the
  template, `cinnamon-xlet-makepot -i PocketTray@spex/files/PocketTray@spex` installs the
  `.po` files locally

### Code structure

All code is in `PocketTray@spex/files/PocketTray@spex/`:

| File | Responsibility |
|---|---|
| `applet.js` | Cinnamon lifecycle, settings, wiring of the modules below |
| `lib/xembedHost.js` | legacy X11 tray icons (`Main.statusIconDispatcher`) |
| `lib/xappHost.js` | XApp/StatusNotifier icons (`XApp.StatusIconMonitor`) |
| `lib/xappStatusIcon.js` | a single XApp icon and the screen-recording indicator |
| `lib/hiddenList.js` | which icon ids belong into the pocket |
| `lib/pocketButton.js` | the pocket button and its icon |
| `lib/pocket.js` | the popup holding the hidden icons, click and hover |
| `lib/iconMenu.js` | context menu with one switch per icon |
| `lib/rivalGuard.js` | steps back when another tray applet is enabled |
| `lib/i18n.js` | translations |

A host receives an icon, `applet.placeIcon()` puts it into the panel or the
pocket according to the hidden list, `applet.iconsChanged()` shows or hides
the pocket button. Each file starts with a comment describing its role and
the interface it expects from its owner.

Modules in `lib/` are loaded with Cinnamon's `require()`; paths are relative
to the applet directory, also inside `lib/`, and each module lists its exports
in `module.exports`. The classic per-applet importer
(`imports.ui.appletManager.applets[uuid]`) is avoided on purpose: GJS keeps its
modules until Cinnamon restarts, so after an update the new `applet.js` would
run with the old modules. `require()` notices changed files (it caches by file
size, so an edit that keeps the size unchanged needs a Cinnamon restart).
`require()` is deprecated as of Cinnamon 6.8; switch to its replacement once
that version can be tested.
