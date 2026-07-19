# Audit check validation registry v6

Stand: 20. Juli 2026. Die maschinenlesbare Registry liegt in
[`check-validation-registry.json`](check-validation-registry.json). Sie ist
eine interne Vertrauens- und Gap-Dokumentation. Sie aendert weder den
Auditablauf noch Scoringparameter, Check-Severities oder Kundenreports.

## Inventar und Methodik

Inventarisiert wurden die Tech-, GEO-, Trust- und Template-Registries, die
historischen `check_results` einer read-only Datenbankkopie sowie direkte
Check-ID-Referenzen in Tests, Reports, Exports und Dokumentation. Das Ergebnis
sind 137 aktive, eindeutige Check-IDs in 25 Kategorien. Die historische
Datenbank enthaelt 136 davon; `tech.synthetic_not_found_handling` ist der
einzige spaeter hinzugekommene aktive Check. Es gibt in diesem Snapshot keinen
entfernten Produktionscheck. Test-only IDs wurden nicht als historische
Checks fehlklassifiziert.

Jeder Eintrag enthaelt Inventarmetadaten, Evidence-Klasse, Coverage-Unit,
benoetigte Fakten, Datenquellen, Scope, Root-Cause-Familie, Validierungsstatus,
Evidenzreferenzen, Fehlerhistorie, bekannte Grenzen und eine konkrete
Vertrauensempfehlung. Wo ein Check seine Requirements in einem leeren Lauf
nicht zentral deklariert, bleibt `required_facts` bewusst leer und
`missing_central_requirement_definition` wird ausgewiesen. Das betrifft nach
der HTML-Head-/Heading-Validierung 28 Checks und ist selbst eine priorisierte
Architekturluecke; es wurde keine
Anforderung erfunden.

Validierung wurde nur dann als reale Validierung gewertet, wenn eine
unabhaengige manuelle Gegenpruefung nachvollziehbar belegt war. Blosse
Ausfuehrung in historischen Runs ist keine Validierung. Kundendomains bleiben
anonymisiert; die vom Nutzer selbst benannte oeffentliche Run-77-Domain ist nur
in der HTTP-Validierungsfamilie genannt. Die Nutzungshaeufigkeit beruht nur auf
aggregierten Ergebniszaehlern ohne Domain- oder Inhaltsdaten.

## Aktueller Stand

| Status | Aktive Checks |
| --- | ---: |
| `cross_domain_validated` | 7 |
| `validated_with_limits` | 13 |
| `manual_review_required` | 93 |
| `single_domain_validated` | 9 |
| `fixture_validated` | 8 |
| `unvalidated` | 7 |
| `invalid` | 0 |
| `deprecated` | 0 |

Alle 137 aktiven Checks besitzen damit einen dokumentierten Status
(`status_assignment_coverage`: 100 %). Die strengere
`check_validation_coverage` zaehlt nur `cross_domain_validated`,
`validated_with_limits` und dauerhaft `manual_review_required` und liegt bei
82,48 %. Weitere Kennzahlen:

- scoregewichtete Validierungsabdeckung: 44,76 %;
- Critical-/High-Abdeckung: 33,33 % (es gibt aktuell keine als Critical
  registrierte Default-Severity und neun High-Checks);
- Primary-Evidence-Abdeckung: 60,38 %;
- nach historischer Ausfuehrungshaeufigkeit gewichtete Abdeckung: 84,12 %;
- 40 `score_capable`; `tech.redirect_pages` ist nach der HTTP-Validierung ein
  scorefreies Inventar und kein eigenstaendiger Defekt.

Die scoregewichtete Registry-Kennzahl ist kein Audit-Score. Sie verwendet nur
die bestehenden Severity-Gewichte als Priorisierungsfaktor, gewichtet
konditionale Schlussfolgerungen mit 0,25 und scorefreie Inventare mit 0. Es
wurde kein Scoringparameter des Produkts veraendert.

## Belastbare Familien und Grenzen

`tech.synthetic_not_found_handling` ist nach der unten beschriebenen
Realvalidierung `cross_domain_validated`. Die Raw-/Rendered-Familie
`tech.critical_content_raw_html_signal`, `tech.js_dependent_content`,
`tech.raw_h1_missing_rendered_present`,
`tech.raw_internal_links_fewer_rendered` und
`tech.rendered_word_count_delta` ist aufgrund der acht Domain-Benchmarks
`validated_with_limits`. Ihr verbleibendes Limit sind bislang unbekannte
Client-Renderingmuster sowie technisch schwankende Browser- und
Netzwerkantworten.

Die 14 `single_domain_validated`-Checks stammen aus der unabhaengigen
Run-77-Forensik und den anschliessenden Regressionen. Sie gelten nicht als
domainuebergreifend bewiesen. `manual_review_required` kennzeichnet Checks,
deren Fakten automatisierbar sind, deren Schlussfolgerung aber Suchintent,
Seitentyp, Geschaeftskontext, redaktionelle Qualitaet oder einen technischen
Trade-off benoetigt. Dieser Status ist keine Behauptung vollautomatischer
Zuverlaessigkeit.

## Priorisierte Luecken

Die hoechsten offenen Risiken sind die verbleibenden High-Checks:

- `tech.5xx_pages`, `tech.internal_links_to_4xx_5xx`,
  `tech.json_ld_parse_errors` und
  `template.noindex_pattern` sind nur fixture-validiert;
- `template.high_lcp` und `template.low_lighthouse_performance` sind erst auf
  einer realen Domain unabhaengig validiert.

Danach folgen die unvalidierten Medium-Checks
`tech.viewport_missing`, `template.high_tbt`,
`template.js_required_content` und `template.low_lighthouse_seo` sowie der
verbleibenden unvalidierten Checks. Die HTTP-Familie ist in
[`http-status-check-validation-v1.md`](http-status-check-validation-v1.md)
dokumentiert; insbesondere bleibt `tech.5xx_pages` ohne organischen realen
Positivfall konservativ fixture-validiert. Die vollstaendige Gap-Liste
steht je Check in `validation_gap` und nennt fehlende Positiv-/Negativfaelle,
Archetypen, Fixture, unabhaengige Methode, Aufwand und Risiko.

## Vertrauenspolicy

- `cross_domain_validated` bleibt aktiv.
- `validated_with_limits` bleibt mit sichtbarer Limitierung aktiv.
- `manual_review_required` wird vor einer fachlichen Priorisierung manuell
  eingeordnet.
- `single_domain_validated` und `fixture_validated` bleiben diagnostisch und
  erhalten einen klaren Validierungsvorbehalt.
- `unvalidated` erhaelt `validation_required_score_free` als Empfehlung und
  darf nicht als still voll vertrauenswuerdig gelten. Dieser Batch deaktiviert
  solche Checks nicht pauschal.
- `invalid` muss scorefrei sein; die Registry-Pruefung lehnt eine
  scorewirksame `invalid`-Konfiguration ab.
- `deprecated` darf nicht mehr in der aktiven Registry vorkommen.

Das langfristige 100-%-Ziel ist erst erreicht, wenn jeder scorewirksame Check
mindestens `cross_domain_validated` oder `validated_with_limits` ist, dauerhaft
kontextabhaengige Checks `manual_review_required` sind und kein aktiver
scorewirksamer Check `unvalidated`, `invalid` oder nur `fixture_validated`
bleibt.

## First validated group

Als erste Gruppe wurde der High-Check
`tech.synthetic_not_found_handling` gewaehlt. Er adressiert unmittelbar die
kritische Run-77-Luecke und benoetigt nur sichere GET-Anfragen.

Die unabhaengige Methode verwendete `curl` mit zwei verschiedenen Nonce-
Runden und je vier unbekannten URL-Formen (Root, verschachtelt, realistische
Dateiendung und Query) auf drei oeffentlichen Archetypen:

| Domain / Archetyp | Probes | Manueller Befund | Checkbefund |
| --- | ---: | --- | --- |
| marcdeboer.de / kleine statische Expertenwebsite | 8 | achtmal 404, keine Weiterleitung | Pass |
| react.dev / hydrierte Dokumentation | 8 | achtmal final 404, teils kanonischer 308-Slash-Redirect | Pass |
| app.uniswap.org / CSR-App | 8 | achtmal 200 mit Startseitentitel | High-Fail (`soft_404_http_200`) |

Body-Laenge, Titel, SHA-256-Fingerprint, Content-Type, finaler Status und
Redirect-Kette wurden verglichen; vollstaendige Bodies wurden nicht
beibehalten. Der produktive Check wurde danach separat ausgefuehrt und stimmte
in allen 24 Faellen mit der `curl`-Wahrheit ueberein. Es gab null False
Positives, null False Negatives, keinen Severity- und keinen Scope-Fehler.
Die bestehenden Fixtures decken 404, 410, Soft-404/200,
Startseitenweiterleitung, 5xx, Redirect-Schleife, Netzwerkfehler,
benutzerdefinierte 404-Seite sowie verschachtelte und dateiaehnliche Pfade ab.
Eine Checklogikaenderung war daher nicht begruendet.

## Konsistenzpruefung

```bash
npm run validate:check-registry
```

Der Befehl prueft aktive Registry-Paritaet, Duplikate, Statuswerte,
Pflichtfelder, die strengen Cross-Domain-Regeln, manuelle Begruendungen,
`invalid`/Scoring-Schutz, `deprecated`-Semantik und Summary-Zaehler. Ein neuer
aktiver Check ohne Registry-Eintrag laesst die Pruefung fail-closed
fehlschlagen. Registry-Snapshot, Basis-Commit und Checklogikversion bleiben
dadurch nachvollziehbar.

Bekannte Grenze: Die Registry dokumentiert den belegten Stand. Sie ersetzt
weder eine neue manuelle Validierung nach wesentlichen Logikaenderungen noch
den Nachweis bislang unbekannter Websiteimplementierungen.

## Canonical validation group

Die zweite Validierungsgruppe umfasst `tech.canonical_missing`,
`tech.canonical_non_self`, `tech.canonical_to_other_domain`,
`tech.canonical_target_non_200` und `template.canonical_pattern_issue`.
Methodik, reale Positiv-/Negativfaelle, Run-77-Rekonstruktion, Korrekturen und
Grenzen stehen in
[`canonical-check-validation-v1.md`](canonical-check-validation-v1.md).

`tech.canonical_missing` ist nach realen positiven Faellen auf Aave und
Next.js, dem gerenderten Uniswap-Gegenfall und negativen Faellen auf mehreren
Archetypen `cross_domain_validated`. Non-Self, Fremddomain und Pattern sind
bewusst `manual_review_required` und scorefrei: Ihre technischen Fakten sind
messbar, die Fehleraussage benoetigt aber Konsolidierungs-, Syndication- oder
Migrationskontext. `tech.canonical_target_non_200` bleibt konservativ
`fixture_validated`, bis ein realer positiver Zielstatusfall unabhaengig
beobachtet wurde.

## Robots and sitemap validation group

Die Robots-/Sitemap-Gruppe umfasst `tech.robots_txt_present`,
`tech.sitemap_present`, `tech.sitemap_in_robots`,
`tech.sitemap_urls_non_200`, `tech.orphan_like_sitemap_urls` sowie die
eng verwandten GEO-Policy-Inventare. Methodik, acht reale Architekturen,
Run-77-Rekonstruktion, Korrekturen und Grenzen stehen in
[`robots-sitemap-check-validation-v1.md`](robots-sitemap-check-validation-v1.md).

`tech.sitemap_in_robots` ist als rein technische, scorefreie
Discovery-Aussage `cross_domain_validated`. `tech.robots_txt_present` und
`tech.sitemap_present` sind `validated_with_limits`: reale gueltige und
Abwesenheitsfaelle sind domainuebergreifend belegt, waehrend organische
200-HTML- beziehungsweise defekte deklarierte Positivfaelle noch fehlen.
`tech.sitemap_urls_non_200` bleibt ohne organischen realen Redirect-/4xx-/5xx-
Positivfall konservativ `fixture_validated`. Orphan- und Bot-Policy-Aussagen
bleiben wegen Architektur- beziehungsweise Geschaeftskontext
`manual_review_required`.

Die fruehere Run-77-Anforderung expliziter Bot-Einzelgruppen war falsch: Eine
wirksame Wildcard-Regel reicht technisch aus. Fehlende Einzelgruppen erzeugen
heute kein Finding. robots.txt-Abwesenheit ist ebenfalls keine Crawlblockade,
und optionale Sitemap-Deklarationen sind scorefrei. Bot-Einzelinventare und
die Frage, ob Textressourcen absichtlich blockiert werden, bleiben ebenfalls
scorefrei, weil ihre Bewertung eine Geschaefts- und Contentpolitik voraussetzt.

## Structured-data validation group

Die Structured-Data-Gruppe umfasst `tech.json_ld_parse_errors`,
`tech.article_coverage_on_article_like_pages`,
`geo.article_blog_pages_article_schema`,
`tech.product_coverage_on_product_like_pages`, das Schematyp-Inventar und die
eng verwandten manuellen Opportunities. Methodik, 15 reale Architekturen,
Run-77-Rekonstruktion, Korrekturen und Grenzen stehen in
[`structured-data-check-validation-v1.md`](structured-data-check-validation-v1.md).

Article- und Product-Coverage sind `validated_with_limits`: reale Missing- und
Presence-Faelle sind domainuebergreifend belegt, die Seite muss fuer einen
normalen Fail jedoch mit hoher Confidence als Detailseite klassifiziert sein.
Die GEO-Article-Perspektive teilt Root Cause und Coverage-Unit, ist scorefrei
und bleibt reviewpflichtig. Das Schematyp-Inventar ist scorefrei und
`validated_with_limits`.

`tech.json_ld_parse_errors` bleibt trotz 39 realen Negativfaellen und breiter
Fixture-Abdeckung konservativ `fixture_validated`, weil kein organischer
oeffentlicher Syntaxfehler beobachtet wurde. Browser-/Extraktionsfehler werden
nun technisch getrennt. Neue Runs speichern kompakte Block-/Entityprovenienz,
aber keine vollstaendigen fremden JSON-LD-Bodys.

## HTML head and heading validation group

Die HTML-Head-/Heading-Gruppe umfasst 15 aktive Checks fuer Title, Meta
Description, H1, Sprache, Duplicate-Gruppen, Raw-/Rendered-Differenzen und
Template-Patterns. Methodik, 15 reale Hauptdomains, zusaetzliche oeffentliche
Grenzfaelle, Run-77-Rekonstruktion, Korrekturen und Grenzen stehen in
[`html-head-heading-check-validation-v1.md`](html-head-heading-check-validation-v1.md).

`tech.title_missing` und `tech.html_lang_missing` sind nach wiederholten realen
positiven und negativen Implementierungen `cross_domain_validated`. Die
Sprachaussage bleibt strikt auf das fehlende Attribut begrenzt.
`tech.raw_h1_missing_rendered_present` bleibt als scorefreie Diagnose
`validated_with_limits`.

Description-, H1-, Multiple-, Duplicate-, Laengen- und Patternchecks sind
`manual_review_required`. Ihr objektiver Faktenteil wurde gehaertet, ihre
fachliche Prioritaet benoetigt aber Seitentyp-, Intent- oder
Konsolidierungskontext. Fehlende Description, fehlende oder mehrere H1 und
reine Raw-/Rendered-H1-Differenzen sind Low und scorefrei. Duplicate-Gruppen
verwenden nun denselben effektiven, canonical- und indexability-bereinigten
Population- und Normalisierungspfad in Finding, Detailansicht und Export.
