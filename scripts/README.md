# Precompute-Skript — Einrichtung (einmalig, ca. 10 Minuten)

Dieses Skript rechnet Team Stats + Lineup Details für alle 32 Teams einmal
zentral (über GitHub Actions, nicht im Browser) und schreibt das Ergebnis in
denselben Firestore-Cache, den `team.html`/`league.html` schon lesen. Besucher
müssen dann nie mehr selbst rechnen — auch nicht der allererste am Tag.

## Schritt 1 — Dateien ins Repo legen

Diese beiden Ordner unverändert in euer bestehendes GitHub-Repo kopieren
(gleiche Ordnerstruktur beibehalten):

```
scripts/precompute.js
scripts/package.json
.github/workflows/precompute.yml
```

## Schritt 2 — Firebase Service-Account-Schlüssel erzeugen

1. [Firebase Console](https://console.firebase.google.com) öffnen → Projekt
   `mim-idp-rankings` auswählen
2. Oben links auf das Zahnrad → **Projekteinstellungen**
3. Tab **"Dienstkonten"** ("Service accounts")
4. Button **"Neuen privaten Schlüssel generieren"** klicken → bestätigen
5. Es lädt eine `.json`-Datei herunter — **diese Datei ist ein Passwort,
   niemals öffentlich teilen oder ins Repo committen!**

## Schritt 3 — Schlüssel als GitHub Secret hinterlegen

1. Im GitHub-Repo → **Settings** → **Secrets and variables** → **Actions**
2. **"New repository secret"**
3. Name: `FIREBASE_SERVICE_ACCOUNT`
4. Wert: die komplette heruntergeladene `.json`-Datei öffnen, **gesamten
   Inhalt** (von `{` bis `}`) kopieren und hier einfügen
5. Speichern

## Schritt 4 — Testen

1. Im GitHub-Repo auf den Tab **"Actions"** gehen
2. Links auf **"Precompute Team Stats & Lineup Details"** klicken
3. Rechts **"Run workflow"** klicken → Jahr-Feld leer lassen (= aktuelle
   Saison) → **"Run workflow"** bestätigen
4. Nach ein paar Sekunden erscheint ein neuer Lauf in der Liste — draufklicken,
   um die Live-Ausgabe zu sehen (dauert je nach Saison-Fortschritt einige
   Minuten, besonders der Lineup-Details-Teil)
5. Bei Erfolg steht am Ende `═══ Fertig ═══` — dann in der Firebase Console
   unter **Firestore Database** → Sammlung `shared_cache` nachschauen, ob
   `teamstats_2026` bzw. `lineup_2026` (oder das jeweilige Jahr) neu befüllt
   wurden

## Danach: automatisch, ohne euer Zutun

Der Zeitplan (`cron: '0 6 * * *'`) lässt das Skript ab jetzt **jeden Tag um
6:00 Uhr UTC** automatisch laufen — ihr müsst nichts mehr manuell anstoßen.
Zeitpunkt lässt sich in `.github/workflows/precompute.yml` anpassen.

## Kosten

**Kostenlos** für eure Größenordnung — GitHub Actions bietet 2.000
Gratis-Minuten/Monat bei privaten Repos (unbegrenzt bei öffentlichen), ein
täglicher Lauf verbraucht davon nur einen kleinen Teil.

## Historische Jahre nachrechnen (optional, einmalig)

Um z.B. auch 2022–2025 einmalig zu befüllen: im "Run workflow"-Dialog das
Jahr-Feld mit der jeweiligen Zahl ausfüllen (z.B. `2023`) und einzeln
ausführen — für jedes gewünschte Jahr einmal.

## Was NICHT abgedeckt ist

Team Roster (pro Team, mit Sleeper-Weekly-Stats für jeden einzelnen Spieler)
ist bewusst nicht Teil dieses Skripts — das wären deutlich mehr Einzel-Abrufe
pro Team. Kann bei Bedarf separat ergänzt werden, sobald sich das hier bewährt
hat.
