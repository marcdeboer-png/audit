# Robots-, Sitemap- und Discovery-Validierung v1

Stand: 2026-07-19. Basis: `496247f1f8b8e21cd45fd9081d85e1210489c56c`.
Die Live-Messdaten, Bodies, Wahrheitsmatrix und der vollstaendige technische
Bericht liegen ausschliesslich unter `/tmp/robots-sitemap-validation-v1/` und
werden nicht committed.

## Fachliche Referenzen und Geltungsbereich

Die Robots-Auswertung orientiert sich am
[Robots Exclusion Protocol (RFC 9309)](https://www.rfc-editor.org/rfc/rfc9309.html).
Insbesondere bedeutet eine 4xx-Antwort auf `/robots.txt`, dass keine Regeln
verfuegbar sind; sie ist keine Crawlblockade. 5xx-, Netzwerk- und instabile
Antworten sind davon getrennt und benoetigen technische beziehungsweise
zeitliche Einordnung. Robots-Regeln steuern Crawling und beweisen keine
Indexierbarkeit.

Sitemap-Dokumente werden gegen die Struktur des
[Sitemaps-Protokolls](https://www.sitemaps.org/protocol.html) geprueft. Ein
HTTP-200-HTML-Fallback ist keine XML-Sitemap. `urlset` und `sitemapindex`
werden strukturell geparst; gzip, BOM, Namespaces, XML-Entities, Duplikate,
Zyklen und Grenzen werden explizit behandelt. Eine Sitemap-Datei darf maximal
50.000 URLs und unkomprimiert 50 MB enthalten. Die Implementierung begrenzt
ausserdem Rekursion, Dateianzahl, Download- und Run-URL-Budgets.

## Validierte Checkaussagen

| Check | Belastbare Aussage | Nutzung |
| --- | --- | --- |
| `tech.robots_txt_present` | Klassifiziert die per GET beobachtete Ressource als nutzbare Policy, leere Policy, 4xx-Abwesenheit, HTML-Fehlrepresentation oder technisch nicht belastbare Messung. | `automated_with_limits`; nur eine nachgewiesen unbrauchbare 2xx-Repräsentation ist scorefaehig. |
| `tech.sitemap_present` | Eine Sitemap gilt nur bei erfolgreichem GET und valide geparstem `urlset` oder `sitemapindex` als vorhanden. | `automated_with_limits`; reine Abwesenheit ist kontextabhaengige, scorefreie Opportunity. |
| `tech.sitemap_in_robots` | Misst, ob mindestens eine absolute, gueltige HTTP(S)-`Sitemap`-Direktive in einer nutzbaren robots.txt steht. | `fully_automated`, aber scorefreie optionale Discovery-Metadaten. |
| `tech.sitemap_urls_non_200` | Bewertet gemessene, interne Sitemap-URL-Einheiten anhand von initialem und finalem GET-Status; technische und instabile Messungen sind keine Websitefehler. | `automated_with_limits`; ein Voll-Pass verlangt vollstaendige Discovery- und Messabdeckung. |
| `tech.orphan_like_sitemap_urls` | Inventarisiert Sitemap-URLs ohne beobachteten internen Inlink nur bei vollstaendiger Sitemap- und Linkabdeckung. | `manual_review_required`, scorefrei. |
| `geo.ai_bots_policy_summary`, `geo.robots_blocks_txt_files`, `geo.robots_mentions_*` | Technisches Policy-Inventar; eine wirksame Wildcard-Regel gilt auch ohne Bot-Einzelgruppe. | `manual_review_required`; Geschaefts-, Lizenz- und Contentpolitik bleibt menschliche Entscheidung. |

Seitenbasierte `meta robots`- und `X-Robots-Tag`-Checks sind nicht Teil dieser
Familie. Ebenso sind Canonicalabweichung, `noindex` und inhaltliche
Indexierungsabsicht eigenstaendige Aussagen und werden nicht in
`sitemap_urls_non_200` hineingemischt.

## Reale Gegenpruefung

Die unabhaengige Probe verwendete serielle `curl`-GETs, getrennte
Redirectketten und einen separaten Python-XML-Parser. Der Produktparser wurde
erst danach mit denselben temporaeren Bytes verglichen.

| Domain | Archetyp | robots.txt | Sitemap-Discovery | Unabhaengig getestete Sitemap-URLs |
| --- | --- | --- | --- | ---: |
| `marcdeboer.de` | kleine statische Expertenwebsite | 200, valide, eine Sitemap-Direktive | valides `urlset`, 37 URLs | 2/37, beide 200 |
| `trinkgut-zierles.de` | hydrierte lokale Unternehmenswebsite | 200, valide, Wildcard-Regeln | valider Index; 3.250 URLs in drei geladenen Child-Dateien | 2/3.250, beide 200 |
| `react.dev` | Dokumentation / SSR-Hydration | 200, permissiv, keine Sitemap-Direktive | `/sitemap.xml` reproduzierbar 404 | nicht anwendbar |
| `web.dev` | redaktionelle Dokumentation | 200, valide | valider Index; Child-Abrufe im Messfenster timeout | keine Vollabdeckung |
| `developer.mozilla.org` | grosse mehrsprachige Dokumentation | 200, valide | valider Index und `.xml.gz`; 24.858 URLs in drei geladenen Child-Dateien | 2/24.858, beide 200 |
| `www.ikea.com` | E-Commerce | 200, mehrere Bot-Gruppen | `/sitemap.xml` 404, deklarierter `/sitemaps/sitemap.xml` valider Index; grosse Child-Dateien bewusst begrenzt | keine Vollabdeckung |
| `app.uniswap.org` | CSR-App mit XML-Discovery | 200, valide | valider Index; 5.582 URLs in drei geladenen Child-Dateien | 2/5.582, beide 200 |
| `nextjs.org` | SSR-/Hydration-Dokumentation | 200, Sitemap-Direktive | valides `urlset`, 688 URLs | 2/688, beide 200 |

Ein zusaetzlicher realer Boundary-Fall `example.com/robots.txt` lieferte 404.
Die zweite Probe aller acht robots.txt-Dateien und primaeren Sitemap-Ressourcen
reproduzierte Status, Ziel und Body-Hash. Die zwei web.dev-Child-Timeouts und
die IKEA-Groessenbegrenzung bleiben technische Abdeckungslimits; sie wurden
nicht als Websitefehler interpretiert.

Die 10 gemessenen gelisteten Real-URLs waren negative Statusfaelle. Ein
organischer, reproduzierbarer realer Positivfall fuer eine 404-/5xx- oder
Redirect-URL innerhalb einer Sitemap wurde nicht gefunden. Deshalb bleibt
`tech.sitemap_urls_non_200` trotz umfassender Fixtures konservativ
`fixture_validated`.

## Belegte Korrekturen

- Status allein reicht nicht mehr: HTML-Soft-Responses und ungueltige
  XML-Wurzeln werden nicht als Sitemap akzeptiert oder gecrawlt.
- robots.txt 404/410 wird nicht als SEO-Fehler oder Crawlblockade gewertet.
- 5xx, 429, Timeout und technische Requestfehler erzeugen ohne belastbare
  Messung keinen Website-Fail.
- Sitemap-Direktiven werden kommentarsicher extrahiert, dedupliziert und nur
  als absolute HTTP(S)-URL anerkannt. Ihre Abwesenheit ist scorefrei.
- `sitemapindex` und `urlset` werden mit einem XML-Parser statt per Regex
  unterschieden. HTML mit `<loc>`-Text kann keine URL mehr einschleusen.
- Rekursionszyklen, Child-Fehler, Duplikate, externe/ungueltige URLs sowie
  Datei-, URL- und Downloadgrenzen fliessen in eine persistierte kompakte
  Discovery-Provenienz ein.
- Das Dateibudget zaehlt Abrufversuche und nicht nur erfolgreiche Responses;
  eine Folge fehlgeschlagener Child-Abrufe kann das Sitemap-Limit daher nicht
  umgehen. Parsebare Dokumente oberhalb des 50.000-URL-Protokolllimits werden
  als Korrekturbedarf ausgewiesen.
- Gelistete Gesamtmenge, eindeutige URLs, geplante URLs, erfolgreiche
  Messungen und Sample-Strategie sind getrennt. Teilabdeckung kann keinen
  Voll-Pass erzeugen.
- Template-Sample-Quellen (`sitemap*_template_sample`) werden von Status- und
  Orphan-Auswertungen nicht mehr uebersehen.
- Orphan-like bleibt scorefrei und benoetigt vollstaendige Link- und
  Sitemap-Abdeckung plus manuelle Einordnung.
- `domain_assets.metadataJson` und `runs.sitemapDiscoveryJson` sind additive
  Felder. Alte Runs bleiben lesbar; fehlende historische Provenienz wird nicht
  erfunden.

## Run 77

Run 77 pruefte `trinkgut-zierles.de` am 17. Juli 2026. Gespeichert sind eine
valide robots.txt, ein valider Sitemap-Index, vier valide Child-Sitemaps,
1.813 entdeckte und 1.812 eingeplante Sitemap-URLs. Alle 1.812 Queue-Einheiten
endeten final mit 200.

- `tech.robots_txt_present`, `tech.sitemap_present` und
  `tech.sitemap_in_robots` sind durch die gespeicherten Bodies bestaetigt.
- Der historische Pass von `tech.sitemap_urls_non_200` kann nach heutigem
  Evidenzstandard nicht als Voll-Pass bestaetigt werden: Run 77 speicherte fuer
  diese URLs keinen initialen Status und keine versionierte
  Discovery-Abdeckung. Die finalen 200-Werte sind korrekt; die historische
  Vollstaendigkeitsaussage ist `insufficient_evidence`.
- `tech.orphan_like_sitemap_urls` hatte zwar keine beobachteten Treffer, aber
  keine versionierte Discovery-/Linkabdeckung. Die neue Rekonstruktion bleibt
  deshalb scorefrei `insufficient_evidence`.
- Die damaligen Warnungen fuer fehlende GPTBot-, OAI-SearchBot-, ClaudeBot-,
  PerplexityBot- und Google-Extended-Einzelgruppen waren False Positives. Die
  wirksame Wildcard-Regel erlaubte diese Bots; explizite Einzelgruppen sind
  optional. Die aktuelle Logik liefert `not_applicable` statt Warnungen.

Der Originalrun und die produktive Datenbank wurden nicht veraendert. Die
Rekonstruktion erfolgte in einer Kopie unter `/tmp`.

## Bekannte Grenzen

- Robots-Wildcards und Gruppen folgen `robots-parser`; abweichende
  crawler-spezifische Implementierungen koennen manuelle Gegenpruefung
  erfordern.
- Cross-Host-Sitemaps koennen legitim sein. Der Hostwechsel wird inventarisiert,
  aber nicht ohne Kontext als Defekt bewertet.
- Eine vollstaendige Statusaussage ist bei grossen Sitemaps nur mit
  ausreichendem Run-Budget moeglich. Deterministische Samples bleiben sichtbar
  als Samples.
- RSS, Atom, Text- und HTML-Sitemaps werden nicht als Ersatz fuer die hier
  validierten XML-Checks behandelt. Der aktive Check behauptet ausschliesslich
  XML-`urlset`/`sitemapindex`-Discovery.
- Sitemap-URL-Status sagt nichts allein ueber Canonical, `noindex`, Inhalt oder
  Suchintention aus.

## Regressionsnachweis

`tests/robots-sitemap-validation.test.js` deckt valide und leere robots.txt,
4xx/5xx/technische Zustande, Wildcards und Gruppen, absolute und relative
Sitemap-Direktiven, `urlset`, `sitemapindex`, Namespaces, BOM, Entities, gzip,
ungueltiges XML, HTML-Soft-Responses, Zyklen, Duplikate, Child-Fehler,
Download- und URL-Budgets, Status-/Redirectsemantik, Teilabdeckung,
Run-Isolation, additive Migration sowie Detail-/CSV-/JSON-/HTML-Paritaet ab.

Keine globale Scoringgewichtung, keine Check-Severity und kein Auditworkflow
wurde in diesem Batch geaendert. Die Ergebnislogik setzt nur belegte
check-spezifische Score- und Availability-Gates.
