# Changelog

Versionen beschreiben das Applet, wie es im Spices-Verzeichnis erscheint.
Die Beschreibung von 0.1.0 ist die README der Spices-PR; 0.2.0 ist der
Nachtrag, der bei der nächsten Einreichung dazukommt.

## 0.2.0 (noch nicht veröffentlicht)

### Neu
- **Darstellung der Tasche** mit drei Stufen:
  - *Nur Icons* (wie bisher)
  - *Icons und Anwendungsname*: eine Zeile pro Icon mit dem Namen
  - *Icons mit Statustext (inkl. Anwendungsname)*: Name, danach der
    aktuelle Tooltip des Programms in derselben Zeile, live aktualisiert

  Die Namen stehen in einer Spalte, unabhängig von Größe und Art der Icons.
  Ein Klick auf den Namen wirkt wie ein Klick auf das Icon.
- **Reihenfolge der Tasche**: wie die Icons erscheinen (wie bisher),
  alphabetisch oder in der Reihenfolge der Liste versteckter Icons.
- **Lesbare Namen**: Zu einem Icon wird der passende Programmstarter auch
  dann gefunden, wenn sein Name nicht exakt übereinstimmt (zum Beispiel
  „Mumble“ für `mumble`). Das Kontextmenü zeigt diese Namen, mit der
  technischen Kennung in Klammern, wenn sie abweicht.
- **Tastenkürzel** zum Öffnen und Schließen der Tasche. Standard: keins.
- **Neue Icons automatisch in die Tasche**: Icons von Programmen, die
  PocketTray noch nicht kennt, landen direkt in der Tasche. Bekannte Icons
  behalten ihren Platz. Standard: aus. Auch im Kontextmenü einstellbar.
- **Geänderte Icons kurz in der Leiste zeigen** (optional, Standard: aus):
  ändert ein Icon in der Tasche sein Bild oder Label, erscheint es für eine
  einstellbare Zeit in der Leiste. Ein Klick legt es zurück. Die
  Ausblendliste bleibt unverändert.
- **Einstellungen in drei Reitern**: Tasche, Taschen-Button, Icons. Die
  Verzögerungen erscheinen nur, wenn die Tasche per Überfahren öffnet.

### Intern
- Übersetzung (Deutsch) für alle neuen Texte.

## 0.1.0 (Erstveröffentlichung)

PocketTray ersetzt die beiden Tray-Applets *System Tray* und *XApp Status
Applet* durch ein Applet.

### Funktionen
- **Legacy-Icons (X11/XEmbed)** und **moderne Status-Icons** (XApp und
  StatusNotifier, zum Beispiel Electron-, Qt- und KDE-Programme) werden
  gemeinsam verwaltet, einschließlich des Bildschirmaufnahme-Hinweises.
- **Tasche mit Icons**: Icons, die in der Ausblendliste stehen, wandern in
  die Tasche. Die Tasche öffnet sich per Klick oder per Überfahren mit der
  Maus.
- **Verzögerungen** für das Öffnen (Überfahren) und das Schließen.
- **Kontextmenü**: pro Icon ein Schalter, „an“ heißt Leiste, „aus“ heißt
  Tasche.
- **Position des Taschen-Buttons** links oder rechts der Icons; auf
  senkrechten Leisten oberhalb bzw. unterhalb.
- **Icon des Taschen-Buttons** wählbar: drei Dreiecke (Standard), Dreiecke
  auf dem Kopf, vier Kreise, Raster, drei Punkte, Tasche, Schublade, Pfeile
  oder ein eigenes Icon.
- **Schutz vor doppelten Tray-Applets**: Ist *System Tray* oder *XApp Status
  Applet* noch auf der Leiste, entfernt sich PocketTray und zeigt einen Hinweis.
- Übersetzung: Deutsch.
