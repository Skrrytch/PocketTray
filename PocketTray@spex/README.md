# PocketTray

Tray-Applet mit ausklappbarer „Tasche“ (Overflow) für Icons auf einer Ausblendliste.
Basis: `systray@cinnamon.org` (Cinnamon 6.6.9, lokal in `/usr/share/cinnamon/applets/`).

## 1. Setup

```bash
# a) Fork auf GitHub: linuxmint/cinnamon-spices-applets -> "Fork" (oben rechts)
# b) Klonen (--depth 1 spart viel Zeit, das Repo ist groß)
mkdir -p ~/projects && cd ~/projects
git clone --depth 1 git@github.com:<DEIN-USER>/cinnamon-spices-applets.git
cd cinnamon-spices-applets
git remote add upstream https://github.com/linuxmint/cinnamon-spices-applets.git
git checkout -b pockettray

# c) Applet in die Spices-Struktur kopieren (Layout: <UUID>/files/<UUID>/…)
cp -r ~/projects/lab/PocketTray/PocketTray@spex .

# d) Symlink: Cinnamon lädt direkt aus dem Fork
ln -s ~/projects/cinnamon-spices-applets/PocketTray@spex/files/PocketTray@spex \
      ~/.local/share/cinnamon/applets/PocketTray@spex

# e) Testen
#  - Systemeinstellungen > Applets > "PocketTray" zur Leiste hinzufügen
#  - das normale "System Tray" entfernen (beide beanspruchen die Rolle "tray")
#  - Code-Änderung laden: Alt+F2 -> r (Cinnamon-Neustart); Fehler: Alt+F2 -> lg -> Log
#  - Fork aktuell halten: git fetch upstream && git rebase upstream/master
```

Hinweis: `systray@cinnamon.org` liegt **nicht** im Spices-Repo, sondern im Hauptrepo
`linuxmint/cinnamon` (bzw. lokal unter `/usr/share/cinnamon/applets/`). Das Spices-Repo
ist nur das Zielformat/-ablage für das neue Applet. Es reicht auch, direkt aus diesem
Ordner zu symlinken, solange du noch nichts einreichen willst.

## 2. Architektur-Plan

**Wichtig:** `systray@cinnamon.org` zeigt nur XEmbed-Icons (alte X11-Icons). SNI/XApp-Icons
kommen von `xapp-status@cinnamon.org` (657 Zeilen, eigene Logik). Daher zwei Etappen.

| Datei | Änderung gegenüber Original |
|---|---|
| `metadata.json` | Neue UUID `PocketTray@spex`, `role: "tray"` bleibt, `max-instances: 1`, Version. |
| `settings-schema.json` (neu) | `hidden-apps` (Liste, Spalte `name`), `open-trigger` (click/hover), `hover-delay`, `close-delay`. |
| `applet.js` | Konstruktor: `AppletSettings`, zweite Box + Toggle-Button + `AppletPopupMenu` als Tasche. `_onTrayIconAdded`: per `_isHidden(role)` in `pocket_box` oder `button_box` einfügen. `_clearIcons`/`_onTrayIconRemoved`: beide Container. Settings-Änderung → `statusIconDispatcher.redisplay()` sortiert alles neu. |

Zuordnung: Vergleich des `role`-Strings (WM_CLASS, case-insensitive, exakter Treffer) mit
der Liste. Die Namen findest du im Log (`PocketTray: icon role '…'`).

**Etappe 2 (SNI):** `xapp-status@cinnamon.org` ebenso forken, dessen Icon-Container
(`XAppStatusIcon`, geschlüsselt über `proxy.name`/Icon-Namen) auf dieselbe `pocket_box`
routen. Zwei Applets können keine gemeinsame Tasche teilen, daher entweder (a) PocketTray
vereint beide Quellen in einem Applet (empfohlen, größerer Umbau) oder (b) zwei Applets
mit je einer Tasche. Außerdem prüfen: `collapsible-systray@feuerfuchs.eu` ist bei dir schon
installiert und löst Teile davon (Einklappen), allerdings ohne Ausblendliste.

## 3. Stand Meilenstein 1

Dateien liegen in `files/PocketTray@spex/`: `metadata.json`, `settings-schema.json`,
`applet.js` (JSON und JS-Syntax geprüft, **noch nicht in Cinnamon gestartet**).

Ungetestete Risiken: Icons in einem ausgeblendeten Popup (XEmbed-Fenster werden beim
Schließen ggf. unmapped), Modal-Grab beim Klick auf Icons im Popup, Hover-Verhalten.
