# Kalibrierung des deterministischen Render-Gates v2

Stand: 19. Juli 2026. Diese Dokumentation beschreibt die Version
`deterministic-render-gate-v2`. Sie aendert weder Scoring, Severity,
Coverage-Schwellen noch die Settling-Policy.

## Ausgangspunkt und Fehlermuster von v1

Der vorangegangene 37-URL-Benchmark hatte bei 16 Gate-Renderlaeufen sieben
notwendige und neun nicht notwendige Laeufe: 43,8 % Precision, 100 % Recall
und 56,3 % unnoetige Renderquote. Die Required-Signale erkannten die fuenf
Uniswap-App-Shells und zwei spaet aufgebaute web.dev-Seiten korrekt. Die
False Positives lagen im vorsichtigen `render_recommended`-Fallback.

Die Rekonstruktion und der erweiterte 50-URL-Benchmark ordneten die zehn
nicht notwendigen v1-Laeufe wie folgt ein:

- Vier React-Dokumentationsseiten wurden vor allem wegen einer fehlenden
  optionalen Meta Description gerendert, obwohl Raw-Main-Content, H1,
  Canonical, Sprache und Inhaltslinks bereits vorhanden waren. Drei Laeufe
  brachten optionale Zusatzfakten, einer keine relevante Aenderung.
- web.dev Startseite, `/learn` und `/about` trafen den allgemeinen Fallback
  beziehungsweise denselben optionalen Metadatenverdacht. Die Raw-Dokumente
  waren bereits fachlich nutzbar; Rendering war hoechstens ergaenzend.
- MDN Startseite und Blog wurden trotz umfangreicher Raw-Inhalte durch den
  konservativen Fallback gerendert, ohne relevantes Ergebnisdelta.
- Next.js `/showcase` hatte vollstaendigen Raw-Inhalt, aber einen Canonical-
  und Script-Verdacht. Der Lauf war als zweite Messung hilfreich, nicht fuer
  die URL-Bewertung zwingend.

Diese Faelle entsprechen den Familien `missing_optional_metadata`,
`raw_content_threshold_too_strict`, `check_requirement_too_broad` und
`framework_or_hydration_noise`. Positive Gegenbeispiele blieben Bestandteil
der Kalibrierung: sehr wenig Text ist bei Uniswap und Aave zusammen mit
fehlendem Hauptinhalt eine echte App-Shell; bei web.dev `/blog` und
`/discover` sowie der Next.js-Startseite ergaenzte der Browser fachlich
relevanten Hauptinhalt. Deshalb wurde kein einzelnes Thin-Content- oder
Frameworksignal entfernt, sondern die Evidenzkombination praezisiert.

## Entscheidungsmodell

Harte Required-Signale aus v1 bleiben vorrangig und koennen nicht durch
Negativsignale aufgehoben werden:

- Raw-App-Shell;
- vorhandener, aber praktisch leerer relevanter Main-Bereich;
- sehr wenig relevanter Raw-Inhalt zusammen mit fehlender H1;
- fehlende Primaerevidenz, die ein anwendbarer rendered-abhaengiger Check
  nicht aus Raw-Daten ersetzen kann.

`render_recommended` verwendet einen zentral versionierten, deterministischen
Evidenzscore. Positive Beitraege entstehen beispielsweise durch ein fast
leeres Dokument, eine Kombination aus duennem primaerem Inhalt und
ausfuehrbarer Struktur sowie gemeinsam fehlende kritische Dokumentfelder.
Gegen Rendering sprechen substanzieller Raw-Main- und Visible-Text, vorhandene
H1, Title/Canonical/Sprache, nutzbare Inhaltslinks, passende strukturierte
Daten, ein vollstaendiges Utility-Dokument oder `noindex`. Der Schwellenwert
ist 4. Signal, Gewicht, Richtung, Rohwert, angewandter Beitrag, Summe und
Schwelle werden gespeichert. Frameworkname, Domain und eine einzelne
Scriptdatei sind keine Entscheidungsmerkmale.

Eine fehlende Meta Description oder ein fehlendes Social-Feld erzeugt allein
keinen Renderlauf. Ein Script- oder Hydration-Marker erhoeht die Unsicherheit
nur, wenn relevante Raw-Evidenz gleichzeitig fehlt. Kurze Rechts-, Kontakt-,
Utility-, Produkt- und Hub-Seiten bleiben Raw-sufficient, sofern ihre
semantische Dokumentstruktur vollstaendig ist.

## Check-Anforderungen und Mindestmessungen

Rendered-sensitive Checks deklarieren additiv `raw_sufficient`,
`render_optional` oder `render_required`. HTTP-, Raw-HTML- und syntaktische
JSON-LD-Fakten erzwingen keinen Browser. Console-Diagnostik, Raw-/Rendered-
Vergleiche und optionale DOM-Ergaenzungen bleiben optional, solange Raw-
Primaerevidenz vollstaendig ist. Fehlende notwendige Renderdaten werden nicht
als Pass interpretiert.

`tech.js_dependent_content` benoetigt fuer eine belastbare siteweite Aussage
mindestens zwei unabhaengige stabile Messungen, sobald ein anwendbarer
Required-Fall existiert. Die Planung waehlt dazu deterministisch bevorzugt
ein anderes Template. Redirects, Fehlerantworten, Nicht-HTML-Ressourcen und
nicht erfolgreiche Initialantworten zaehlen nicht als Bestaetigung. Diese
zweite Messung ist in der strikten URL-Precision als nicht notwendig, in der
operativen Precision als begruendete Check-Messung ausgewiesen.

## Template- und Deferred-Entscheidung

Eine Hilfsfunktion bestaetigt Raw-sufficient Templateevidenz erst nach zwei
unabhaengigen, erfolgreichen Vertretern mit gleichem Seitentyp und gleicher
Raw-Struktur. Eine URL-spezifische Required-Evidenz, relevante Abweichung oder
Fingerprint-Kollision verwirft die Annahme. Das Produktions-Gate laesst
weitere URLs derzeit trotzdem nicht allein aufgrund des Templates aus; der
Benchmark belegt noch keine sichere aggressive Wiederverwendung.

Eine `render_deferred`-Phase wurde nicht eingefuehrt. Die explizite
Mindestmessungsplanung erreicht denselben belegten Nutzen ohne einen zweiten
allgemeinen Entscheidungszyklus oder neue Zwischenzustaende.

## Kontrollierter Realbenchmark

Der Vergleich verwendete 50 explizite URLs aus acht Domains in getrennten
SQLite-Datenbanken unter `/tmp`, Concurrency 1 und hoechstens 0,5
Requeststarts pro Sekunde. Enthalten waren marcdeboer.de (8, kleine statische
Website), app.uniswap.org (5, CSR-App), react.dev (5, hydrierte
Dokumentation), web.dev (5, redaktionelle Dokumentation), ikea.com (9,
serverseitiger E-Commerce), MDN (5, Wissenswebsite), app.aave.com (6,
zusaetzliche CSR-App) und nextjs.org (7, scriptreiche SSR-Dokumentation).
Uniswap, React und Aave wurden mit identischer Konfiguration je dreimal
wiederholt. Insgesamt entstanden 42 isolierte Ausgangslaeufe und 14 finale
v2-Laeufe; es gab keine Lauf- oder Browserfehler.

Die manuelle Wahrheit wurde fuer alle abweichenden Entscheidungen, alle
Required-Faelle und alle v2-Renderlaeufe mit unabhaengigen GET-/HTML- und
Playwright-Pruefungen bestimmt. Es ergaben sich 14 primaer notwendige, sieben
nutzbringende, aber nicht notwendige sowie 29 sichere Nicht-Renderfaelle.
Vollstaendige Bodies, DOMs, Screenshots und Browserprofile wurden weder im
Repository noch als Benchmarkbericht gespeichert.

| Strategie | Browserlaeufe | Precision (strikt) | Precision (operativ) | Recall | unnoetig | Wall time | Provenienz |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser-all | 50 | 28,0 % | 28,0 % | 100 % | 72,0 % | 267,2 s | 2.878.567 B |
| Gate v1 | 24 | 58,3 % | 58,3 % | 100 % | 41,7 % | 206,8 s | 843.072 B |
| Gate v2 | 16 | 87,5 % | 100 % | 100 % | 12,5 % | 169,6 s | 458.670 B |

Gegenueber v1 reduzierte v2 die Browserlaeufe um 33,3 %, die Wall time um
18,0 %, die gemessene Renderdauer um 31,1 % und die Renderprovenienz um
45,6 %. Gegenueber Browser-all waren es 68,0 %, 36,5 %, 66,6 % und 84,1 %.
Der Datenbankzuwachs sank gegenueber v1 um 3,3 % und gegenueber Browser-all
um 27,7 %. Settling blieb unveraendert; fuer v2 lagen P50 bei 5.005 ms und
P90 bei 5.683 ms.

Die drei Wiederholungsgruppen waren entscheidungsstabil: Uniswap renderte
5/5/5, React 0/0/0 und Aave 6/6/6. Score, Coverage, Root-Cause-Anzahl und der
Hash der URL-Entscheidungen blieben je Domain identisch.

## Coverage, Genauigkeit und bekannte Grenzen

Alle 14 manuell bestaetigten notwendigen Faelle wurden erkannt. Es entstand
kein bestaetigtes Critical-, High- oder Medium-False-Negative. Die beiden
zusaetzlichen v2-Laeufe waren die deterministischen Bestaetigungsmessungen auf
web.dev `/about` und Next.js `/showcase`.

Die URL-gewichtete Coverage lag bei 82,0 % fuer Browser-all, 80,76 % fuer v1
und 80,3 % fuer v2. Auf React und MDN sank sie um 2,3 beziehungsweise 2,4
Punkte, weil optionale browser-only Diagnostik korrekt `insufficient_evidence`
blieb, statt ohne Browser als Pass zu gelten. Dadurch wechselten diese Runs
von `final` zu `provisional`, obwohl kein manuell bestaetigtes primaeres Risiko
verloren ging. Coverage-Schwellen und Check-Severities wurden bewusst nicht
veraendert. Die fachliche Gewichtung optionaler Browserdiagnostik ist ein
separater Folgepunkt.

web.dev lieferte zwischen kontrollierten Abrufen unterschiedliche Raw-
Zustaende; das Gate folgte jeweils den gemessenen Fakten. Eine unabhaengige
Uniswap-Browserpruefung erhielt zeitweise 409/leer, waehrend die drei
isolierten Auditwiederholungen stabile 200-Renderzustaende lieferten. Solche
technischen Browserantworten beweisen keine Raw-Vollstaendigkeit und bleiben
fail-closed.

## Kostenhochrechnung

Das Modell nutzt die beobachteten Renderanteile (Browser-all 100 %, v1 48 %,
v2 32 %), P50/P90 der Raw- und Renderdauer, Concurrency 1 sowie mittlere
Persistenzgroessen. Die Werte sind lineare Hochrechnungen und keine
Laufzeitgarantie.

| URLs | v1 Browser | v1 P50/P90 | v2 Browser | v2 P50/P90 | Browser-all P50/P90 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 5 | 25,0/36,2 s | 4 | 21,1/31,8 s | 48,9/63,8 s |
| 100 | 48 | 4,0/5,8 min | 32 | 2,8/4,5 min | 8,1/10,6 min |
| 1.000 | 480 | 39,9/58,3 min | 320 | 28,3/45,3 min | 81,4/106,1 min |
| 10.000 | 4.800 | 6,7/9,7 h | 3.200 | 4,7/7,5 h | 13,6/17,7 h |
| 100.000 | 48.000 | 66,6/97,2 h | 32.000 | 47,2/75,5 h | 135,6/176,9 h |

Bei 100.000 URLs spart die P50-Hochrechnung rund 19,4 Browserstunden gegen
v1 und 88,5 Stunden gegen Browser-all. Der Wert ist besonders unsicher, weil
Website-Mix, Netzwerk, Browserstart, Cache und Fehlerquoten nicht linear
skalieren. Concurrency 1 ist bei dieser Groesse eine klare Architekturgrenze.

## Produktentscheidung

Gate v2 ersetzt v1 fuer explizit mit `playwrightMode=gate` gestartete Laeufe.
Die Defaultauswahl wird nicht geaendert: Rendering bleibt je Auditmodus
bewusst konfigurierbar (`off`, `gate`, `all`). `all` bleibt Vergleich und
Debugging vorbehalten; grosse Faktenlaeufe koennen `off` oder ein striktes
Renderbudget verwenden. Ein neues `auto` wurde nicht eingefuehrt.

Alte Runs behalten ihre gespeicherte Planungsfassung und bleiben lesbar. Der
Benchmarkbefehl kann v1 und v2 explizit vergleichen; seine Konfiguration muss
externe URLs nennen und sein Outputverzeichnis unter `/tmp` liegen. Er fuehrt
keine automatische Parameteroptimierung aus.
