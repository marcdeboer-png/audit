# Local SEO & GEO Audit

Ein lokales Audit-Tool fuer automatisierbare technische SEO- und GEO-Readiness-Pruefpunkte. Eine Domain wird lokal gecrawlt, Messdaten werden inkrementell in SQLite gespeichert, deterministische Checks laufen nur auf gespeicherten Daten und ein HTML-Report dokumentiert Findings mit Evidence.

## Installation

```bash
npm install
```

Playwright wird als Dependency installiert. Falls Chromium auf deinem System noch fehlt:

```bash
npx playwright install chromium
```

Playwright- und Lighthouse-Sampling sind optional. Lighthouse wird lokal ausgefuehrt, wenn die entsprechenden Node-Pakete und ein lokaler Chromium/Chrome verfuegbar sind; es wird keine PageSpeed-Insights-API genutzt.

```bash
npm install lighthouse chrome-launcher
```

## Start

```bash
npm run dev
```

Die UI laeuft standardmaessig unter `http://localhost:3000`.

Der SQLite-Pfad ist konfigurierbar. Ohne Environment Variable nutzt die App weiter `data/audit.sqlite`.

```bash
AUDIT_DB_PATH=data/audit.sqlite npm run dev
AUDIT_DB_PATH=/tmp/audit-test.sqlite npm test
```

## CLI

```bash
npm run audit -- --domain example.com --maxUrls 5000 --maxDepth 4 --type both
```

Weitere Optionen:

```bash
npm run audit -- --domain example.com --brandName "Example" --concurrency 2 --respectRobotsTxt true
```

Batch-2 Crawl-Optionen:

```bash
npm run audit -- --domain example.com --crawlMode hybrid --includePatterns blog,ratgeber --excludePatterns /tag/,/author/ --crawlDelayMs 100 --requestTimeoutMs 15000 --usePlaywright false --playwrightMode off
```

`crawlMode` kann `hybrid`, `sitemap_only`, `internal_links_only` oder `template_sample` sein. `template_sample` gruppiert Sitemap-URLs vor dem Queuing nach URL-Template und crawlt nur einen kleinen Querschnitt pro Pattern. Playwright ist standardmaessig aus (`usePlaywright false`, `playwrightMode off`), damit Chromium optional bleibt.

Browser-Laufzeitmessung und deterministische Budgets sind in [docs/render-runtime-benchmark-v1.md](docs/render-runtime-benchmark-v1.md) dokumentiert. Die domainunabhaengige Praezisierung von `render_recommended`, explizite positive und negative Signale, check-getriebene Mindestmessungen sowie der kontrollierte 50-URL-Vergleich stehen in [docs/render-gate-calibration-v2.md](docs/render-gate-calibration-v2.md). Fuer einen expliziten zweistufigen Renderplan kann `--usePlaywright true --playwrightMode gate` verwendet werden. `--metricsMode basic` sammelt leichte Laufzeit- und Zaehlerdaten; `profiling` aktiviert zusaetzlich Prozessspeicher-Sampling. Budgetausschluesse und absichtlich nicht erhobene optionale Browserdiagnostik bleiben als fehlende Render-Evidenz sichtbar und werden nicht als Pass interpretiert.

Crawler-Identitaet und Geschwindigkeit:

```bash
npm run audit -- --domain example.com --userAgent "OMfireAuditBot/0.1 (+https://example.com/bot)" --robotsUserAgent OMfireAuditBot --targetPagesPerSecond 1
```

`targetPagesPerSecond` begrenzt globale Request-Starts. `concurrency`, `maxConcurrentPerHost` und `crawlDelayMs` bleiben zusaetzliche Sicherheitsbremsen.

Batch-3 Stabilitaetsoptionen:

```bash
npm run audit -- --domain example.com --concurrency 3 --maxConcurrentPerHost 2 --maxAttempts 3 --retryBaseDelayMs 1000 --retryMaxDelayMs 30000
```

Retrybare HTTP-Status sind `408`, `429`, `500`, `502`, `503` und `504`; Netzwerkfehler werden ebenfalls erneut versucht. `404` und `403` werden nicht retryt.

Batch-4 Sitemap- und Sampling-Optionen:

```bash
npm run audit -- --domain example.com --maxSitemaps 100 --maxSitemapUrls 50000 --sitemapBatchSize 1000 --sampleUrlsPerTemplate 5 --maxTemplateSamplesTotal 200
```

`maxSitemapUrls` ist optional. Wenn es nicht gesetzt ist, begrenzen `maxUrls` und die Queue-Deduplizierung den Crawl.

Large-Audit-Hinweis: `maxUrls` ist kein hartes 500er-Limit. Die App kann groessere Werte speichern und abarbeiten, aber 50.000+ URLs sind aktuell nicht als garantiert stabiler Full-Audit-Arbeitsmodus validiert. Kritische Punkte sind SQLite-Groesse, gespeicherte HTML-/Resource-Daten, Full ZIP/JSON im Speicher, statische Reports und Playwright/Lighthouse-Laufzeit. Fuer grosse Domains besser zuerst 5.000-10.000 URLs testen, `respectRobotsTxt` aktiv lassen, niedrige Host-Parallelitaet nutzen und teure Render-/Lighthouse-Pruefungen nur ueber Template-Sampling laufen lassen.

Batch-6 Template-Sampling-Optionen:

```bash
npm run audit -- --domain example.com --enableTemplateSampling true --enablePlaywrightSampling false --enableLighthouseSampling false --sampleUrlsPerTemplate 5 --maxTemplateSamplesTotal 200
```

Playwright-Sampling laeuft nur auf repraesentativen Template-Samples:

```bash
npm run audit -- --domain example.com --enablePlaywrightSampling true --playwrightTimeoutMs 30000 --collectScreenshots false
```

Lighthouse-Sampling ist lokale Lab-Messung auf Template-Samples:

```bash
npm run audit -- --domain example.com --enableLighthouseSampling true --lighthouseDevice mobile --lighthouseCategories performance,accessibility,best-practices,seo --lighthouseTimeoutMs 60000
```

Falls Chromium fehlt:

```bash
npx playwright install chromium
```

Sampling-Grenzen: Samples sind repraesentativ, aber keine vollstaendige Messung jeder URL. Lighthouse liefert lokale Lab-Daten, keine CrUX-/Field-Daten. Grosse Domains sollten Template-Sampling nutzen, damit teure Render-/Performance-Pruefungen nicht pro URL laufen.

## UI

Die Startseite enthaelt ein Audit-Formular und bisherige Runs. Die Run-Detailansicht zeigt Phase, Fortschritt, aktuelle URL, Crawling-Raten, Health, Heartbeat, Worker Count, Waiting URLs, Retry-Failures, Logs sowie Pause, Resume, Recover und Cancel. Die Results-Ansicht enthaelt Scorecards, Filter, Findings und ein paginiertes URL-Inventar.

CSV-Downloads stehen nach einem Run in der UI und per API bereit:

- `/api/audits/:runId/export/findings.csv`
- `/api/audits/:runId/export/score-root-causes.csv`
- `/api/audits/:runId/export/pages.csv`
- `/api/audits/:runId/export/links.csv`
- `/api/audits/:runId/export/images.csv`
- `/api/audits/:runId/export/resources.csv`
- `/api/audits/:runId/export/schemas.csv`
- `/api/audits/:runId/export/geo-signals.csv`
- `/api/audits/:runId/export/reviews.csv`
- `/api/audits/:runId/export/samples.csv`
- `/api/audits/:runId/export/playwright-results.csv`
- `/api/audits/:runId/export/lighthouse-results.csv`
- `/api/audits/:runId/export/template-performance.csv`
- `/api/audits/:runId/export/templates.csv`
- `/api/audits/:runId/export/status-summary.csv`

Weitere Run-Aktionen:

- `POST /api/audits/:runId/pause`
- `POST /api/audits/:runId/resume`
- `POST /api/audits/:runId/recover`
- `POST /api/audits/:runId/cancel`
- `DELETE /api/audits/:runId`

`GET /api/audits` und `GET /api/audits/:runId` liefern zusaetzlich `healthStatus`, `heartbeatAt`, `lockedAt`, `workerCount`, `waitingUrls`, `retryableFailures`, `permanentFailures`, `oldestProcessingAgeSeconds` und `oldestPendingAgeSeconds`.

Template-/URL-Cluster stehen hier bereit:

- `GET /api/audits/:runId/templates`
- `GET /api/audits/:runId/templates/:clusterId/pages`

Review- und Sampling-Daten stehen hier bereit:

- `GET /api/audits/:runId/reviews`
- `GET /api/audits/:runId/review-summary`
- `POST /api/audits/:runId/check-results/:checkResultId/review`
- `DELETE /api/audits/:runId/check-results/:checkResultId/review`
- `POST /api/audits/:runId/reviews/bulk`
- `GET /api/audits/:runId/samples`
- `GET /api/audits/:runId/playwright-results`
- `GET /api/audits/:runId/lighthouse-results`
- `GET /api/audits/:runId/template-performance`

Run-Vergleiche stehen in der Run-Detailansicht und per API bereit:

- `GET /api/audits/:runId/comparison-candidates`
- `POST /api/audits/compare` mit `baseRunId`, `compareRunId` und optional `save: true`
- `GET /api/audits/comparisons/:comparisonId`
- `GET /api/audits/:runId/comparisons`
- `GET /api/audits/compare/report?baseRunId=:baseRunId&compareRunId=:compareRunId`
- `GET /api/audits/comparisons/:comparisonId/report`
- `GET /api/audits/compare/export/findings-delta.csv?baseRunId=:baseRunId&compareRunId=:compareRunId`
- `GET /api/audits/compare/export/url-delta.csv?baseRunId=:baseRunId&compareRunId=:compareRunId`
- `GET /api/audits/compare/export/template-delta.csv?baseRunId=:baseRunId&compareRunId=:compareRunId`
- `GET /api/audits/compare/export/performance-delta.csv?baseRunId=:baseRunId&compareRunId=:compareRunId`

Vergleiche sind fuer abgeschlossene Runs derselben normalisierten Domain gedacht. Bei unterschiedlichen Domains liefert die Vergleichslogik `status: not_comparable` mit Warning statt abzustuerzen. Deltas sind deterministisch und basieren nur auf gespeicherten Run-Daten; sie schreiben keine neuen normalen `check_results`.

## HTML Report

Der HTML-Report startet mit Score Cards und einer handlungsorientierten Executive Summary. Danach folgen Action Items, Confirmed / Needs Fix Findings, GEO Opportunities, Security Best Practices, Media Findings, Template Performance & Rendering, Run Comparison, Review Summary, Technical Appendix, Passed Checks, Not Applicable Checks und All Findings.

Action Items sind priorisierte technische SEO-Probleme mit direkter Relevanz fuer die Hauptbewertung. GEO Opportunities sind optionale Verbesserungen und werden nicht wie harte Fehler dargestellt. Security Best Practices, Media Findings und Template Performance haben eigene Report-Bereiche, damit sie die Core-Findings nicht ueberladen. OK-Findings und rein informative NA-Findings gelten standardmaessig als `not_required` und zaehlen nicht als offene Review-Aufgabe.

Evidence und Samples bleiben im Report verfuegbar, werden aber in einklappbaren `<details>`-Bereichen angezeigt. So bleibt der Report auditierbar, ohne dass Raw JSON die Lesbarkeit dominiert. Sampling-Status unterscheidet `disabled`, `unavailable`, `partial` und `completed`; bei deaktiviertem oder nicht verfuegbarem Playwright/Lighthouse zeigt der Report kurze Reason/Fix-Hinweise und Rohfehler nur in CSV oder Debug-Details.

Scores schliessen optionale unavailable Sampling-Checks aus und gewichten Security Best Practices und GEO Opportunities niedriger als Core SEO Issues. Dadurch kann ein hoher Score sinnvoll neben Low-Priority-Opportunities stehen.

### Evidence-Gates, 404-Test und Score-Erklaerung

Der Live-Audit fuehrt waehrend der aktiven Check-Phase einen kleinen synthetischen Not-Found-Test aus. Er sendet ausschliesslich fuenf lesende GET-Requests: einen Homepage-Request als Vergleich sowie vier eindeutige Nonce-URLs (Root-Pfad, verschachtelter Pfad, dateiaehnlicher Pfad und Query-Variante). Admin-, Login-, API- oder Security-Pfade werden nicht verwendet. Erwartet werden `404` oder ein bewusstes `410`; `200`, Weiterleitungen auf regulaere Inhalte, Redirect-Schleifen und `5xx` werden getrennt bewertet. Netzwerk-, Firewall- oder instabile Antworten ergeben `technical_error` und keinen Website-Fehler. Gespeichert werden Status, Redirect-Kette, Header-Auswahl, Laenge, Titel, Hash, kurzer Auszug und Homepage-Aehnlichkeit, aber kein vollstaendiger Response-Body. Import-Runs und spaetere reine Report-Neuberechnungen loesen keine neuen Live-Requests aus.

Checks koennen die Bewertungszustaende `pass`, `fail`, `not_applicable`, `insufficient_evidence`, `not_executed` und `technical_error` speichern. Die letzten vier Zustaende sind nicht scorefaehig. Leerer String, `0` und `false` bleiben beobachtete Werte. `null` und `undefined` gelten im gemeinsamen Gate als nicht erhoben; wenn `null` selbst ein fachlicher Messwert sein soll, muss der Check dies ueber ein separates Presence-/Status-Faktum ausdruecken. Jeder angepasste Check weist benoetigte und optionale Fakten, fehlende Fakten, Mindestabdeckung, Wiederholbarkeit per Targeted Run und Ausschlussgrund aus.

Die interne Suchseiten-Erkennung kombiniert URL-Pfad oder Suchparameter mit Resultat-Ueberschrift/-Text, Main-Content-Suchformular, Ergebnisliste und optional `SearchAction`. Ein Suchfeld im globalen Header, ein einzelner `q`-Parameter, Kategorie-/Tag-/Autorenarchive, Glossare und Filterseiten reichen nicht. Widerspruechliche Signale ergeben `insufficient_evidence`; die erkannten positiven und widersprechenden Signale stehen in der Evidence.

Neue Runs verwenden das versionierte Modell `root-cause-scoring-v3` mit `deterministic-root-cause-v1`, `evidence-class-coverage-v3`, `evidence-availability-v1` und `calibration-v3`. Ein Finding ist eine Check-Perspektive, ein Vorkommen ist eine gemessene betroffene Stelle und ein Root Cause ist die deterministisch belegte gemeinsame technische Ursache. Die Zuordnung verwendet zuerst explizite `rootCauseKey`-Werte, danach enge Regeln pro Check-Familie und fuehrt bei Unsicherheit keine Cross-Check-Zusammenfuehrung durch. Gleiche Empfehlungen allein sind kein Deduplizierungsgrund. `technical_error` erzeugt keinen Website-Root-Cause.

Severity-Abzuege sind zentral mit Critical `30`, High `14`, Medium `5` und Low `1` kalibriert. Confidence wirkt nur abschwaechend (`high=1`, `medium=0.7`, `low=0`); Low Confidence bleibt damit scorefrei. Der Mengenfaktor ist logarithmisch: `min(2, (1 + 0.25 * log10(max(1, affected_url_count))) * scope_type_multiplier)`. Dadurch bleiben 1, 10, 100 und 1.000 URLs unterscheidbar, ohne URL-Anzahlen linear zu bestrafen. Optionale Low-Root-Causes sind zusammen auf fuenf Scorepunkte begrenzt. Die Kategorie-Caps betragen je nach Familie 35 (Technical), 30 (Crawling), 25 (HTML/Meta), 20 (Structured Data und Performance), 15 (Media, Content, Accessibility, Security und Other) beziehungsweise 12 (GEO); Roh- und angewandte Abzuege stehen im Breakdown.

Coverage v3 klassifiziert die geplante Evidenz als `primary_required`, `primary_conditional`, `secondary_diagnostic`, `optional_opportunity` oder `inventory`. Ausfuehrung, Evidenzverfuegbarkeit, fachliche Evaluation und Coverage-Status werden getrennt gespeichert. Der Headline-Status folgt der Primary Coverage: ab 80 Prozent `final`, von 60 bis unter 80 Prozent `provisional`, darunter `insufficient_coverage`; eine stark unvollstaendige kritische Kategorie kann `final` auf `provisional` begrenzen. Fehlende erforderliche Evidenz und technische Fehler bleiben uncovered und scorefrei. Nicht anwendbare konditionale Checks und bewusst ausgelassene optionale Browserdiagnostik fallen aus dem Primaernenner, ohne einen stillen Pass zu erzeugen.

Coverage wird ueber stabile `coverageUnitKey`-Einheiten aggregiert. Gleichwertige Tech-/GEO-Perspektiven, URL-/Template-Roll-ups oder wiederholte Check-Ausfuehrungen koennen damit dieselbe fachliche Evidenzeinheit nur einmal in den Nenner einbringen. Primary, Diagnostic und Inventory Coverage sowie Kategorie-Coverage werden getrennt ausgegeben; die gewichtete Gesamt-Coverage bleibt als zusaetzliche Diagnose sichtbar. Deaktivierte Module zaehlen nicht als geprueft. Budget- oder Browserausfaelle senken Primary Coverage nur dann, wenn Rendering fuer die Kernaussage erforderlich war. `summary/scores.json`, Coverage-Unit-CSV, Finding-/Detail-Export und HTML-Report verwenden denselben persistierten Score-Snapshot.

Die Methodik, Ergebnisse und Grenzen der domainuebergreifenden Kalibrierung sind in [docs/scoring-calibration-v3.md](docs/scoring-calibration-v3.md) dokumentiert. Die dort genannten Live-Scores sind zeitgebundene Benchmark-Messungen, keine dauerhafte Bewertung der Websites.
Evidence-Klassen, Browser-Availability, Coverage-Units und die 50-URL-Kalibrierung sind in [docs/evidence-class-coverage-v3.md](docs/evidence-class-coverage-v3.md) beschrieben.

Scoring-, Deduplizierungs-, Coverage- und Check-Logikversion werden pro neuem Run gespeichert. Historische Runs ohne diese Angaben bleiben ungeclustert und verwenden ihren nachweisbaren Legacy-Aggregator; fehlende Versionsangaben werden als unbekannt angezeigt. Das Oeffnen eines historischen Reports persistiert keine neue Bewertung. Eine explizite Rekonstruktion muss auf einer Kopie erfolgen und darf nie als Originalscore bezeichnet werden.

Finding-Daten trennen additiv `facts`, `evidence`, `assessment` und `recommendationMeta`. Fakten sind Messwerte, Evidence beschreibt Quelle und Zeitpunkt, Assessment enthaelt Interpretation und Gueltigkeitsbedingungen, und die Empfehlung bleibt eine Handlungsempfehlung. Bestehende Textfelder bleiben fuer Kompatibilitaet erhalten.

### Run-Isolation, Provenienz und sichtbarer Text

Alle Ergebnis-, Detail-, Report- und Exportpfade verlangen eine explizite `run_id`; Repository-Aufrufe fuer Run-Ergebnisse arbeiten fail-closed, wenn dieser Scope fehlt. Zusammengesetzte dynamische SQL-Bedingungen werden als eigene Klammergruppe an den Run-Filter gebunden, damit ein `OR` den Scope nicht umgehen kann. Vor der Check-Ausfuehrung werden `run_id`, `project_id` und das erlaubte Host-Set validiert. Eine als intern klassifizierte Fremddomain ist ein technischer Integritaetsfehler (`technical_error`) und kein Website-Finding. Externe Linkziele duerfen als externe Evidenz existieren, werden aber nicht als eigene interne Seite aggregiert. Auch bereits gespeicherte Altbefunde mit fremder interner Evidenz werden beim Lesen scorefrei als Integritaetsfehler dargestellt; die Fremdevidenz wird nicht erneut ausgegeben.

Neue Runs speichern additiv Runtime-Provenienz: Run/Projekt, Audit-Typ, primaerer Host, Erhebungs- und Bewertungszeit, Collector/Extraktor, Check-ID und -Version, Git-/Build-Version, stabilen Konfigurations-Hash, Raw-/Rendered-Modus, Messversuch und Availability-Status. Diese Daten sind in der Check-Detailansicht und im JSON-Export verfuegbar. Alte Runs bleiben lesbar; nicht gespeicherte historische Provenienz wird als nicht vorhanden angezeigt und nicht rekonstruiert oder erfunden. Cookies, Zugangsdaten und vollstaendige Bodies gehoeren nicht zur Provenienz.

`visible_text` verwendet fuer Raw HTML und gerenderten DOM dieselbe versionierte Normalisierung (`visible_text_v1`). Inhalte aus `head`, `script`, JSON-LD/Hydration, `style`, `noscript`, `template`, SVG, geschlossenen Dialogen/Details-Inhalten sowie eindeutig versteckten oder `aria-hidden` Elementen werden nicht als sichtbarer Seitentext gewertet. Der Browserpfad beruecksichtigt zusaetzlich berechnetes `display`, `visibility`, `content-visibility`, `checkVisibility` und offenen Shadow DOM. `raw_text`, `visible_text`, `rendered_visible_text`, `structured_data_text` und `metadata_text` bleiben semantisch getrennt. Autor- und Datumssignale benoetigen sichtbare, lokal zuordenbare Byline-/`time`-Signale; Vorkommen in Script-JSON gelten nur als strukturierte Evidenz.

Availability-Gates unterscheiden einen beobachteten leeren oder nullwertigen Messwert (`''`, `0`, `false`) von einer nicht erhobenen Messung (`null`/fehlendes Feld, je nach Faktenvertrag). Ressourcenchecks benoetigen eine belastbare Bytequelle und weisen Messart, Transfer-/Ressourcengroesse, Bildscope und Teilabdeckung aus. Eine fehlende `Content-Length` oder ein fehlgeschlagener Download ist kein Null-Byte-Pass. TTFB wird erst mit mindestens drei erfolgreichen Nicht-Warm-up-Messungen pro URL, konsistentem Messmodus/-ort und robuster Medianbildung fachlich bewertet; eine Crawl-Einzelmessung ergibt `insufficient_evidence`. Lighthouse-/Browserchecks verlangen erfolgreiche Navigation, die erwartete Sample-URL, ein bekanntes Device, die konkrete Metrik und mindestens zwei vollstaendige Samples pro Template. Nicht bewertbare Zustaende bleiben scorefrei.

Interne Links speichern den urspruenglich verlinkten Wert, initialen HTTP-Status, Redirect-Kette, finale URL und finalen Status getrennt. Ein interner `301`, `302`, `307` oder `308` bleibt deshalb als Redirect-Link erkennbar, auch wenn das finale Ziel `200` liefert. Vorkommen und eindeutige Redirect-Ziele werden separat gezaehlt; Query und Fragment bleiben in der Linkevidenz erhalten.

Historische Neuberechnungen koennen nur Fakten verwenden, die der damalige Lauf gespeichert hat. Neue Spalten und Provenienz machen alte Runs nicht rueckwirkend vollstaendiger. Fehlen beispielsweise initiale Redirect-Status, Resource-Bytes oder gerenderte Messungen, muss die Neuberechnung `insufficient_evidence` beziehungsweise `historical_state_unknown` ausweisen, statt heutige Daten als damalige Wahrheit darzustellen.

### Raw-/Rendered-Dokumentzustand und CSR-Settling

Neue Browserlaeufe speichern Metadaten und Content-Fakten getrennt fuer Raw-HTML, den ersten DOM-Snapshot und den begrenzt stabilisierten DOM-Snapshot. Erfasst werden Title, Meta Description, Canonical, `lang`, Robots, hreflang, Open Graph, Twitter Cards, H1, normalisierte sichtbare Textfakten, interne Links und strukturierte Datentypen. Vollstaendige Response-Bodys werden dafuer nicht dauerhaft gespeichert. Der effektive Dokumentzustand nutzt einen stabilen Render-Snapshot, wenn dieser vorliegt; andernfalls bleibt Raw-HTML die belegte Quelle. Ein gestartetes, aber instabiles oder technisch fehlgeschlagenes Rendering darf dadurch keinen gerenderten Pass erzeugen.

Das Settling wartet nicht auf `networkidle`. Nach `domcontentloaded` werden semantische Fingerprints in festen Intervallen verglichen. Defaults: maximal 6 Sekunden, 500 ms Intervall, hoechstens 13 Snapshots, drei gleiche Folge-Snapshots und mindestens 4 Sekunden Beobachtung. Diese Werte sind zentral konfigurierbar (`renderSettlingMaxMs`, `renderSettlingIntervalMs`, `renderSettlingMaxSnapshots`, `renderSettlingStableSnapshots`, `renderSettlingMinimumObservationMs`). `maxConcurrentRenderedPages` begrenzt Browserseiten pro Run standardmaessig auf eins. Live-Zahlen und Zeitstempel werden fuer die Stabilitaetsentscheidung normalisiert; Metadaten-, H1-, Schema-, interne Link-, Ladeindikator- und Content-Readiness-Aenderungen bleiben relevant. Ergebniszustaende umfassen `settled`, `content_remained_empty`, `rendering_unstable`, `settling_timeout`, `navigation_failed` und `aborted`; Content- und Metadatenwachstum nach dem ersten Snapshot werden als zusaetzliche Provenienzereignisse gespeichert.

Browserereignisse werden nach Kanal und Phase getrennt (`console_warning`, `console_error`, `pageerror`, `request_failed`, `csp_violation`, `response_4xx`, `response_5xx`, `service_worker_error`, Navigation und Runner). Eine reproduzierbare Console-Diagnostik ohne Inhaltsauswirkung ist Low; eine nicht reproduzierte Einzelmeldung bleibt scorefrei, fehlgeschlagene Navigation ist `technical_error`. Der additive CSV-Export `render-provenance` und der JSON-Export enthalten Raw-, Initial-, Settled- und Effective-State sowie Settling-Konfiguration und -Version. Alte Runs haben diese Fakten nicht; fehlende historische Renderprovenienz wird nicht erfunden. Details und bekannte Grenzen stehen in [docs/render-provenance-v1.md](docs/render-provenance-v1.md).

Comparison Reports zeigen Base Run vs Compare Run mit Executive Delta Summary, Regression Findings, neuen/resolved/worsened/improved Findings, URL-Aenderungen, Template-Aenderungen und Performance-Aenderungen. Synthetische Regression Findings existieren nur im Vergleichskontext und werden nicht als normale Check-Ergebnisse gespeichert.

## Architektur

- `src/server`: Express API und statische UI
- `src/crawler`: Audit-Orchestrierung, Domain-Erkennung, robots/sitemap, Worker
- `src/queue`: persistente SQLite-Crawl-Queue
- `src/extractors`: HTML-, Link-, Schema-, Media-, Header- und Render-Extraktion
- `src/checks`: modulare Tech- und GEO-Checks
- `src/db`: SQLite Initialisierung und Migrationen
- `src/reports`: HTML-Report-Erzeugung
- `src/reports/csvExporter.js`: streaming-faehige CSV-Exports
- `src/reports/comparisonReportGenerator.js`: HTML-Reports fuer Run-Vergleiche
- `src/reports/comparisonCsvExporter.js`: CSV-Exports fuer Run-Vergleiche
- `src/analysis/templateClusterer.js`: URL-/Template-Clustering und representative Samples
- `src/comparison`: deterministische Run-Vergleichslogik
- `src/sampling`: Template-Sampling, Playwright-Sampling, Lighthouse-Sampling und Aggregation
- `src/reviews`: Review-Workflow, manuelle Overrides und Effective Values
- `src/utils`: URL-Normalisierung, Zeit, Scoring, Robots-Hilfen
- `data/audit.sqlite`: lokale Audit-Datenbank
- `reports/run-{runId}.html`: erzeugte Reports

## Datenbankmodell

Die zentralen Tabellen sind `projects`, `runs`, `crawl_queue`, `pages`, `page_links`, `page_images`, `resources`, `schemas`, `domain_assets`, `check_results` und `run_logs`. Die Queue dedupliziert pro Run ueber `normalizedUrl`; Status- und Lookup-Indizes sind fuer grosse Datenmengen vorbereitet.

Batch 3 erweitert `runs` migrationssicher um `lockToken`, `lockedAt`, `heartbeatAt`, `workerCount`, `lastRecoveryAt`, `maxAttempts`, `maxConcurrentPerHost`, `retryBaseDelayMs` und `retryMaxDelayMs`. `crawl_queue` enthaelt zusaetzlich `nextAttemptAt`, `lastStatusCode`, `lastErrorType`, `failedReason` und `lockToken`.

Batch 4 erweitert `runs` um `maxSitemapUrls`, `maxSitemaps`, `sitemapBatchSize`, `sampleUrlsPerTemplate`, `maxTemplateSamplesTotal`, `sitemapUrlsDiscovered`, `sitemapUrlsQueued`, `sitemapFilesProcessed` und `currentSitemapUrl`. `pages` enthaelt `templateClusterId` und `templateClusterKey`; `crawl_queue` enthaelt `shardKey` und `shardId`. Neu sind `template_clusters` fuer URL-/Template-Zusammenfassungen und `scheduled_runs` als vorbereitete Scheduling-Tabelle.

Batch 4.1 erweitert `check_results` additiv um `reportGroupingKey`, `findingType`, `confidence`, `reviewRecommended` und `relatedCheckIdsJson`. `page_images` enthaelt Heuristikfelder fuer dekorative Bilder, Badges, Tracking-Pixel und Icons. Status und Prioritaeten werden vor dem Speichern normalisiert: Status ist nur `OK`, `Warning`, `Error` oder `NA`; Priority ist nur `High`, `Medium` oder `Low`.

Der Evidence-Gate-Batch erweitert `check_results` additiv um `evaluationState`, `scoreEligible`, `scoreExclusionReason`, `requirementsJson`, `factsJson`, `assessmentJson`, `recommendationMetaJson` und `scoreDeduplicationKey`. `OK`, `Warning`, `Error` und `NA` bleiben als kompatible Anzeigezustaende bestehen; die fachliche Bewertbarkeit wird separat gespeichert.

Der Run-77-Belastbarkeits-Batch erweitert `runs` um Runtime-Version und Konfigurations-Provenienz, `check_results` um `checkVersion` und `provenanceJson`, `pages` um initiale/finale HTTP-, Textarten- und Browserfehlerkanaele, `page_links` um den verlinkten Originalwert und die Redirect-Kette, `page_images` um explizite Alt-Attributzustaende und `resources` um Quelle beziehungsweise Fehler der Groessenmessung. `http_timing_measurements` speichert gezielte wiederholte TTFB-Messungen. Alle Erweiterungen sind additiv; bestehende Run-Werte werden nicht veraendert.

Der Root-Cause-Scoring-Batch erweitert `runs` additiv um die vier Modellversionen, Score-Status, persistierte Tech-/GEO-/Gesamtwerte und den maschinenlesbaren Breakdown. `check_results` erhaelt Root-Cause-ID/-Key/-Familie, Scope-, Vorkommens-, URL- und Sample-Zaehler, Primaercheck, Deduplizierungsbegruendung und Mehrfachmitgliedschaften. Unterschiedliche Duplicate-Title/-Description-Werte werden ueber stabile Hashes getrennt; vollstaendige Seitentexte oder URL-Listen werden nicht fuer Scoring-Snapshots gespeichert. Alte Runs und originale per-Check-Werte werden nicht ueberschrieben.

Batch 5 fuegt `finding_reviews` hinzu. Originale `check_results` bleiben unveraendert; manuelle Felder wie `manualStatus`, `manualPriority`, `manualFinding` und `manualRecommendation` werden nur als Effective Values in UI, Report und Export genutzt.

Batch 6 erweitert `runs` um Sampling-Konfiguration und Fortschrittsfelder (`enableTemplateSampling`, `enablePlaywrightSampling`, `enableLighthouseSampling`, `lighthouseDevice`, `lighthouseCategoriesJson`, `lighthouseTimeoutMs`, `playwrightTimeoutMs`, `collectScreenshots`, `sampleOnlyIndexable`, `samplesTotal`, `samplesProcessed`, `currentSampleUrl`). Neue Tabellen sind `template_sample_results`, `playwright_results`, `lighthouse_results` und `template_performance_summary`.

Batch 6.1 fuegt keine neue Tabelle hinzu. Die Bewertungslogik trennt Legal-noindex, GEO-Opportunities, Webmanifest/PWA-Hinweise, schwache FAQ-Hinweise und Speakable klarer von Core-Fehlern. Reports zeigen abgeschlossene Runs als `completed`, markieren laufende Reports als Live/Interim und weisen Sampling-Status wie `disabled`, `unavailable`, `partial` oder `completed` explizit aus.

Batch 6.2 fuegt keine neue Tabelle hinzu. Der HTML-Report hat eine stabil getestete Abschnittsstruktur, eine Executive Summary, einklappbare Evidence-/Sample-Bereiche und Snapshot-/Strukturtests fuer zentrale Report-Sektionen und Escaping.

Batch 7 fuegt `run_comparisons` hinzu. Gespeichert werden Base-/Compare-Run, Domains, Status, Summary, Findings-, URL-, Template-, Performance-Deltas, Regression Findings und Warnings als JSON-Snapshots. Wird ein Run geloescht, werden zugehoerige gespeicherte Vergleiche ebenfalls entfernt.

Der anschliessende Report-/Review-Semantik-Batch fuegt keine neue Tabelle hinzu. Stattdessen werden zentrale Display-Felder berechnet: `displayStatus`, `displayReviewStatus`, `displayActionStatus`, `displayReviewRecommended`, `isActionable`, `reportSection` und `normalizedFindingType`. Diese Felder sind additiv in Findings-/Reviews-CSV sichtbar und werden in UI, Report und Review Summary verwendet.

## Skalierungsprinzip

Crawl-Daten bleiben nicht als Gesamtliste im Speicher. URLs werden normalisiert, dedupliziert und inkrementell in SQLite geschrieben. Worker holen pending URLs atomar aus der Datenbank, speichern Ergebnisse sofort und schreiben neu gefundene interne Links wieder in die Queue. Run-Locks mit Heartbeat verhindern parallele Bearbeitung desselben Runs; stale `processing`-Eintraege koennen beim Start, Resume oder ueber Recover zurueckgesetzt werden. Retrybare Fehler landen mit exponentiellem Backoff im Status `waiting`.

Sitemaps werden batch-orientiert verarbeitet. Normale Sitemap-XMLs, Sitemap-Indizes und gzip-komprimierte Sitemap-Dateien werden unterstuetzt. Loc-Eintraege werden inkrementell in Queue-Batches geschrieben, und Fortschritt wird ueber `sitemapUrlsDiscovered`, `sitemapUrlsQueued`, `sitemapFilesProcessed` und `currentSitemapUrl` sichtbar.

Nach dem Crawl werden Pages heuristisch in Template-Cluster gruppiert, etwa `/blog/{slug}`, `/produkt/{slug}` oder `/de/{category}/{subcategory}/{slug}`. Pro Cluster werden deterministische Sample-URLs gespeichert. Batch 6 nutzt diese Samples fuer optionale Playwright- und Lighthouse-Messungen, aggregiert die Ergebnisse pro Template und erzeugt daraus deterministische Findings mit Evidence.

Batch 7 vergleicht gespeicherte Runs zentral in `src/comparison/runComparison.js`. Finding-Deltas unterscheiden `new`, `resolved`, `worsened`, `improved`, `unchanged_issue`, `unchanged_ok` und `not_comparable`; URL-Deltas u.a. `newUrl`, `removedUrl`, `statusChanged`, `becameIndexable`, `becameNoindex`, `titleChanged`, `canonicalChanged` und `pageTypeChanged`; Template- und Performance-Deltas bilden Cluster- und Sampling-Unterschiede ab. Unterschiede in Audit-Typ, Crawl- oder Sampling-Konfiguration werden als Warning ausgewiesen.

`scheduled_runs` ist nur vorbereitet: Datenmodell und Repository-Funktionen existieren, aber es gibt in Batch 4 noch keinen aktiven Cron/Scheduler und keine Scheduling-UI.

Page-Type-Erkennung unterscheidet Detailseiten und Uebersichten wie `blog_index`, `article_index`, `category_index` und `product_index`. Product- und Article-Schema-Coverage laeuft nur auf echten Detailseiten. FAQPage-Hinweise werden nur bei starker FAQ-Struktur als Issue bewertet; schwache Frage-Hinweise werden als Review/Opportunity behandelt.

## Batch-1-Grenzen

- Sitemap-Parsing ist modular, aber noch nicht voll streaming-basiert.
- Sitemap-Parsing ist speicherschonender und batch-orientiert, aber noch kein SAX/Streaming-XML-Parser.
- Resource-Groessen sind nur vorhanden, wenn sie aus Response- oder Resource-Requests erfasst werden koennen.
- Lighthouse ist optional und lokal/lab-basiert; keine externen APIs, kein LLM-Scoring.
- GEO-Pruefungen sind bewusst nur messbare oder klar heuristische Readiness-Signale.

## Naechste Batches

- Batch 8: aktiver Scheduler fuer regelmaessige Audits plus gespeicherte Vergleichsvorlagen
- Review-Historie und Assignee-/Faelligkeitsfelder
- LLM-gestuetzte qualitative Bewertung
- GSC/SISTRIX/Ahrefs/API-Imports
- AI Visibility Monitoring
- Millionen-URL-Crawls mit echtem Streaming-XML, aktivem Scheduling, Shard-Worker-Zuordnung und optional verteilten Workern
