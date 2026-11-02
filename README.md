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
