# Render runtime metrics and deterministic budgets

> Historischer Stand von `deterministic-render-gate-v1`. Die aktuelle
> Praezisierung von `render_recommended` ist in
> [render-gate-calibration-v2.md](render-gate-calibration-v2.md) dokumentiert;
> die hier beschriebenen Runtime-Metriken, Budgets und Settling-Parameter
> bleiben weiterhin gueltig.

## Ausgangszustand

Vor diesem Batch wurde Browser-Rendering waehrend des Crawls pro URL, nicht pro Check, ausgefuehrt. Alle spaeteren Checks nutzten denselben persistierten gerenderten Dokumentzustand. `all` renderte jede geeignete HTML-Seite; `sample` reservierte bis zu einem URL-Limit in Verarbeitungsreihenfolge; `off` blieb raw-only. Ein Run teilte sich einen Browser, oeffnete pro URL eine Page und schloss Page und Browser in `finally`-Pfaden.

Template-Sampling startete jedoch einen zweiten Browser und konnte eine bereits waehrend des Crawls gerenderte URL nochmals messen. Diese Doppelarbeit wird jetzt vermieden, wenn fuer die URL bereits ein stabiler, vollstaendiger Renderzustand vorliegt. URL-spezifische Werte werden nicht auf andere URLs uebertragen.

Nicht instrumentiert waren insbesondere Prozessspeicher, CPU, Browserstarts, Browserfehler, Navigations- und Settlingkosten, Persistenzkosten sowie die zusaetzliche Groesse der Renderprovenienz.

## Metrikmodi

- `off`: schreibt keine Runtime-Metriken.
- `basic` (Standard): misst Phasendauern, URL-Dauern, Zaehler, Byte-Groessen und Prozesswerte an sinnvollen Grenzen. Es gibt kein hochfrequentes Sampling.
- `profiling`: ergaenzt waehrend des Laufs ein 250-ms-Sampling von Node-RSS und Heap. Dieser Modus muss explizit aktiviert werden.

Browserprozess-RSS und Browser-Kindprozesszahl sind plattformuebergreifend ueber die verwendete Playwright-Schnittstelle nicht hinreichend verlaesslich verfuegbar. Diese Felder bleiben deshalb `null`. Sie werden weder aus Node-RSS geschaetzt noch als Nullwert erfunden.

Die Laufmetriken stehen in `run_runtime_metrics`, URL-Metriken in `url_runtime_metrics`. Alte Runs ohne diese Zeilen bleiben lesbar. HTML-Report, Voll-JSON, ZIP-Arbeitsdaten, Check-Detailansicht und `render-runtime`-CSV stellen die neuen Daten additiv bereit.

## Renderstrategien

- `off`: Raw-only-Baseline.
- `all`: Browser fuer jede geeignete HTML-Seite.
- `sample`: bestehende begrenzte Crawl-Stichprobe.
- `gate`: zweistufiger deterministischer Renderplan. Zuerst werden Raw-HTML und minimale Extraktionsfakten erhoben, danach werden Template-Cluster gebaut und Renderkandidaten global priorisiert.

Die Standardstrategie bleibt in diesem Batch `off`. Das Gate wird erst nach dem realen Benchmark als moeglicher Standard bewertet.

## Deterministische Entscheidung

Das Gate kennt `render_required`, `render_recommended`, `render_not_required`, `render_unavailable` und `render_budget_exhausted`.

Belastbare Required-Signale sind ein Raw-App-Shell-Zustand, fehlender relevanter Hauptinhalt oder die Kombination aus sehr wenig sichtbarem Raw-Inhalt und fehlender H1 auf einem inhaltlich relevanten Seitentyp. Fehlende gerendert-sensitive Metadaten oder ungewoehnlich wenige interne Links fuehren konservativ zu `render_recommended`. Vollstaendiger Hauptinhalt, H1 und Kernmetadaten koennen `render_not_required` belegen. Eine absichtlich kurze, aber vollstaendige Utility- oder Rechtsseite wird nicht allein wegen ihrer Wortzahl gerendert.

Frameworkname, Domain, eine einzelne Scriptdatei oder ein hoher Scriptanteil reichen nie allein als Trigger. Eine vollstaendig serverseitig gerenderte React-Seite kann deshalb `render_not_required` sein. Bei Unsicherheit bleibt die Entscheidung `render_recommended`; fehlendes Browserbudget erzeugt keine implizite Pass-Bewertung.

Die Entscheidung wird vor rendered-abhaengigen Checks getroffen. Gespeichert werden Signale, Confidence, fehlende Voraussetzungen, angeforderte Check-Familien, Budgetstatus und Browserergebnis.

## Budgets und Priorisierung

Optional konfigurierbar sind:

- `maxRenderedUrls`
- `maxTotalRenderTimeMs`
- `maxSettlingTimeMsPerUrl`
- `maxBrowserFailures`
- `maxPersistedRenderBytes`

Bei Budgetende bleibt der Run verwendbar. Renderabhaengige Evidenz wird unvollstaendig; Checks duerfen daraus keinen Pass ableiten. Die Priorisierung ist stabil gegen URL-Reihenfolge: zwingender Bedarf vor empfohlenem Bedarf, erste und zweite Template-Bestaetigungs-URL vor weiteren Vorkommen, danach Signalstaerke und kanonische URL-Sortierung.

Template-Fingerprints werden aktuell nur fuer Schichtung und Priorisierung verwendet. Das Tool uebertraegt keine Metadaten, H1, Canonicals, Robots-Werte, Inhalte, Statuscodes oder Findings zwischen URLs. Eine aggressive Produktions-Wiederverwendung wird erst vertretbar, wenn mehrere reale URLs je Template die Stabilitaet belegen.

Browser-Concurrency bleibt auf eins begrenzt. Der neue Code fuehrt keine Renderfarm oder Browserparallelitaet ein.

## Settling

Die bestehende Policy bleibt bis zum Abschluss des Realbenchmarks unveraendert:

- maximal 6.000 ms;
- 500-ms-Intervall;
- drei gleiche semantische Folge-Snapshots;
- mindestens 4.000 ms Beobachtung;
- maximal ein Browserlauf gleichzeitig.

Der Metrik-Summary enthaelt Mittelwert, Median, P75, P90, P95, Maximum, Snapshot-Verteilungen, Timeout-/Instabilitaetszaehler und Aenderungen nach 1 bis 6 Sekunden, getrennt nach Seitentyp, Entscheidung und Settlingstatus.

## Benchmarkmodus

Der explizite Benchmarkbefehl erzeugt ausschliesslich temporaere Datenbanken und Ergebnisse unter `/tmp`:

```bash
npm run benchmark:render -- --config /tmp/benchmark-config.json
```

Die Konfiguration muss jede externe Domain und URL explizit nennen. Der Befehl fragt keine nicht konfigurierten Websites an, nutzt Concurrency 1, startet hoechstens 0,5 Seiten pro Sekunde, speichert keine vollstaendigen DOMs, HAR-Dateien oder Screenshots und verwendet keine produktive Datenbank. Er optimiert keine Parameter automatisch auf einen Zielscore.

Der reale Kalibrierungssatz dieses Batches umfasst sechs Archetypen mit 37 eindeutigen URLs: kleine statische Expertenwebsite (`marcdeboer.de`), CSR-App-Shell (`app.uniswap.org`), hydratisierte Dokumentation (`react.dev`), redaktionelle Dokumentation (`web.dev`), serverseitiger E-Commerce (`ikea.com`) und grosse Wissensdokumentation (MDN). Drei Domains werden dreimal je Strategie wiederholt. Fremde Seiteninhalte und Benchmarkdaten bleiben unter `/tmp`.

## Kostenmodell

`estimateRenderCost` verwendet URL-Anzahl, erwarteten Renderanteil, Raw-Fetch-Zeit, Browserstart, P50/P90 der Renderdauer, Persistenzbytes und Concurrency. Es gibt Bandbreiten statt scheinexakter Werte aus. Ab 1.000 URLs warnt es explizit vor der Concurrency-1-Grenze.

Der HTML-Report und der JSON-Summary rechnen aus den Fakten eines instrumentierten Runs Projektionen fuer 10, 100, 1.000 und 10.000 URLs. Ein Run ohne Browsermessung kann daraus keine belastbare Renderdauer ableiten; die Werte bleiben dann eine Raw-only-Projektion.

## Realbenchmark vom 19. Juli 2026

Der Kernbenchmark nutzte 30 explizit konfigurierte URLs (je fuenf pro Domain), eine separate SQLite-Datenbank pro Lauf, Concurrency 1 und hoechstens 0,5 Requeststarts pro Sekunde. Eine gezielte Schichtergaenzung fuegte zwei weitere statische Artikel, zwei weitere serverseitige Produktseiten, zwei weitere serverseitige Kategorien und eine weitere Rechtsseite hinzu. Damit wurden 37 eindeutige URLs in 42 Runs beziehungsweise 201 URL-Strategie-Messungen verarbeitet. Statische Artikel, serverseitige Produkte/Kategorien und Rechtsseiten sind jeweils mindestens dreifach vertreten. Verglichen wurden Raw-only, Browser fuer alle HTML-Seiten und das deterministische Gate. `marcdeboer.de`, `app.uniswap.org` und `react.dev` wurden je Strategie dreimal wiederholt. Ein einzelner Raw-only-Fetch von `/fakten/` schlug im ersten Lauf fehl; die beiden Wiederholungen waren erfolgreich. Eine Zugriffssperre wurde nicht umgangen.

| Domain / Archetyp | Raw Score / Coverage | Browser-all Score / Coverage | Gate Score / Coverage | Browser all | Gate |
| --- | ---: | ---: | ---: | ---: | ---: |
| marcdeboer.de / statisch | 79 / 79,0 %* | 75 / 82,2 % | 79 / 79,0 % | 5 | 0 |
| app.uniswap.org / CSR-App | 47 / 80,8 % | 41 / 83,3 % | 41 / 83,3 % | 5 | 5 |
| react.dev / hydratisierte Doku | 65 / 79,2 % | 65 / 81,5 % | 65 / 81,5 % | 5 | 4 |
| web.dev / redaktionelle Doku | 62 / 77,8 % | 43 / 81,9 % | 43 / 81,9 % | 5 | 5 |
| ikea.com / serverseitiger E-Commerce | 75 / 77,5 % | 74 / 80,2 % | 75 / 77,5 % | 5 | 0 |
| developer.mozilla.org / Wissensdoku | 73 / 78,2 % | 67 / 81,7 % | 72 / 80,6 % | 5 | 2 |

\*Der erste Raw-Lauf lag wegen des einzelnen Netzwerkfehlers bei 80 / 78,1 %. Angegeben ist der stabile Wert der zwei erfolgreichen Wiederholungen. Score-Differenzen sind keine Optimierungsziele: Browserlaeufe erschliessen weitere Evidenz und Ressourcen und koennen deshalb sowohl Coverage als auch Findings veraendern. Globale Scoringparameter und Check-Severities blieben unveraendert.

Ueber die ersten vollstaendigen Vergleichslaeufe aller sechs Domains ergab sich:

| Strategie | Wall time | Renderzeit | Browserlaeufe | Renderprovenienz | DB-Zuwachs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw-only | 58,2 s | 0 s | 0 | 0 B | 5,91 MB |
| Browser-all | 162,1 s | 151,2 s | 30 | 1,95 MB | 9,57 MB |
| Gate | 129,5 s | 79,3 s | 16 | 0,64 MB | 7,77 MB |

Das Gate vermied im 30-URL-Kernvergleich 14 Browserlaeufe (46,7 %), reduzierte die Wall time gegenueber Browser-all um 32,6 s (20,1 %), die Renderprovenienzmenge um 67,4 % und den Datenbankzuwachs um 18,8 %. Die sieben ergaenzten statischen/SSR-Schichtseiten wurden vom Gate ebenfalls alle korrekt uebersprungen; ueber 37 eindeutige URLs wurden damit 21 von 37 Browserlaeufen vermieden (56,8 %). Bei Uniswap und web.dev war die vorgeschaltete Raw-Phase teurer als Browser-all, weil fast alle Seiten anschliessend trotzdem gerendert werden mussten. Das ist eine reale Grenze des zweistufigen Verfahrens.

### Settling und Ressourcen

Alle 30 Browser-all-Seiten erreichten `settled`; es gab weder Timeout noch `rendering_unstable`. Die Settling-Verteilung lag bei Mittel 4.329 ms, Median 4.258 ms, P75 4.457 ms, P90 4.570 ms, P95 4.713 ms und Maximum 4.969 ms. Der Median waren neun Snapshots, das Maximum zehn. Zehn Seiten aenderten ihren semantischen Fingerprint noch nach einer Sekunde, vier noch nach zwei und drei Sekunden, keine nach vier Sekunden. Nur zwei Seiten blieben ueber alle Snapshots semantisch identisch.

Die Renderprovenienz lag pro gerenderter Seite bei durchschnittlich 65.056 B, Median 37.501 B, P90 86.038 B und Maximum 538.841 B. Der grosse Ausreisser zeigt, dass eine spaetere Provenienzkompaktierung untersucht werden sollte; in diesem Batch wurden keine Genauigkeitsdaten entfernt.

Node-RSS und Heap wurden gemessen, isolieren den separat laufenden Browserprozess aber nicht. In den Browser-all-Laeufen lagen die beobachteten Node-RSS-Peaks zwischen 354 MB und 1,03 GB, Heap-Peaks zwischen 118 MB und 748 MB. Da alle Benchmarklaeufe in einem langlebigen Node-Prozess liefen und grosse Raw-Seiten ebenfalls Speicher beanspruchen, duerfen diese Peaks nicht als reine Browserkosten interpretiert werden. Browser-RSS und Browser-Kindprozesszahl blieben mangels portabler Messung `null`.

### Mess-Overhead

Ein lokaler, rotierend angeordneter Kontrollbenchmark mit 50 Raw-URLs und sechs Wiederholungen pro Modus ergab Median 498,4 ms (`off`), 521,8 ms (`basic`) und 519,1 ms (`profiling`). Der Basic-Aufschlag betrug damit rund 23,4 ms pro Run beziehungsweise 0,47 ms pro URL; auf dem kuenstlich sehr schnellen Fixture sind das 4,7 %. Basic und Profiling lagen innerhalb der Laufstreuung. Die Metriktabellen benoetigten gegenueber `off` rund 28,7 KB beziehungsweise 573 B pro URL. RSS-Differenzen waren wegen Garbage Collection und eines Ausreissers nicht belastbar genug fuer eine eigene Budgetregel.

### Manuelle Render-Wahrheit

Als notwendig galt ein Browserlauf, wenn Raw-HTML keinen semantisch nutzbaren Hauptinhalt oder erforderliche Metadaten lieferte und der stabilisierte Zustand diese Evidenz ergaenzte. Nach unabhaengiger GET-/HTML-/Browserpruefung waren sieben der 37 Seiten notwendige Renderfaelle: die fuenf leeren Uniswap-App-Shells sowie die spaet nachgeladenen web.dev-Seiten `/blog/` und `/discover/`. Das Gate renderte alle sieben und keine notwendige Seite wurde verpasst.

Damit lagen fuer das Gate `render_precision` bei 7/16 = 43,8 %, `render_recall` bei 7/7 = 100 %, `unnecessary_render_rate` bei 9/16 = 56,3 % und `missed_render_rate` bei 0/7 = 0 %. Browser-all hatte bei gleicher Wahrheit 30 unnoetige Renderlaeufe (81,1 %). Raw-only verpasste alle sieben Renderfaelle. Diese Klassifikation bewertet Renderbedarf, nicht die fachliche Richtigkeit jedes SEO-Findings.

Statische React-/SSR-Seiten lieferten vollstaendigen Raw-Hauptinhalt und benoetigten nicht allein wegen Hydration einen Browser. Browser-only Wortzahldifferenzen bei marcdeboer.de und MDN betrafen widerspruechliche Hidden-/Navigationsbereiche, nicht fehlenden kritischen Hauptinhalt. Sie gelten nicht als Beleg fuer einen notwendigen Browserlauf. Uniswap zeigte bei einer spaeteren Kontrollsession wechselndes Clientverhalten; innerhalb der drei Benchmarkwiederholungen waren Renderentscheidungen, Scores, Coverage und Root-Cause-IDs stabil.

### Kostenprognose aus dem Benchmark

Die folgende Modellrechnung nutzt den beobachteten Gate-Renderanteil von 53,3 %, Raw-Fetch-P50 74,5 ms, Browserstart-P50 86,5 ms, Navigation-plus-Settling P50 4.726 ms / P90 5.629 ms, durchschnittlich 65.056 B Persistenz pro Render und Concurrency 1. Die Harness-Drosselung ist nicht in der Raw-Fetch-Zeit enthalten.

| URLs | erwartete Browserlaeufe | Gesamtdauer P50 | Gesamtdauer P90 | zusaetzliche Renderdaten |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 6 | 29,2 s | 34,6 s | 0,39 MB |
| 100 | 54 | 4,38 min | 5,19 min | 3,51 MB |
| 1.000 | 534 | 43,3 min | 51,3 min | 34,7 MB |
| 10.000 | 5.334 | 7,21 h | 8,55 h | 347 MB |

Die Prognose ist eine lineare Planungsbandbreite, kein SLA. Aenderungsrate, Timeouts, Netzwerk, Seitengroesse und Hostdrosselung sind nicht vollstaendig modelliert. Insbesondere ab 1.000 URLs dominiert die Concurrency-1-Browserphase.

## Parameter- und Produktionsentscheidung

Maximaldauer 6.000 ms, 500-ms-Intervall, drei gleiche Folge-Snapshots, mindestens 4.000 ms Beobachtung und Concurrency 1 bleiben unveraendert. Vier Seiten aenderten sich noch nach drei Sekunden und die langsamste stabile Seite benoetigte knapp fuenf Sekunden; eine Verkuerzung waere deshalb nicht evidenzbasiert. Fuer eine hoehere Browser-Concurrency fehlen sichere Speicher- und Prozessdaten.

Die fachlich empfohlene Architektur ist Option C, der **zweistufige Renderplan**: guenstige Raw-Analyse, global deterministisch priorisierter Renderplan, danach genau eine Browserphase. Er funktionierte domainuebergreifend ohne verpassten notwendigen Renderfall und reduzierte Browserarbeit deutlich. Das Gate wird trotzdem noch nicht zum ungefragten Default: 56,3 % seiner Renderlaeufe waren in diesem Sample fuer die Kern-Evidenz nicht notwendig, und bei fast vollstaendig dynamischen Samples kostet die Raw-Vorstufe zusaetzlich. Standard bleibt daher `off`; `gate` wird bewusst aktiviert und weiter kalibriert.

## Grenzen

- Prozess- und Netzwerkbedingungen beeinflussen Laufzeit und Speicher; Profiling ist kein Laborisolator.
- Browser-RSS ist ohne verlaessliche Plattformmessung nicht verfuegbar.
- Ein gezieltes URL-Sample beschreibt nur seine enthaltenen Seitentypen.
- Technische Blockaden werden nicht umgangen.
- Template-Signale sind Planungsfakten, kein Ersatz fuer URL-spezifische Messungen.
- Die Instrumentierung aendert weder globale Scoringparameter noch Check-Severities.
