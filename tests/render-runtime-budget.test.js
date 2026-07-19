import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, deleteRun, getRunWithProject, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { processQueueItem, metadataProvenanceIsComplete } from '../src/crawler/pageProcessor.js';
import { buildTemplateClusters } from '../src/analysis/templateClusterer.js';
import { runTemplateSampling } from '../src/sampling/templateSamplingRunner.js';
import { evaluateRuntimeRenderBudget, runDeterministicRenderPlan } from '../src/rendering/renderPlanRunner.js';
import {
  buildDeterministicRenderPlan,
  classifyRenderNeed,
  classifyRenderNeedV1,
  estimateRenderCost,
  RENDER_NEEDS
} from '../src/rendering/renderPlanner.js';
import { createRuntimeMetricsTracker, summarizeRuntimeMetrics } from '../src/runtime/renderMetrics.js';
import { createDocumentState } from '../src/extractors/documentState.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('render gate distinguishes complete raw documents from app shells without framework shortcuts', () => {
  const complete = pageFixture({ words: 180, h1: ['Complete'], scripts: 20 });
  assert.equal(classifyRenderNeed(complete, { scriptCount: 20 }).decision, RENDER_NEEDS.notRequired, 'SSR React-like output is complete raw HTML');
  assert.equal(classifyRenderNeed(pageFixture({ words: 4, h1: [], links: [] }), { scriptCount: 1 }).decision, RENDER_NEEDS.required, 'few scripts do not conceal an app shell');
  assert.equal(classifyRenderNeed(pageFixture({ words: 4, h1: [], links: [], pageType: 'other' }), { scriptCount: 1 }).decision, RENDER_NEEDS.required, 'an unknown app shell combines missing content with executable structure');
  assert.equal(classifyRenderNeed(pageFixture({ words: 20, h1: ['Privacy'], pageType: 'legal' }), { scriptCount: 0 }).decision, RENDER_NEEDS.notRequired, 'concise utility pages are not treated as incomplete');
  const optionalMetadata = pageFixture({ words: 180, h1: ['Complete'], metadata: { metaDescription: null } });
  assert.equal(classifyRenderNeed(optionalMetadata).decision, RENDER_NEEDS.notRequired, 'late optional metadata cannot force a browser run');
  assert.equal(classifyRenderNeedV1(optionalMetadata).decision, RENDER_NEEDS.recommended, 'the benchmark baseline remains reproducible');
  assert.equal(classifyRenderNeed(complete, { scriptCount: 50 }).negativeSignals.includes('substantial_raw_content_present'), false);
  assert.equal(classifyRenderNeed(complete, { scriptCount: 50 }).negativeSignals.includes('substantial_main_content'), true);
});

test('render plans are deterministic, template-stratified and unaffected by URL order', () => {
  const pages = [
    plannedPage('https://x.invalid/c', 'tpl-a', RENDER_NEEDS.recommended, 210),
    plannedPage('https://x.invalid/a', 'tpl-a', RENDER_NEEDS.required, 320),
    plannedPage('https://x.invalid/b', 'tpl-a', RENDER_NEEDS.recommended, 220),
    plannedPage('https://x.invalid/z', 'tpl-b', RENDER_NEEDS.notRequired, 0)
  ];
  const options = { maxRenderedUrls: 2, estimatedRenderTimeMs: 5000, estimatedPersistedBytes: 30000 };
  const first = buildDeterministicRenderPlan(pages, options);
  const second = buildDeterministicRenderPlan([...pages].reverse(), options);
  assert.deepEqual(first.rows.map(pickPlan), second.rows.map(pickPlan));
  assert.equal(first.summary.plannedRenderedUrls, 2);
  assert.equal(first.summary.budgetExcludedUrls, 1);
  assert.equal(first.rows.find((row) => row.url.endsWith('/a')).plannedBrowserRun, true);
});

test('all configured render budgets fail closed and keep excluded work explicit', () => {
  const page = plannedPage('https://x.invalid/app', 'tpl', RENDER_NEEDS.required, 350);
  for (const budget of [
    { maxRenderedUrls: 0 },
    { maxTotalRenderTimeMs: 4999, estimatedRenderTimeMs: 5000 },
    { maxPersistedRenderBytes: 29999, estimatedPersistedBytes: 30000 }
  ]) {
    const plan = buildDeterministicRenderPlan([page], budget);
    assert.equal(plan.rows[0].executionDecision, 'render_budget_exhausted');
    assert.equal(plan.rows[0].plannedBrowserRun, false);
  }
  assert.equal(metadataProvenanceIsComplete({ usePlaywright: 1, playwrightMode: 'gate' }, false, {}, { decision: RENDER_NEEDS.required }), false);
  assert.equal(metadataProvenanceIsComplete({ usePlaywright: 1, playwrightMode: 'gate' }, false, {}, { decision: RENDER_NEEDS.notRequired }), true);
  const runtimeRun = { maxRenderedUrls: 2, maxTotalRenderTimeMs: 10000, maxPersistedRenderBytes: 60000, maxBrowserFailures: 1 };
  assert.equal(evaluateRuntimeRenderBudget(runtimeRun, { renderedUrls: 1, renderTimeMs: 5000, persistedBytes: 30000, browserFailures: 0 }).allowed, true);
  assert.equal(evaluateRuntimeRenderBudget(runtimeRun, { renderedUrls: 2, renderTimeMs: 5000, persistedBytes: 30000, browserFailures: 0 }).reason, 'max_rendered_urls');
  assert.equal(evaluateRuntimeRenderBudget(runtimeRun, { renderedUrls: 1, renderTimeMs: 10000, persistedBytes: 30000, browserFailures: 0 }).reason, 'max_total_render_time_ms');
  assert.equal(evaluateRuntimeRenderBudget(runtimeRun, { renderedUrls: 1, renderTimeMs: 5000, persistedBytes: 60000, browserFailures: 0 }).reason, 'max_persisted_render_bytes');
  assert.equal(evaluateRuntimeRenderBudget(runtimeRun, { renderedUrls: 1, renderTimeMs: 5000, persistedBytes: 30000, browserFailures: 1 }).reason, 'max_browser_failures');
});

test('cost model exposes P50/P90 ranges and the concurrency-one scaling limit', () => {
  const ten = estimateRenderCost({ urlCount: 10, renderShare: 0.3, rawFetchMs: 100, browserLaunchMs: 500, p50RenderMs: 4200, p90RenderMs: 5500, bytesPerRender: 30000, concurrency: 1 });
  assert.equal(ten.assumptions.renderedUrls, 3);
  assert.equal(ten.expectedPersistedRenderBytes, 90000);
  assert.ok(ten.expectedTotalDurationP90Ms > ten.expectedTotalDurationP50Ms);
  assert.equal(estimateRenderCost({ ...ten.assumptions, urlCount: 1000 }).warning.includes('Concurrency 1'), true);
});

test('runtime metrics support off, basic and profiling without inventing browser RSS', async () => {
  for (const mode of ['off', 'basic', 'profiling']) {
    const fixture = makeRun({ metricsMode: mode });
    const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
    tracker.recordUrl({ url: fixture.run.inputDomain, renderDecision: RENDER_NEEDS.notRequired, rawFetchDurationMs: 5, rawHtmlBytes: 0 });
    if (mode === 'profiling') await new Promise((resolve) => setTimeout(resolve, 275));
    const finished = tracker.finish({ status: 'aborted' });
    if (mode === 'off') assert.equal(fixture.db.prepare('SELECT * FROM run_runtime_metrics WHERE runId=?').get(fixture.run.id), undefined);
    else {
      assert.equal(finished.completionStatus, 'aborted');
      assert.equal(finished.browserProcessRss, null);
      assert.equal(finished.browserChildProcessCount, null);
      assert.ok(finished.processRssPeak >= finished.processRssBefore);
      assert.equal(finished.rawFetchDurationMs, 5);
    }
    fixture.db.close();
  }
});

test('runtime distributions retain true zero values and distinguish missing measurements', () => {
  const fixture = makeRun({ metricsMode: 'basic' });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  tracker.recordUrl({ url: 'https://x.invalid/zero', renderDecision: RENDER_NEEDS.notRequired, rawHtmlBytes: 0, rawFetchDurationMs: 0 });
  tracker.recordUrl({ url: 'https://x.invalid/missing', renderDecision: 'render_unavailable', measurementError: 'browser unavailable' });
  const summary = summarizeRuntimeMetrics(fixture.db, fixture.run.id);
  assert.equal(summary.urlCount, 2);
  assert.equal(summary.byRawContentClass.unknown.count, 2);
  assert.equal(summary.costForecastStatus, 'unavailable_incomplete_measurements');
  assert.deepEqual(summary.costForecastMissing, ['raw_fetch_duration']);
  assert.equal(fixture.db.prepare('SELECT rawHtmlBytes FROM url_runtime_metrics WHERE url LIKE ?').get('%/zero').rawHtmlBytes, 0);
  assert.equal(fixture.db.prepare('SELECT rawHtmlBytes FROM url_runtime_metrics WHERE url LIKE ?').get('%/missing').rawHtmlBytes, null);
  tracker.finish();
  fixture.db.close();
});

test('cost forecasts require complete measurements and never replace missing render costs with zero', () => {
  const fixture = makeRun({ metricsMode: 'basic' });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  tracker.recordUrl({ url: fixture.run.inputDomain, renderDecision: RENDER_NEEDS.notRequired, rawFetchDurationMs: 0, rawHtmlBytes: 0 });
  const complete = summarizeRuntimeMetrics(fixture.db, fixture.run.id);
  assert.equal(complete.costForecastStatus, 'available');
  assert.deepEqual(complete.costForecasts.map((forecast) => forecast.assumptions.urlCount), [10, 100, 1000, 10000]);
  assert.equal(complete.costForecasts[0].expectedBrowserRuns, 0);
  tracker.recordUrl({ url: 'https://x.invalid/render-missing', resultingBrowserRun: true, renderDecision: RENDER_NEEDS.required, rawFetchDurationMs: 5 });
  const incomplete = summarizeRuntimeMetrics(fixture.db, fixture.run.id);
  assert.equal(incomplete.costForecastStatus, 'unavailable_incomplete_measurements');
  assert.ok(incomplete.costForecastMissing.includes('render_duration'));
  assert.deepEqual(incomplete.costForecasts, []);
  tracker.finish();
  fixture.db.close();
});

test('deterministic gate renders a delayed app shell once and persists decision provenance', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Shell</title></head><body><div id="root">Loading</div><script>setTimeout(()=>{document.querySelector('#root').innerHTML='<main><h1>Rendered</h1><p>${'content '.repeat(140)}</p></main>'},50)</script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = makeRun({
    domain: origin,
    usePlaywright: true,
    playwrightMode: 'gate',
    metricsMode: 'basic',
    renderSettlingMaxMs: 1200,
    renderSettlingIntervalMs: 200,
    renderSettlingStableSnapshots: 3,
    renderSettlingMinimumObservationMs: 600,
    enableTemplateSampling: false
  });
  updateProject(fixture.db, fixture.run.projectId, { finalDomain: '127.0.0.1' });
  updateRun(fixture.db, fixture.run.id, { status: 'running' });
  const run = getRunWithProject(fixture.db, fixture.run.id);
  const tracker = createRuntimeMetricsTracker(fixture.db, run);
  await processQueueItem(fixture.db, run, run, { url: origin, normalizedUrl: origin, depth: 0, sourceUrl: null }, null, null, tracker);
  buildTemplateClusters(fixture.db, run.id, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 5 });
  const summary = await runDeterministicRenderPlan(fixture.db, getRunWithProject(fixture.db, run.id), tracker);
  const page = fixture.db.prepare('SELECT * FROM pages WHERE runId=?').get(run.id);
  const metric = fixture.db.prepare('SELECT * FROM url_runtime_metrics WHERE runId=?').get(run.id);
  assert.equal(summary.renderedUrls, 1);
  assert.equal(page.renderStatus, 'success');
  assert.equal(page.effectiveH1Count, 1);
  assert.equal(metric.resultingBrowserRun, 1);
  assert.equal(metric.renderDecision, RENDER_NEEDS.required);
  assert.ok(metric.snapshotCount >= 3);
  assert.equal(fixture.db.prepare('SELECT renderedPagesCount FROM runs WHERE id=?').get(run.id).renderedPagesCount, 1);
  tracker.finish();
  fixture.db.close();
});

test('an unavailable requested browser is explicit even when raw HTML is otherwise complete', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>Complete</title><meta name="description" content="Complete"><link rel="canonical" href="/complete"></head><body><main><h1>Complete</h1><p>${'content '.repeat(140)}</p></main></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = makeRun({ domain: origin, usePlaywright: true, playwrightMode: 'all', metricsMode: 'basic' });
  updateProject(fixture.db, fixture.run.projectId, { finalDomain: '127.0.0.1' });
  const run = getRunWithProject(fixture.db, fixture.run.id);
  const tracker = createRuntimeMetricsTracker(fixture.db, run);
  await processQueueItem(fixture.db, run, run, { url: origin, normalizedUrl: origin, depth: 0, sourceUrl: null }, null, null, tracker);
  const metric = fixture.db.prepare('SELECT renderNeed,renderDecision,resultingBrowserRun FROM url_runtime_metrics WHERE runId=?').get(run.id);
  assert.equal(metric.renderNeed, RENDER_NEEDS.notRequired);
  assert.equal(metric.renderDecision, 'render_unavailable');
  assert.equal(metric.resultingBrowserRun, 0);
  assert.equal(fixture.db.prepare('SELECT metadataProvenanceComplete FROM pages WHERE runId=?').get(run.id).metadataProvenanceComplete, 0);
  tracker.finish();
  fixture.db.close();
});

test('budget-exhausted gate does not render and marks dependent evidence incomplete', async () => {
  const fixture = makeRun({ usePlaywright: true, playwrightMode: 'gate', metricsMode: 'basic', maxRenderedUrls: 0 });
  const raw = pageFixture({ words: 2, h1: [], links: [] }).rawDocumentStateJson;
  fixture.db.prepare(`INSERT INTO pages (runId,url,normalizedUrl,finalUrl,depth,statusCode,contentType,indexable,pageType,rawDocumentStateJson,metadataProvenanceComplete,h1Json,h2Json,noindex,nofollow,imagesCount,imagesWithoutAltCount,hasTables,hasLists,hasFaqPattern,hasVisibleDate,hasAuthorPattern,externalSourceLinksCount,hasVideoEmbed) VALUES (?,?,?,?,0,200,'text/html',1,'homepage',?,1,'[]','[]',0,0,0,0,0,0,0,0,0,0,0)`).run(fixture.run.id, fixture.run.inputDomain, fixture.run.inputDomain, fixture.run.inputDomain, raw);
  buildTemplateClusters(fixture.db, fixture.run.id, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 5 });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  const summary = await runDeterministicRenderPlan(fixture.db, fixture.run, tracker);
  assert.equal(summary.budgetExcludedUrls, 1);
  assert.equal(fixture.db.prepare('SELECT metadataProvenanceComplete FROM pages WHERE runId=?').get(fixture.run.id).metadataProvenanceComplete, 0);
  assert.equal(fixture.db.prepare('SELECT renderDecision FROM url_runtime_metrics WHERE runId=?').get(fixture.run.id).renderDecision, 'render_budget_exhausted');
  tracker.finish();
  fixture.db.close();
});

test('a renderer exception becomes technical evidence and exhausts the configured failure budget', async () => {
  const fixture = makeRun({ usePlaywright: true, playwrightMode: 'gate', metricsMode: 'basic', maxBrowserFailures: 1 });
  const raw = pageFixture({ words: 2, h1: [], links: [] }).rawDocumentStateJson;
  const insert = fixture.db.prepare(`INSERT INTO pages (runId,url,normalizedUrl,finalUrl,depth,statusCode,contentType,indexable,pageType,rawDocumentStateJson,metadataProvenanceComplete,h1Json,h2Json,noindex,nofollow,imagesCount,imagesWithoutAltCount,hasTables,hasLists,hasFaqPattern,hasVisibleDate,hasAuthorPattern,externalSourceLinksCount,hasVideoEmbed) VALUES (?,?,?,?,0,200,'text/html',1,'homepage',?,1,'[]','[]',0,0,0,0,0,0,0,0,0,0,0)`);
  for (const suffix of ['/a', '/b']) {
    const url = `https://x.invalid${suffix}`;
    insert.run(fixture.run.id, url, url, url, raw);
  }
  buildTemplateClusters(fixture.db, fixture.run.id, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 5 });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  let closed = false;
  const result = await runDeterministicRenderPlan(fixture.db, fixture.run, tracker, {
    launchBrowserFn: async () => ({ close: async () => { closed = true; } }),
    renderPageFn: async () => { throw new Error('page creation failed'); }
  });
  assert.equal(result.renderedUrls, 1);
  assert.equal(result.browserFailures, 1);
  assert.equal(closed, true);
  const metrics = fixture.db.prepare('SELECT renderDecision,renderStatus,measurementError FROM url_runtime_metrics WHERE runId=? ORDER BY url').all(fixture.run.id);
  assert.equal(metrics[0].renderStatus, 'technical_error');
  assert.match(metrics[0].measurementError, /page creation failed/);
  assert.equal(metrics[1].renderDecision, 'render_budget_exhausted');
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM pages WHERE runId=? AND metadataProvenanceComplete=0").get(fixture.run.id).count, 2);
  const runtime = tracker.finish();
  assert.equal(runtime.browserFailureCount, 1);
  fixture.db.close();
});

test('runtime metrics remain compatible with historical runs and are present in report, JSON and CSV', () => {
  const fixture = makeRun({ metricsMode: 'basic' });
  const historical = makeRun({ metricsMode: 'off' });
  historical.db.prepare('UPDATE runs SET renderPlanningVersion=NULL, runtimeMetricsVersion=NULL WHERE id=?').run(historical.run.id);
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  tracker.recordUrl({
    url: fixture.run.inputDomain,
    renderDecision: RENDER_NEEDS.notRequired,
    reason: { summary: 'complete raw' },
    renderNegativeSignals: ['substantial_main_content'],
    renderSignalContributions: [{ signal: 'substantial_main_content', appliedContribution: -4 }],
    renderRecommendationScore: -4,
    renderRecommendationThreshold: 4,
    renderCheckRequirements: [{ checkId: 'tech.js_dependent_content', requirement: 'render_optional' }]
  });
  tracker.finish();
  const csv = collectCsvExport(fixture.db, fixture.run.id, 'render-runtime');
  assert.match(csv, /renderDecision/);
  assert.match(csv, /render_not_required/);
  const json = JSON.parse(collectFullAuditJson(fixture.db, fixture.run.id, ['render-runtime']).body);
  assert.equal(json.runtimeMetrics.metricsMode, 'basic');
  assert.equal(json.runtimeMetrics.summary.metricsVersion, 'render-runtime-metrics-v1');
  assert.equal(json.renderDecisions.length, 1);
  assert.equal(json.renderDecisions[0].renderRecommendationScore, -4);
  assert.equal(json.renderDecisions[0].renderSignalContributions[0].signal, 'substantial_main_content');
  assert.match(csv, /renderRecommendationScore/);
  assert.match(csv, /substantial_main_content/);
  const report = fs.readFileSync(generateReport(fixture.db, fixture.run.id), 'utf8');
  assert.match(report, /Browser Runtime and Resource Metrics/);
  const oldReport = fs.readFileSync(generateReport(historical.db, historical.run.id), 'utf8');
  assert.match(oldReport, /historical \/ not recorded/);
  const oldJson = JSON.parse(collectFullAuditJson(historical.db, historical.run.id, ['render-runtime']).body);
  assert.equal(oldJson.runConfig.metricsMode, null);
  assert.equal(oldJson.runtimeMetrics, null);
  fixture.db.close();
  historical.db.close();
});

test('additive migration recreates runtime metric tables and budget columns without rewriting old runs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-runtime-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  let db = new Database(filename);
  initDatabase(db);
  db.exec('DROP TABLE url_runtime_metrics; DROP TABLE run_runtime_metrics;');
  for (const column of ['metricsMode', 'renderPlanningVersion', 'runtimeMetricsVersion', 'maxRenderedUrls', 'maxTotalRenderTimeMs', 'maxSettlingTimeMsPerUrl', 'maxBrowserFailures', 'maxPersistedRenderBytes']) {
    db.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
  }
  db.close();
  db = new Database(filename);
  initDatabase(db);
  const columns = new Set(db.prepare('PRAGMA table_info(runs)').all().map((row) => row.name));
  assert.ok(columns.has('metricsMode'));
  assert.ok(columns.has('maxPersistedRenderBytes'));
  assert.ok(new Set(db.prepare('PRAGMA table_info(url_runtime_metrics)').all().map((row) => row.name)).has('rawContentClass'));
  for (const column of ['renderNegativeSignalsJson', 'renderSignalContributionsJson', 'renderRecommendationScore', 'renderRecommendationThreshold', 'renderCheckRequirementsJson']) {
    assert.ok(new Set(db.prepare('PRAGMA table_info(url_runtime_metrics)').all().map((row) => row.name)).has(column));
  }
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_runtime_metrics'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='url_runtime_metrics'").get());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_runtime_metrics').get().count, 0);
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('deleting a run also removes its additive runtime metrics', () => {
  const fixture = makeRun({ metricsMode: 'basic' });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  tracker.recordUrl({ url: fixture.run.inputDomain, rawFetchDurationMs: 1, renderDecision: RENDER_NEEDS.notRequired });
  tracker.finish();
  assert.doesNotThrow(() => deleteRun(fixture.db, fixture.run.id));
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM run_runtime_metrics').get().count, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM url_runtime_metrics').get().count, 0);
  fixture.db.close();
});

test('template sampling reuses stable page rendering instead of launching a duplicate browser', async () => {
  const fixture = makeRun({ enableTemplateSampling: true, enablePlaywrightSampling: true, metricsMode: 'basic' });
  const settled = JSON.parse(pageFixture({ words: 150, h1: ['Stable'] }).rawDocumentStateJson);
  fixture.db.prepare(`INSERT INTO pages (
    runId,url,normalizedUrl,finalUrl,depth,statusCode,contentType,indexable,pageType,title,h1Json,h1Count,h2Json,
    wordCountRaw,internalLinksCount,externalLinksCount,schemaTypesJson,noindex,nofollow,imagesCount,imagesWithoutAltCount,
    hasTables,hasLists,hasFaqPattern,hasVisibleDate,hasAuthorPattern,externalSourceLinksCount,hasVideoEmbed,
    renderStatus,settlingStatus,settlingDurationMs,renderSnapshotCount,renderFingerprint,
    initialRenderedStateJson,settledRenderedStateJson,renderProvenanceJson,browserEventsJson,
    renderProvenanceVersion,settlingPolicyVersion,wordCountRendered,renderedH1Count,renderedLinksCount,
    consoleErrorsJson,pageErrorsJson,requestFailuresJson,cspViolationsJson
  ) VALUES (?,?,?,?,0,200,'text/html',1,'article','Stable','["Stable"]',1,'[]',150,3,0,'[]',0,0,0,0,0,0,0,0,0,0,0,
    'success','settled',4100,9,'stable-fingerprint',?,?,?,?,?,?,150,1,3,'[]','[]','[]','[]')`).run(
    fixture.run.id, fixture.run.inputDomain, fixture.run.inputDomain, fixture.run.inputDomain,
    JSON.stringify(settled), JSON.stringify(settled), JSON.stringify({ snapshots: [{ observedAt: new Date().toISOString(), semanticFingerprint: 'stable-fingerprint' }] }), JSON.stringify([]),
    'raw-rendered-metadata-v1', 'bounded-semantic-settling-v1'
  );
  buildTemplateClusters(fixture.db, fixture.run.id, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 5 });
  const tracker = createRuntimeMetricsTracker(fixture.db, fixture.run);
  const result = await runTemplateSampling(fixture.db, fixture.run.id, tracker);
  assert.equal(result.samples, 1);
  assert.equal(fixture.db.prepare('SELECT status FROM playwright_results WHERE runId=?').get(fixture.run.id).status, 'success');
  const runtime = tracker.finish();
  assert.equal(runtime.browserLaunchCount, 0);
  fixture.db.close();
});

function pageFixture({ words = 120, h1 = ['H1'], links = ['/a', '/b', '/c'], scripts = 0, pageType = 'article', metadata = {} } = {}) {
  const text = Array.from({ length: words }, () => 'word').join(' ');
  const state = createDocumentState({
    title: metadata.title === undefined ? 'Title' : metadata.title,
    metaDescription: metadata.metaDescription === undefined ? 'Description' : metadata.metaDescription,
    canonical: metadata.canonical === undefined ? 'https://x.invalid/page' : metadata.canonical,
    htmlLang: metadata.htmlLang === undefined ? 'en' : metadata.htmlLang,
    visibleText: text,
    mainText: text,
    h1,
    links,
    mainContentPresent: true
  }, { url: 'https://x.invalid/page', finalDomain: 'x.invalid', source: 'raw_html' });
  return { url: 'https://x.invalid/page', pageType, indexable: 1, rawDocumentStateJson: JSON.stringify(state), scriptCount: scripts };
}

function plannedPage(url, templateClusterKey, decision, strength) {
  return { url, pageType: 'article', templateClusterKey, classification: { decision, strength, confidence: 'high', reason: decision, signals: [], unmetPrerequisites: [], requestedCheckFamilies: [] } };
}

function pickPlan(row) {
  return { url: row.url, decision: row.executionDecision, render: row.plannedBrowserRun, key: row.priorityKey };
}

function makeRun(overrides = {}) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-render-runtime-')), 'audit.sqlite');
  const db = new Database(dbPath);
  initDatabase(db);
  const config = normalizeAuditConfig({
    domain: 'https://x.invalid', auditType: 'tech', maxUrls: 5, maxDepth: 0,
    concurrency: 1, enableTemplateSampling: false, ...overrides
  });
  const projectId = createProject(db, { inputDomain: config.domain });
  const runId = createRun(db, projectId, config);
  return { db, run: getRunWithProject(db, runId) };
}
