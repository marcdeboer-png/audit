# Audit check validation registry v1

Stand: 19. Juli 2026. Die maschinenlesbare Registry liegt in
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
`missing_central_requirement_definition` wird ausgewiesen. Das betrifft 54
Checks und ist selbst eine priorisierte Architekturluecke; es wurde keine
Anforderung erfunden.

Validierung wurde nur dann als reale Validierung gewertet, wenn eine
unabhaengige manuelle Gegenpruefung nachvollziehbar belegt war. Blosse
Ausfuehrung in historischen Runs ist keine Validierung. Die Run-77-Domain ist
in der Registry anonymisiert; die Nutzungshaeufigkeit beruht nur auf
aggregierten Ergebniszaehlern ohne Domain- oder Inhaltsdaten.

## Aktueller Stand

| Status | Aktive Checks |
| --- | ---: |
| `cross_domain_validated` | 1 |
| `validated_with_limits` | 5 |
| `manual_review_required` | 87 |
| `single_domain_validated` | 16 |
| `fixture_validated` | 14 |
| `unvalidated` | 14 |
| `invalid` | 0 |
| `deprecated` | 0 |

Alle 137 aktiven Checks besitzen damit einen dokumentierten Status
(`status_assignment_coverage`: 100 %). Die strengere
`check_validation_coverage` zaehlt nur `cross_domain_validated`,
`validated_with_limits` und dauerhaft `manual_review_required` und liegt bei
67,88 %. Weitere Kennzahlen:

- scoregewichtete Validierungsabdeckung: 20,77 %;
- Critical-/High-Abdeckung: 11,11 % (es gibt aktuell keine als Critical
  registrierte Default-Severity und neun High-Checks);
- Primary-Evidence-Abdeckung: 38,81 %;
- nach historischer Ausfuehrungshaeufigkeit gewichtete Abdeckung: 66,47 %;
- 49 `score_capable`, 79 konditionale und neun scorefreie Checks.

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

Die 16 `single_domain_validated`-Checks stammen aus der unabhaengigen
Run-77-Forensik und den anschliessenden Regressionen. Sie gelten nicht als
domainuebergreifend bewiesen. `manual_review_required` kennzeichnet Checks,
deren Fakten automatisierbar sind, deren Schlussfolgerung aber Suchintent,
Seitentyp, Geschaeftskontext, redaktionelle Qualitaet oder einen technischen
Trade-off benoetigt. Dieser Status ist keine Behauptung vollautomatischer
Zuverlaessigkeit.

## Priorisierte Luecken

Die hoechsten offenen Risiken sind die High-Checks:

- `template.canonical_pattern_issue` ist `unvalidated` und besitzt noch keine
  zentrale Requirement-Definition;
- `tech.5xx_pages`, `tech.https_reachable`,
  `tech.internal_links_to_4xx_5xx`, `tech.json_ld_parse_errors` und
  `template.noindex_pattern` sind nur fixture-validiert;
- `template.high_lcp` und `template.low_lighthouse_performance` sind erst auf
  einer realen Domain unabhaengig validiert.

Danach folgen die unvalidierten Medium-Checks
`tech.www_non_www_consistency`, `tech.robots_txt_present`,
`tech.sitemap_present`, `tech.sitemap_urls_non_200`,
`tech.viewport_missing`, `template.high_tbt`,
`template.js_required_content` und `template.low_lighthouse_seo` sowie der
Low-Inventarcheck `tech.status_code_distribution`. Die vollstaendige Gap-Liste
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
