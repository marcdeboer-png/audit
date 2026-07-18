# Raw-/Rendered-Provenienz und CSR-Settling v1

## Problem und Ursache

Der vorherige Crawl-Renderer navigierte mit Playwright bis `networkidle` und extrahierte danach genau einen DOM-Zustand. Das Template-Sampling wartete bis `load` und extrahierte ebenfalls nur einmal. Beide Wege konnten eine Navigation als abgeschlossen behandeln, bevor verzögert hydrierter fachlicher Inhalt sichtbar wurde. `tech.js_dependent_content` verglich deshalb Raw-HTML mit einem zu fruehen Render-Snapshot und konnte faelschlich bestehen. Gleichzeitig wurden Raw-Head-Felder fuer Missing- und Duplicate-Checks verwendet, obwohl ein stabil gerenderter Head bereits vollstaendige Werte enthalten konnte.

## Datenmodell

Neue Runs speichern additiv:

- `rawDocumentStateJson`
- `initialRenderedStateJson`
- `settledRenderedStateJson`
- `effectiveDocumentStateJson`
- `renderProvenanceJson`
- `browserEventsJson`
- Settlingstatus, Dauer, Snapshot-Anzahl und finalen Fingerprint
- flache effektive Felder fuer Title, Description, Canonical, Sprache, Robots, H1, Wort-/Main-Content- und Linkzahlen sowie OG-, Twitter-, hreflang- und Schematypen

Jeder Zustand enthaelt Quelle, Beobachtungszeit, Snapshot-ID, Navigationsversuch und Normalisierungsversion. Text wird als Laenge, Wortzahl und Hash gespeichert, nicht als vollstaendiger fremder Seiteninhalt. Historische Runs ohne diese Spaltenwerte bleiben lesbar und werden nicht automatisch neu bewertet.

## Settling-Policy

`bounded-semantic-settling-v1` verwendet `domcontentloaded` als Navigationsevent und anschliessend eine begrenzte Snapshot-Schleife. Es gibt keine `networkidle`-Abhaengigkeit. Die Schleife endet bei einer konfigurierten Zahl gleicher semantischer Fingerprints, Maximaldauer, maximaler Snapshot-Zahl, Abbruch oder technischem Fehler.

Der Fingerprint normalisiert Metadaten, URLs, Robots, hreflang, Open Graph, Twitter, sichtbare H1, interne Linkziele, Schematypen, Main-Content-Praesenz und sichtbare Ladeindikatoren. Fuer sichtbaren Hauptinhalt werden dynamische UUIDs, Zeitstempel und Zahlen neutralisiert. Content-Readiness wird in die Baender `empty`, `thin`, `moderate` und `substantial` eingeteilt. Ein Zustand mit sichtbarem Ladeindikator gilt nicht als settled. Das verhindert, dass Live-Kurse allein endloses Settling ausloesen, ohne den Uebergang von leerem Shell-Inhalt zu substanzieller Ausgabe zu verlieren.

Die Provenienz speichert angefragte und finale URL, Navigations- und Settling-Zeitpunkte, initiale/finale Textlaenge und Wortzahl, initialen/finalen Fingerprint sowie die Zusatzereignisse `content_grew_after_initial_snapshot` und `metadata_changed_after_initial_snapshot`. Vollstaendige DOM-Snapshots werden nicht gespeichert.

Defaults:

| Feld | Wert |
|---|---:|
| maximale Settling-Dauer | 6.000 ms |
| Snapshot-Intervall | 500 ms |
| maximale Snapshots | 13 |
| erforderliche gleiche Folge-Snapshots | 3 |
| Mindestbeobachtung | 4.000 ms |
| gleichzeitig rendernde Seiten pro Run | 1 |

Rendering bleibt ueber `usePlaywright`, `playwrightMode` und Sample-Limits deaktivierbar. `maxConcurrentRenderedPages` begrenzt gleichzeitig rendernde Seiten pro Run explizit (Default 1, Maximum 4). Pausierte oder abgebrochene Runs brechen die Snapshot-Schleife fail-closed ab.

## Effective State und Checks

Ein stabiler `settled`- oder `content_remained_empty`-Snapshot ist der effektive gerenderte Zustand. Ohne ausgefuehrtes Rendering ist Raw-HTML effektiv. Wenn Rendering gestartet wurde, aber instabil, abgebrochen oder technisch fehlgeschlagen ist, bleibt Raw-HTML nachvollziehbar gespeichert; renderabhaengige Checks duerfen den Zustand jedoch nicht als vollstaendigen Pass verwenden.

Title-, Description-, Canonical-, `lang`-, H1-, Duplicate-, Open-Graph- und hreflang-Auswertungen verwenden in neuen Runs den effektiven Zustand. Raw-/Rendered-Deltas bleiben separate Rendering-Signale. `tech.js_dependent_content` benoetigt mindestens zwei stabile Drei-Zustands-Messungen und vergleicht Raw-, Initial- und Settled-Content. Console-Warnings, Console-Errors, Page-Errors, Request-Fehler, Service-Worker-, CSP-, 4xx-/5xx-Response- und Navigationsereignisse bleiben getrennt. Ein ueber zwei Seiten oder mehrfach im selben Sample reproduzierbarer `console.error` ohne belegte Inhaltsauswirkung bleibt Low; eine nicht reproduzierte Einzelmeldung ist scorefrei. Page-, Request-, 5xx- oder Service-Worker-Fehler koennen nur bei gleichzeitig nicht verfuegbarem Inhalt Medium werden. Navigation-/Runnerfehler sind technische Ausfuehrungsfehler und keine Website-Console-Findings.

Die globalen Severity-Gewichte, Confidence-Faktoren, Scope-Funktion, Low-Cap, Kategorie-Caps und Coverage-Schwellen wurden nicht geaendert.

## Realitaetscheck vom 19. Juli 2026

Der gezielte Kontrolllauf nutzte Concurrency 1 und keine Lighthouse-Messung. Temporaere Artefakte lagen ausschliesslich unter `/tmp/audit-csr-validation/`.

- `app.uniswap.org/explore/pools`: Raw-HTML hatte den generischen Title `Uniswap Interface`, keine Description, kein Canonical, keine Sprache und keinen sichtbaren Text. Der erste Render-Snapshot hatte bereits den fachlichen Title, Description, Canonical und `en-us`, aber erst 49 sichtbare Woerter. Drei aktuelle Browserwiederholungen stabilisierten nach 4,21 bis 5,23 Sekunden und 9 bis 11 Snapshots mit 520 bis 534 sichtbaren Woertern. Zwei erfolgreiche isolierte Zwei-URL-Diagnoselaeufe markierten `tech.js_dependent_content` identisch als Medium (Root Cause `rc_03a2619653346f1a`, Abzug 4,8389); Canonical, Description, Sprache und finale Titles bestanden, Console-Errors blieben Low. Der ausgegebene Diagnosescore 86 bei 100 % Coverage bezieht sich nur auf neun ausgewaehlte Checks und ist kein Vollsite-Score. Weitere Versuche trafen transiente Connect-/Navigationsfehler; sie wurden korrekt scorefrei als `technical_error` beziehungsweise `insufficient_evidence` behandelt und nicht umgangen. Metadaten, Findings und Root-Cause-IDs waren in erfolgreichen Laeufen stabil; ein Content-Fingerprint variierte wegen dynamischer Pool-Daten.
- `marcdeboer.de`: Raw-, Initial- und Settled-Metadaten waren auf der Startseite identisch; 651 Main-Content-Woerter waren bereits im Raw-HTML vorhanden. Die lokalisierte Extraktion erkennt auf dem geprueften Artikel nun den sichtbaren Autor, `Mai 2026` und einen semantisch lokalisierten Quellenlink. Die allgemeine Regel ist auf sichtbare `main`-/`article`-Bylines, Datumsbereiche und Quellen-/Referenzbloecke begrenzt; Footer-, Navigations-, Script- und JSON-LD-only-Signale bleiben ausgeschlossen.
- `web.dev/articles/optimize-cls`: Eine zweite reale Artikeldomain bestaetigte Autor, sichtbares Publikations-/Aktualisierungsdatum und einen fachlichen externen Quellenlink mit derselben lokalitaetsbasierten Extraktion.
- `react.dev`: Raw-HTML enthielt bereits vollstaendige Metadaten und substanziellen Hauptinhalt. Initialer und stabilisierter Snapshot waren semantisch gleich; es entstand keine zusaetzliche CSR-Abhaengigkeitswarnung. Der Browserlauf stabilisierte nach 4,48 Sekunden und neun Snapshots.

Eine synthetische unbekannte Uniswap-URL lieferte weiterhin HTTP 200 mit dem generischen App-Shell-Title und bestaetigte damit den bereits bekannten Soft-404 unabhaengig von der Renderkalibrierung. Die Soft-404-Severity wurde nicht geaendert.

## Grenzen

- Ein begrenzter Snapshot kann Inhalte verpassen, die erst nach dem konfigurierten Maximum erscheinen.
- Live-Listen koennen zwischen Laeufen unterschiedliche finale Text- und Linkmengen liefern; Metadaten und Readiness koennen trotzdem stabil sein.
- CSS, Shadow DOM und geschlossene Komponenten werden nur soweit bewertet, wie der Browser-Evaluator sichtbare Textknoten und computed visibility beobachten kann.
- Alte Runs enthalten keine nachtraeglich erfundene Raw-/Initial-/Settled-Provenienz.
- Geschlossene Shadow Roots, Inhalte nach Interaktion, Login-/Wallet-Zustaende, Personalisierung, A/B-Tests, Consent-/Geo-Varianten, WAF/Botabwehr und dauerhaft dynamische Anwendungen koennen weiterhin nicht vollstaendig rekonstruiert werden.
- Der aktuelle Fingerprint neutralisiert typische Zahlen-/Zeit-/UUID-Aenderungen, kann aber bei fachlich wechselnden Live-Listen weiterhin zwischen Laeufen variieren.
