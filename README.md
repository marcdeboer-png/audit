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

Checks koennen die Bewertungszustaende `pass`, `fail`, `not_applicable`, `insufficient_evidence`, `not_executed` und `technical_error` speichern. Die letzten vier Zustaende sind nicht scorefaehig. `null`, leerer String, `0` und `false` bleiben beobachtete Werte; nur eine nicht erhobene beziehungsweise `undefined` Messung gilt als fehlend. Jeder angepasste Check weist benoetigte und optionale Fakten, fehlende Fakten, Mindestabdeckung, Wiederholbarkeit per Targeted Run und Ausschlussgrund aus.

Die interne Suchseiten-Erkennung kombiniert URL-Pfad oder Suchparameter mit Resultat-Ueberschrift/-Text, Main-Content-Suchformular, Ergebnisliste und optional `SearchAction`. Ein Suchfeld im globalen Header, ein einzelner `q`-Parameter, Kategorie-/Tag-/Autorenarchive, Glossare und Filterseiten reichen nicht. Widerspruechliche Signale ergeben `insufficient_evidence`; die erkannten positiven und widersprechenden Signale stehen in der Evidence.

Das Scoring aggregiert nur `pass`/`fail`, gewichtet optionale Low-Findings geringer und dedupliziert ausschliesslich Checks mit einem expliziten gemeinsamen Root-Cause-Key. Die maschinenlesbare `summary/scores.json` und der HTML-Report enthalten Kategorien, gewichtete Abzuege, ausgeschlossene Checks, Deduplizierungen, Datenabdeckung und den maximal abgedeckten Score-Anteil. Eine geringe Datenabdeckung kann deshalb neben einem hohen normalisierten Score stehen und muss separat interpretiert werden.

Finding-Daten trennen additiv `facts`, `evidence`, `assessment` und `recommendationMeta`. Fakten sind Messwerte, Evidence beschreibt Quelle und Zeitpunkt, Assessment enthaelt Interpretation und Gueltigkeitsbedingungen, und die Empfehlung bleibt eine Handlungsempfehlung. Bestehende Textfelder bleiben fuer Kompatibilitaet erhalten.

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
