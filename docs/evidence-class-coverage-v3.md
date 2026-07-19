# Evidence-class Coverage v3

## Zweck und Abgrenzung

`evidence-class-coverage-v3` trennt die Vollstaendigkeit der geplanten
Primaerpruefungen von optionaler Browser- und Vertiefungsdiagnostik. Coverage
bleibt eine von Score und Severity unabhaengige Dimension. `final` bedeutet,
dass die geplante Primaerevidenz ausreichend vollstaendig ist; es bedeutet
nicht vollstaendige Websiteabdeckung oder dass jede optionale Diagnose lief.

Die globalen Severity-Gewichte, Confidence-Faktoren, Scope-Funktion, Caps,
Check-Severities und `deterministic-render-gate-v2` bleiben unveraendert.

## Ursache der bisherigen Statusverschiebung

Coverage v2 leitete den Nenner im Wesentlichen aus Check-Prioritaet und
Finding-Typ ab. Dadurch verloren `tech.js_dependent_content`,
`tech.raw_h1_missing_rendered_present`,
`tech.raw_internal_links_fewer_rendered`, `tech.rendered_word_count_delta` und
`tech.console_errors_present` normale Coverage, wenn Gate v2 auf einer
Raw-vollstaendigen SSR-Seite bewusst keinen Browser startete. React und MDN
fielen deshalb in der vorherigen Kalibrierung von `final` auf `provisional`,
obwohl keine bestaetigte Primaerevidenz durch diese Entscheidung verloren
ging. V3 ordnet diese Auslassungen der Diagnostic Coverage zu und bewertet
unabhaengig davon weiterhin jede tatsaechlich fehlende Primaermessung.

## Evidence-Klassen und Gewichte

| Klasse | Gewicht | Semantik bei fehlender Evidenz |
| --- | ---: | --- |
| `primary_required` | 1,0 | Primary Coverage sinkt |
| `primary_conditional` | 1,0, wenn anwendbar | anwendbar: Primary Coverage sinkt; sonst ausgeschlossen |
| `secondary_diagnostic` | 0,15 | nur Diagnostic Coverage betroffen |
| `optional_opportunity` | 0,05 | nur optionale/gewichtete Diagnose betroffen |
| `inventory` | 0,2 | vollstaendige Bestandsaufnahme zaehlt zur Inventory Coverage |

Viele optionale Checks koennen die Primary Coverage weder aufblaehen noch
absenken. Inventory bleibt sichtbar, dominiert aber nicht den Headline-Status.

## Availability-Semantik

Jedes neue Check-Ergebnis trennt:

- `executionStatus`: etwa `completed`, `disabled`,
  `skipped_by_render_plan`, `skipped_by_budget`, `not_executed` oder
  `technical_error`;
- `evidenceStatus`: `complete`, `not_required`, `required_but_missing`,
  `optional_unavailable` oder `technical_error`;
- `evaluationStatus`: die fachliche Evaluation wie `pass`, `fail`,
  `not_applicable`, `insufficient_evidence`, `not_executed` oder
  `technical_error`;
- `coverageStatus`: `covered`, `uncovered`, `excluded` oder
  `diagnostic_unavailable`.

Ein sichtbares `NA` entscheidet damit nicht mehr allein ueber Coverage. Ein
technischer Fehler ist nie ein Pass. Historische Runs ohne diese Felder zeigen
die Semantik als historisch unbekannt und behalten ihren gespeicherten
Coverage-Snapshot.

## Dynamischer Nenner und Coverage-Units

Der Nenner entsteht aus dem tatsaechlichen Auditplan: Audittyp, aktivierte
Module, Anwendbarkeit, Renderplan und Budget bestimmen, welche Units relevant
sind. Deaktivierte Module und fachlich nicht anwendbare Checks sind
ausgeschlossen. Wird eine konditionale Voraussetzung erfuellt, gehoert die
Unit in den Primaernenner und fehlende Evidenz bleibt sichtbar.

`coverageUnitKey` verhindert Doppelzaehlung. Beispiele sind
`site:structured_data:article_coverage`,
`site:render_diagnostic:raw_rendered_content`,
`module:lighthouse:performance` und ein stabiler Check-Fallback. Mehrere
Check-Perspektiven duerfen dieselbe Unit verwenden, sofern sie dieselbe
fachliche Zielaussage aus derselben Evidenz bewerten.

## Browser-only-Checks

- `tech.js_dependent_content` ist bei bestaetigtem Renderbedarf
  `primary_conditional`. Ein Budget- oder Browserausfall bleibt uncovered.
- Auf einer Raw-vollstaendigen SSR-Seite ohne Required-Signal ist derselbe
  Vergleich nur zusaetzliche Diagnostik und bei `render_not_required`
  ausgeschlossen.
- Raw-/Rendered-H1-, Link- und Wortzahldeltas sowie Console-Diagnostik sind
  `secondary_diagnostic`.
- Lighthouse-Performance ist nur bei aktiviertem Lighthouse-Modul
  `primary_conditional`; ein deaktiviertes Modul taescht keine Coverage vor.
- Effektive Title-, H1-, Canonical- und andere Primaerchecks bleiben
  fail-closed, wenn ein erforderlicher finaler Dokumentzustand fehlt.

## Headline-Status und Grenzen

Primary Coverage ab 80 Prozent ist `final`, ab 60 Prozent `provisional` und
darunter `insufficient_coverage`. Eine kritische geplante Kategorie mit weniger
als 60 Prozent Primary Coverage begrenzt den Gesamtstatus auf `provisional`.
Performance, GEO oder optionale Browserdiagnostik blockieren nur, wenn sie
Bestandteil des gewaehlten Primaerumfangs sind.

Gezielte URL-Samples koennen unbekannte Templates oder Seitentypen nicht
vertreten. Coverage beschreibt daher die Vollstaendigkeit des geplanten und
anwendbaren Audits, nicht die vollstaendige Wahrheit ueber eine Domain.

## Kalibrierungsbenchmark

Die Kalibrierung verwendete 50 explizit ausgewaehlte URLs auf acht Domains und
je einen isolierten Raw-only-, Browser-all- und Gate-v2-Lauf. Concurrency war
eins, die Anfragerate hoechstens 0,5 Seiten pro Sekunde, Lighthouse war
deaktiviert und jede Datenbank lag unter `/tmp`. Die zuvor manuell validierten
14 notwendigen Renderfaelle wurden als Wahrheit fuer den Vergleich
weiterverwendet; Website-Inhalte und Benchmarkdaten sind nicht Bestandteil des
Repositories.

| Domain | Coverage v2 Gate | Gate Primary | Gate Diagnostic | Gate Inventory | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| marcdeboer.de | 79,0 % | 83,3 % | 0 % | 85,7 % | provisional |
| app.uniswap.org | 83,3 % | 81,5 % | 100 % | 85,7 % | provisional |
| react.dev | 79,2 % | 81,1 % | 0 % | 85,7 % | provisional |
| web.dev | 81,5 % | 85,5 % | 100 % | 85,7 % | final |
| ikea.com | 77,5 % | 80,4 % | 0 % | 85,7 % | provisional |
| developer.mozilla.org | 78,2 % | 80,8 % | 0 % | 85,7 % | provisional |
| app.aave.com | 84,0 % | 79,6 % | 100 % | 85,7 % | provisional |
| nextjs.org | 81,5 % | 80,0 % | 100 % | 85,7 % | provisional |

Bei React ist Gate Primary identisch zu Browser-all (81,1 Prozent), obwohl
Gate v2 die optionale Browserdiagnostik bewusst ausliess. Der Status bleibt im
isolierten Benchmark dennoch `provisional`, weil die Performance-Kategorie
wegen fehlender primaerer Ressourcenmessungen nur zu 40,0 Prozent abgedeckt
war. MDN verlor durch das Gate ebenfalls keine bereits erhobene
Browser-Primaerevidenz: Browser-all erhob dort jedoch zusaetzlich die
tatsaechliche Groesse grosser Bildressourcen (82,7 statt 80,8 Prozent Primary).
Der Unterschied ist Primaerevidenz und wurde daher nicht als optionale
Diagnostik umklassifiziert.

Raw-only blieb fuer Uniswap und Aave wegen fehlender erforderlicher
Render-Evidenz `provisional`; dasselbe Fail-closed-Verhalten trat bei den im
aktuellen Sample renderpflichtigen Seiten von web.dev und nextjs.org auf. Die
Benchmark-Harness fuehrte bewusst keinen vollstaendigen produktionsnahen
Protocol- und Ressourcen-Preflight aus. Ihre verbleibenden Primaerluecken
duerfen daher nicht durch optionale Evidence-Gewichte verdeckt werden.

Drei rekonstruierte Gate-Laeufe pro Domain fuer React, Uniswap und Aave hatten
jeweils identische Primary-, Diagnostic- und gewichtete Coverage sowie
identische Coverage-Unit-Mengen. Die Benchmarkstuetzung ist dennoch ein
begrenztes reales Sample und kein Beleg fuer alle Websitearchitekturen.
