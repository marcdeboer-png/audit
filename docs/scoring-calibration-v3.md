# Scoring-Kalibrierung v3

## Zweck und Aussagegrenze

Diese Kalibrierung prueft das Root-Cause- und Scoring-Modell an gezielten realen Samples. Sie optimiert nicht auf hohe Scores und ersetzt keinen Vollcrawl. Website-Zustaende, HTTP-Antworten und clientseitige Anwendungen koennen sich nach dem Messfenster veraendern.

Ausgangspunkt war Commit `db617bca88a991a07c5ade535c4168210eea8fd2` mit `root-cause-scoring-v2`, `deterministic-root-cause-v1`, `weighted-coverage-v1` und `run77-resilience-v2`. Das kalibrierte Modell verwendet `root-cause-scoring-v3`, `deterministic-root-cause-v1`, `weighted-coverage-v2` und `calibration-v3`.

## Benchmark-Set

Die kontrollierten Runs nutzten je Domain eine eigene temporaere Datenbank, explizite URL-Listen, Concurrency 1, hoechstens 0,5 Seiten pro Sekunde und keine Lighthouse-Laeufe. Browser-Rendering wurde nur fuer die clientseitige Anwendung aktiviert. Die komplette Wahrheitsmatrix und HTTP-Belege lagen ausschliesslich unter `/tmp` und gehoeren nicht ins Repository.

| Domain | Archetyp | Primaeres Sample | Status | Coverage | Score | Root Causes |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| marcdeboer.de | kleine statische Expertenwebsite | 10 | final | 83,4 % | 94 | 14 |
| trinkgut-zierles.de | E-Commerce und Run-77-Domain | 20 | final | 85,1 % | 76 | 24 |
| ikea.com/de/de | sehr grosse E-Commerce-Website | 20 | provisional | 79,1 % | 88 | 19 |
| smashingmagazine.com | Redaktion/Magazin | 10 | final | 82,0 % | 82 | 18 |
| docs.python.org/3 | Dokumentation/Wissen | 10 | provisional | 77,8 % | 90 | 16 |
| app.uniswap.org | clientseitig gerenderte Anwendung | 6 | final | 89,0 % | 23 | 24 |
| european-union.europa.eu/index_de | oeffentliche Institution | 10 | final | 80,5 % | 81 | 17 |

Sitemap-Groessen wurden nur zur Einordnung erhoben. Grosse Sitemap-Indizes wurden nicht vollstaendig gecrawlt. Die Samples enthielten Start-, Uebersichts-, Detail-, Inhalts-, Utility- und technisch besondere Seitentypen, soweit die jeweilige Site diese ohne Login bereitstellte.

## Manuelle Wahrheitspruefung

Alle Critical-, High- und Medium-Findings, Root Causes mit mindestens zwei Punkten Abzug, Cross-Check-Zusammenfuehrungen, mindestens fuenf Low-Findings und zehn Pass-Ergebnisse pro Domain sowie alle nicht bewertbaren Zustaende wurden unabhaengig gegengeprueft. Verwendet wurden GET-Requests mit Redirect-Ketten, ein separater HTML-Parser, strukturierte JSON-LD-Auswertung, Asset-Requests und fuer Uniswap ein separater Browserlauf.

Die maschinenlesbare Matrix umfasst 514 ausgewaehlte Ergebniszeilen; 123 davon bilden die Klassifikationsmetriken. In diesem kontrollierten Sample wurden 48 positive Ergebnisse fachlich bestaetigt oder als sachlich positiv mit Prioritaetsproblem eingeordnet, 69 Pass-Ergebnisse als True Negative bestaetigt, drei reine False Positives, ein Finding mit falschem Scope und ein False Negative gefunden. Fuer die binaere Precision/FPR zaehlt der falsche Scope ebenfalls als unzutreffendes positives Ergebnis. Precision betrug dadurch 92,31 %, Recall 97,96 %, Severity-Accuracy 89,36 % und Scope-Accuracy 97,96 %. Die False-Positive-Rate betrug 5,48 %, die False-Negative-Rate 2,04 %. Bei kleinen Teilgruppen sind diese Quoten deskriptiv und keine belastbaren Populationsschaetzer.

Alle geprueften `technical_error`- und `insufficient_evidence`-Zustaende blieben scorefrei. Von 90,163 manuell geprueften angewandten Abzugspunkten waren 55,921 Punkte in Ursache, Scope und Gewicht voll bestaetigt. Der Anteil von 62,02 % wird vor allem durch die zu hohe Gewichtung roher statt gerenderter Metadaten auf der clientseitigen Anwendung und einen doppelten Redirect-Abzug gedrueckt; er bedeutet nicht, dass die uebrigen Messfakten frei erfunden waren.

## Wiederholungs- und Sample-Stabilitaet

Drei identische 10-URL-Laeufe auf marcdeboer.de, trinkgut-zierles.de und docs.python.org lieferten jeweils identische Scores, Coverage-Werte und Root-Cause-ID-Mengen. Der Score-Bereich und der Coverage-Bereich waren jeweils null; die Root-Cause-Jaccard-Aehnlichkeit betrug 1,0.

Bei IKEA blieben 5-, 10- und 20-URL-Samples innerhalb eines Scorepunkts. Alle Root Causes des 5er-Samples blieben im 20er-Sample erhalten; die groessere Stichprobe erzeugte keine zusaetzlichen Root Causes. Bei Trinkgut blieb das 5er- zum 10er-Sample stabil, waehrend das geschichtete 20er-Sample sechs neue Root Causes und weitere reale Seitentypfehler aufdeckte. Der Score sank dadurch von 90 auf 76. Das war keine reine URL-Mengenwirkung: Bestehende Root Causes blieben vollstaendig erhalten, und die Aenderung folgte den neu vertretenen Seitentypen.

## Parameterentscheidungen

| Parameter | Entscheidung | Evidenz |
| --- | --- | --- |
| Severity 30/14/5/1 | behalten | Nach Korrektur der Status-Priority-Zuordnung trennten Critical, High, Medium und Low plausible Risikoklassen. |
| Confidence 1/0,7/0 | behalten | Medium blieb abgeschwaecht; Low Confidence blieb konsequent scorefrei. |
| logarithmische Scope-Funktion, Cap 2 | behalten | Die groessere IKEA-Stichprobe veraenderte den Score kaum; bei Trinkgut erklaerten neue Seitentypen und Ursachen die Abweichung. |
| Scope-Multiplikatoren URL 1, Template 1,15, sitewide 1,25, Resource 1, External 0,75, Service 1,15 | behalten | Template- und siteweite Ursachen blieben sichtbar, externe Ziele waren reduziert; eine wiederholte multiplikatorspezifische Fehlgewichtung wurde nicht beobachtet. |
| Low-Cap 5 | behalten | Optionale Empfehlungen waren auf allen Domains begrenzt und ueberdeckten den bestaetigten High-Soft-404 nicht. |
| Kategorie-Caps 12 bis 35 | behalten | Nur die CSR-Anwendung traf einen materiellen Performance-Cap; der High-Fehler blieb sichtbar. |
| Coverage final ab 80 %, provisional ab 60 % | mit bekanntem Limit behalten | Fuenf von sieben primaeren Audits wurden final. IKEA und Python Docs blieben wegen fehlender Browser-/Linkdetaildaten nachvollziehbar provisional. |

Die numerischen Severity-, Confidence-, Scope- und Cap-Werte wurden nicht geaendert. Geaendert wurden systematische Zuordnungsfehler, die mehrere Domains oder mathematische Invarianten betrafen: explizite Check-Priority steuert die Standard-Severity, scorefreie aber voll ausgefuehrte Inventare tragen zur Coverage bei, optionale Heuristiken sind Low, und abgeleitete Template-Roll-ups verursachen keinen zweiten Abzug.

## Root-Cause-Modell

Sieben kontrollierte Cross-Check-Zusammenfuehrungen waren fachlich korrekt. Es gab keinen False Merge und einen False Split: Auf der EU-Site beschrieben ein interner Redirect-Link und die gecrawlte Redirect-Seite denselben Alias, wurden aber separat abgezogen. Dafuer wurde kein neuer expliziter Key eingefuehrt, weil der geforderte Nachweis auf mindestens zwei realen Domains noch fehlt. Die deterministischen Root-Cause-IDs blieben in allen Wiederholungslaeufen stabil.

## Belegte technische Korrekturen

- Autorisierte Trailing Slashes werden angefragt, waehrend die Queue-Identitaet weiterhin kanonisch dedupliziert. Dadurch erzeugt der Crawler keine kuenstlichen Redirect-Aliase.
- Ein Robots-Ausschluss fuer eine einzelne `.txt`-Datei gilt nicht mehr als pauschale Sperre aller Textdateien.
- Bild-Alttext und `aria-label` koennen den zugaenglichen Namen einer ansonsten textleeren Ueberschrift liefern.
- `BlogPosting`, `NewsArticle` und weitere Article-Untertypen erfuellen die Article-Abdeckung.
- Redirect-Antworten werden nicht als normale erfolgreiche indexierbare HTML-Seiten bewertet.
- Fehlende Protokollmessungen, abgeschnittene Linkinventare und nicht persistierte gerenderte Linkdetails schliessen fail-closed mit `insufficient_evidence` oder `technical_error`.
- Bereits erhobene synthetische 404-Evidenz bleibt bei einer reinen Neuberechnung eines abgeschlossenen Runs erhalten; es werden keine neuen Live-Requests ausgeloest.

## Bekannte Grenzen und Modellreife

Die Reifestufe ist `calibrated_with_known_limits`.

- Gerenderte Titel, Descriptions, Canonicals und Sprachangaben werden noch nicht getrennt von Raw-Werten persistiert. Raw-only-Findings koennen bei CSR deshalb zu hoch priorisiert sein.
- Der Browser-Collector kann komplexe CSR-Seiten erfassen, bevor der sichtbare Inhalt stabil ist.
- Lokalisierte Monat-Jahr-Daten und manche sichtbaren Byline-Komponenten werden noch nicht erkannt.
- Der Redirect-Alias-False-Split ist bewusst offen, bis eine sichere Cross-Domain-Regel belegt ist.
- Ein gezieltes Sample kann unbekannte Seitentypen nicht vertreten. Score, Coverage und Sample-Zusammensetzung muessen zusammen gelesen werden.

`production_ready` ist damit nicht belegt. Die wichtigsten deterministischen Kernpfade und die Parameter sind fuer gezielte Audits kalibriert; clientseitiges Rendering und einzelne semantische Content-Signale benoetigen weitere Arbeit.

## Regeln fuer kuenftige Parameteraenderungen

Ein Parameter oder Root-Cause-Key wird nur geaendert, wenn mindestens zwei reale Domains denselben Fehler zeigen, eine mathematische Invariante verletzt ist oder kontrollierte Szenarien eine systematische Fehlgewichtung belegen. Positive und negative Fixtures, Cross-Domain-Tests, stabile Keys und Auswirkungen auf bestehende Runs sind vor jeder Aenderung zu dokumentieren. Einzelne ueberraschende Scores, Performance-Schwankungen oder der Wunsch nach einem hoeheren Score reichen nicht.
