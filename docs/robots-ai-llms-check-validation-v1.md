# Robots-, AI-Bot- und llms.txt-Validierung v1

Stand: 23. Juli 2026. Validierter Basisstand:
`9bba3647f1022170422b56c6a904c52942b2603c`.

## Scope und Ursache der Abweichungen

Dieser Batch gleicht ausschließlich
`geo.ai_bots_policy_summary`, `geo.llms_txt_http_status`,
`geo.llms_txt_present`, `geo.robots_blocks_txt_files` und die zehn aktiven
AI-Bot-Einzelchecks an `audit-standard-v1` an. `geo.llms_full_txt_present`,
`geo.speakable_present` und `tech.speakable_missing` bleiben deaktiviert und
historisch lesbar.

Die bisherige Logik suchte überwiegend nach Botnamen und einfachen
Stringmustern. Sie trennte explizite und geerbte Policies, wirksame
Präzedenz, Pfadabhängigkeit und technische Availability nicht vollständig.
Der Summary-Check war zudem als eigenständiges Finding angelegt. Bei
`llms.txt` reichten Status beziehungsweise ein vorhandener Body aus; initialer
und finaler Status, Stabilität, Repräsentation, UTF-8 und eine konservative
Mindeststruktur bildeten noch keine gemeinsame belastbare Aussage.

## Finale Logik je Check

| Check(s) | Soll und Umsetzung | Severity / Score |
| --- | --- | --- |
| `geo.ai_bots_policy_summary` | Aggregiert die zehn Einzelchecks als ausdrücklich erlaubt, nur implizit erlaubt, unklar, blockiert oder technisch nicht bewertbar. Er erzeugt weder eine eigene Root Cause noch eine Qualitäts-Pass-Aussage. | `Info`, `diagnostic_only`, scorefrei |
| zehn `geo.robots_mentions_*` | Eine explizite, wirksam erlaubende Named-User-Agent-Gruppe ist Pass. Fehlende Gruppe, reine Wildcard-Erlaubnis oder unvollständige explizite Freigabe ist Low; wirksame Blockierung eines repräsentativen öffentlichen Pfads ist Medium. | dynamisch `Low`/`Medium`, scorewirksam, gemeinsame Root Cause |
| `geo.robots_blocks_txt_files` | Bewertet ausschließlich `/llms.txt` für alle zehn unterstützten Bots. Mindestens eine wirksame Blockierung ist Medium; `/llms-full.txt` wird nicht mehr geprüft. | `Medium`, scorewirksam, mit Bot-Policy dedupliziert |
| `geo.llms_txt_http_status` | Verlangt auf dem kanonischen primären Host einen stabilen direkten GET mit initial und final 200, ohne Redirect, mit geeigneter Textrepräsentation und verwertbarem Body. | `Low`, scorewirksam, gemeinsame llms.txt-Root-Cause |
| `geo.llms_txt_present` | Verlangt zusätzlich UTF-8, nicht leeren Nicht-HTML-Inhalt, eine eindeutige Site-/Projektbezeichnung und mindestens einen verwertbaren Abschnitt oder ein valides internes Ziel. | `Low`, scorewirksam, primärer Score-Owner |

`not_executed`, `technical_error`, `insufficient_evidence`, abgeschnittene
Antworten und instabile Messfolgen bleiben scorefrei. Historische Evidence
wird nicht ergänzt oder rekonstruiert.

## Robots-Parser und Pfadsemantik

`ai-robots-policy-v2` verarbeitet mehrere Gruppen desselben Bots, mehrere
User-Agents je Gruppe, Kommentare, Direktiven unabhängig von ihrer
Schreibweise, leeres `Disallow`, `Allow`, `Disallow`, `*`, `$`, unbekannte
Direktiven und Gruppenreihenfolge. Named-Gruppen haben für den jeweiligen Bot
Vorrang vor `User-agent: *`. Innerhalb der ausgewählten Gruppen gewinnt die
längste passende Regel; bei gleicher Spezifität gewinnt `Allow`.

Eine explizite Named-Gruppe ohne operative Blockierung ist nach
Robots-Semantik eine ausdrückliche vollständige Freigabe und benötigt nicht
den wörtlichen Text `Allow: /`. Eine Datei, die beispielsweise nur
`Sitemap:` enthält, ist ebenfalls parsebar; die fehlenden Named-Gruppen
erzeugen Low statt eines Parserfehlers. Regeln ohne zugehörige
User-Agent-Gruppe bleiben dagegen unzuverlässige Policy-Evidence.

Die deterministische Pfadmenge beginnt mit `/` und `/llms.txt`. Hinzu kommt je
im Run eindeutig erkanntem öffentlichen Seitentyp eine erfolgreiche,
indexierbare HTML-URL auf dem primären Host. Login, Account, Admin, Checkout,
Warenkorb, interne API-, Auth-, Token-, Session-, Preview-, Search-, Filter-,
Utility- und synthetische unbekannte Pfade sind ausgeschlossen. Die Auswahl
verwendet nur vorhandene Run-Daten und löst keinen zusätzlichen Vollcrawl aus.

Persistiert werden Bot, gefundene Gruppen, Policyquelle, kompakte Regeln,
berechnete Gewinnerregel, Pfadrolle, Seitentyp, Ergebnis je Pfad,
Robots-Status, finaler Host sowie Parser- und Checkversion.

## llms.txt-Mindestvalidierung

`llms-txt-validation-v1` trennt HTTP- und Inhaltsprovenienz. Die HTTP-Evidence
enthält initialen und finalen Status, finale URL, Redirectkette,
Messversuche, Messzustand, Content-Type, Bytezahl und Truncation. 429,
500–504 und Netzwerkabbrüche werden begrenzt erneut gemessen; gemischte
Resultate bleiben `unstable` statt den ersten oder letzten Versuch zu
verdecken.

Der bewusst konservative Inhaltsparser akzeptiert Text-/Markdown-
Repräsentationen, prüft gültiges UTF-8, schließt leere, reine Whitespace- und
HTML-/Softresponse-Inhalte aus und verlangt eine nicht generische H1-
Bezeichnung der Site beziehungsweise des Projekts. Mindestens ein inhaltlich
belegter Abschnitt ab Ebene 2 oder ein valides internes kanonisches Ziel ist
notwendig. Der Parser bewertet keine redaktionelle GEO-Qualität und führt
keine darüber hinausgehende Inhaltsregel ein.

Neue Runs persistieren keinen vollständigen fremden `llms.txt`-Body. Die
dauerhafte Evidence beschränkt sich auf Bytezahl, Charset, Content-Type,
Überschriften, verwertbare Abschnitte, interne Ziele, Sitebezeichnung,
SHA-256 und Validierungsgründe.

## Root Causes und Parität

Alle AI-Bot-Einzelchecks und die `/llms.txt`-Robotsblockade verwenden
`ai_crawler_policy.robots_configuration`. Dadurch wird eine gemeinsame
siteweite Robots-Konfiguration nur einmal scorewirksam. Der Summary-Check
besitzt keine Score-Root-Cause.

`geo.llms_txt_present` und `geo.llms_txt_http_status` verwenden gemeinsam
`ai_files.llms_txt`; Presence ist der primäre Score-Owner, der Statuscheck
bleibt als deduplizierte technische Perspektive sichtbar. Verwandte HTTP- und
Robots-Findings werden über `relatedCheckIds` und die jeweils konkrete
authored Ursache verbunden, ohne technisch verschiedene Ursachen pauschal
zusammenzuführen.

Die Regression prüft Datenbank, HTML-Report, Detailansicht, JSON, CSV, API/UI-
Metadaten, Score-Snapshot und Root-Cause-Export. Der vollständige Fremdinhalt
wird in keiner dieser Ebenen ausgegeben.

## Unabhängige Domainvalidierung

Die unabhängige Referenzmessung verwendete serielle GET-Anfragen ohne
Umgehung von Sperren. Ein separater Referenzparser wurde vor dem Vergleich
mit den Produktionsutilities ausgeführt. Die vollständige temporäre
Wahrheitsmatrix liegt unter
`/tmp/robots-ai-llms-validation-v1/truth-matrix.json`.

| Archetyp / Domain | Reale Zustände |
| --- | --- |
| kommerzielle Technologiesite / imakemvps.com | explizite vollständige Named-Bot-Freigaben für sieben der zehn Bots |
| kleine Expertenwebsite / marcdeboer.de | ausschließlich Wildcard-Freigabe; valide direkte `llms.txt` |
| große redaktionelle Site / nytimes.com | explizite vollständige Blockierung von neun Bots |
| Community-Plattform / reddit.com | wirksame Wildcard-Blockierung |
| Dokumentation / nextjs.org | robots.txt nur mit Discovery-Direktive; valide direkte `llms.txt` |
| hydrierte lokale Commerce-Site / trinkgut-zierles.de | Wildcard-Policy, Hostredirect am Apex und finale `llms.txt`-404 |
| große Corporate-Site / anthropic.com | `llms.txt`-Redirect mit finaler 404 |
| WAF-geschützte Sites / openai.com, perplexity.ai | beobachtete 403-/HTML-Repräsentationen |

72 Live-Vergleiche und acht kontrollierte Matrixgruppen ergaben nach der
belegten Discovery-only-Parserkorrektur null Abweichungen zwischen
unabhängiger Erwartung und Toolresultat. Die Live-Menge enthält sieben
explizite Freigaben, 34 implizite Freigaben, 19 wirksame Blockierungen, zwei
valide `llms.txt`-Implementierungen und vier deterministische negative
`llms.txt`-Antworten. Die kontrollierten Fixtures ergänzen explizite
Freigaben für alle zehn Bots, Präzedenz, technische Fehler, Instabilität,
Redirect, 204, 404, bestätigte 503, 429, Softresponse, Charset, Content-Type
und Mindeststruktur.

Zweite serielle GET-Messungen bestätigten unveränderte Status- und
Inhalts-Hashes für marcdeboer.de, nextjs.org, imakemvps.com und nytimes.com;
die kanonische trinkgut-zierles.de-`llms.txt` blieb 404.

## Run 77

Run 77 wurde ausschließlich aus einer temporären read-only Datenbankkopie
rekonstruiert. Der Originalrun blieb unverändert. Der Run speichert eine
robots.txt-200-Antwort und `llms.txt`/`llms-full.txt` jeweils als 404; er
enthält jedoch keine getrennten initialen/finalen Statuswerte,
Redirectkette, Messversuche, Truncation oder Parser-/Policy-Version.

Die damaligen fünf Einzelbot-Findings werden durch den gespeicherten
Robots-Inhalt und den heutigen Livezustand sachlich bestätigt. Fünf heute
aktive Einzelbotchecks besaßen damals kein Ergebnis. Der damalige Summary-
Inhalt ist als Inventar nachvollziehbar, seine Warning-/Low-/Scorewirkung ist
nach dem Standard falsch; heute ist er Info und scorefrei.
`geo.robots_blocks_txt_files` meldete keinen Block, was gespeicherter und
heutiger Policy entspricht. Die damaligen `llms.txt`-404-Kernaussagen sind
gespeichert und heute weiterhin beobachtbar. Eine strikte Neuberechnung nach
v1 bleibt dennoch `historical_state_unknown`, weil die neue
Requestprovenienz nicht rückwirkend erfunden werden darf.

Die kompakte Rekonstruktion ohne Bodies oder Kundendaten liegt unter
`/tmp/robots-ai-llms-validation-v1/run77-reconstruction.json`.

## Registry-Fortschritt und Grenzen

`check-validation-registry-v8` führt alle 14 Checks dieser Familie mit
zentralen Requirements, Evidence-Klasse, Coverage-Unit, Availability,
Checkversion, Parser-/Policy-Version und Standardmetadaten.

- `cross_domain_validated`: beide `llms.txt`-Checks,
  `geo.robots_blocks_txt_files` sowie sieben Bots mit realer expliziter
  Freigabe;
- `validated_with_limits`: Summary sowie Bytespider, CCBot und Claude-Web,
  deren realer Satz Missing-/Blockzustände, aber keine reale explizite
  vollständige Freigabe enthielt;
- Familienabdeckung: 100 %;
- globale Check-Validation-Coverage: unverändert 82,09 %;
- scoregewichtete Abdeckung: 50,24 % auf 60,96 %;
- Primary-Evidence-Abdeckung: 60,38 % auf 68,18 %;
- Critical-/High-Abdeckung: unverändert 37,50 %.

Bekannte Grenzen: Bewertet wird die veröffentlichte technische Policy, nicht
die freiwillige Befolgung durch Drittanbieter. Repräsentative Pfade sind auf
vollständige vorhandene Run-Fakten begrenzt. Der Mindestparser bewertet keine
inhaltliche Qualität von `llms.txt`. Instabile Antworten bleiben bewusst
scorefrei; es gibt keine endlosen Retries. Bytespider, CCBot und Claude-Web
benötigen für `cross_domain_validated` noch mindestens einen unabhängig
belegten realen expliziten vollständigen Freigabefall.

## Regressionen

Der Batch deckt mindestens folgende kontrollierte Zustände ab:

- explizite Freigabe, Wildcard-only, explizite und geerbte Blockierung;
- mehrfache Gruppen, mehrere User-Agents, leeres `Disallow`, `Allow`,
  `Disallow`, `*`, `$`, Kommentare, Schreibweise, unbekannte Direktiven und
  Präzedenz;
- deterministische öffentliche Pfade und Ausschluss privater Pfade;
- Robots-Abruf-, Parser-, Host-, Redirect- und historische
  Availability-Zustände;
- direkte valide `llms.txt`, Redirect, 204, 404, bestätigte 503, instabile
  429/5xx, Softresponse, leerer/Whitespace-Body, Content-Type, UTF-8,
  Sitezuordnung und Abschnitt/Referenz;
- gemeinsame Root Causes, Scorewirkung, Summary-Scorefreiheit,
  Import-/Alt-Run-Isolation und Ausgabeparität.

Temporäre Raw-Responses, Header, Datenbankkopie und Wahrheitsmatrix verbleiben
ausschließlich unter `/tmp/robots-ai-llms-validation-v1/` und werden nicht
committet.
