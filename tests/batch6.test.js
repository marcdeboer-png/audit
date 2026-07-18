import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildTemplateClusters } from '../src/analysis/templateClusterer.js';
import { initDatabase } from '../src/db/database.js';
import { deleteRun } from '../src/db/repositories.js';
import { runChecks } from '../src/checks/checkEngine.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { createPlaywrightSampler } from '../src/sampling/playwrightSampler.js';
import { createLighthouseSampler } from '../src/sampling/lighthouseSampler.js';
import { aggregateTemplatePerformance } from '../src/sampling/templatePerformanceAggregator.js';
import { loadTemplateSamples, runTemplateSampling } from '../src/sampling/templateSamplingRunner.js';

test('template sampling uses template cluster sample URLs and respects maxTemplateSamplesTotal', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, 'https://example.com/blog/a', { pageType: 'article' });
  insertPage(db, runId, 'https://example.com/blog/b', { pageType: 'article' });
  insertPage(db, runId, 'https://example.com/product/a', { pageType: 'product' });
  insertPage(db, runId, 'https://example.com/product/b', { pageType: 'product' });
  buildTemplateClusters(db, runId, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 4 });

  const samples = loadTemplateSamples(db, runId, { maxTemplateSamplesTotal: 3, sampleOnlyIndexable: true });
  assert.equal(samples.length, 3);
  assert.ok(samples.every((sample) => sample.templateClusterKey));
  assert.deepEqual(new Set(samples.map((sample) => sample.url)).size, samples.length);
  db.close();
});

test('template sampling respects sampleOnlyIndexable', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, 'https://example.com/private/a', { pageType: 'article', indexable: 0 });
  insertPage(db, runId, 'https://example.com/private/b', { pageType: 'article', indexable: 0 });
  buildTemplateClusters(db, runId, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 10 });

  assert.equal(loadTemplateSamples(db, runId, { sampleOnlyIndexable: true }).length, 0);
  assert.equal(loadTemplateSamples(db, runId, { sampleOnlyIndexable: false }).length, 2);
  db.close();
});

test('disabled Playwright and Lighthouse sampling stores disabled sample statuses without errors', async () => {
  const db = setupDb();
  const runId = createRun(db, {
    enableTemplateSampling: 1,
    enablePlaywrightSampling: 0,
    enableLighthouseSampling: 0
  });
  insertPage(db, runId, 'https://example.com/blog/a', { pageType: 'article' });
  buildTemplateClusters(db, runId, { sampleUrlsPerTemplate: 1, maxTemplateSamplesTotal: 10 });

  const result = await runTemplateSampling(db, runId);
  assert.equal(result.samples, 1);
  const sample = db.prepare('SELECT * FROM template_sample_results WHERE runId = ?').get(runId);
  assert.equal(sample.playwrightStatus, 'disabled');
  assert.equal(sample.lighthouseStatus, 'disabled');
  assert.equal(sample.errorMessage, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playwright_results WHERE runId = ?').get(runId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lighthouse_results WHERE runId = ?').get(runId).count, 0);
  db.close();
});

test('Playwright and Lighthouse unavailable fallbacks return unavailable without throwing', async () => {
  const playwright = await createPlaywrightSampler({ forceUnavailable: true });
  assert.equal(playwright.available, false);
  const unavailable = await playwright.sample({ url: 'https://example.com/' });
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(JSON.parse(unavailable.consoleErrorsJson), []);
  assert.equal(JSON.parse(unavailable.browserEventsJson)[0].type, 'runner_error');

  const lighthouse = await createLighthouseSampler({ forceUnavailable: true });
  assert.equal(lighthouse.available, false);
  assert.equal((await lighthouse.sample({ url: 'https://example.com/' })).errorMessage, 'Lighthouse package is not installed or not importable');
});

test('template performance aggregation calculates avg and min scores', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/b');
  insertLighthouseResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a', { performanceScore: 0.9, seoScore: 0.8, largestContentfulPaintMs: 2000, totalBlockingTimeMs: 100, cumulativeLayoutShift: 0.05 });
  insertLighthouseResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/b', { performanceScore: 0.5, seoScore: 0.7, largestContentfulPaintMs: 3000, totalBlockingTimeMs: 300, cumulativeLayoutShift: 0.15 });
  insertPlaywrightResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a', { jsRequiredLikely: 1, consoleErrorsCount: 2 });

  aggregateTemplatePerformance(db, runId);
  const summary = db.prepare('SELECT * FROM template_performance_summary WHERE runId = ?').get(runId);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.lighthouseSuccessCount, 2);
  assert.equal(summary.avgPerformanceScore, 0.7);
  assert.equal(summary.minPerformanceScore, 0.5);
  assert.equal(summary.avgSeoScore, 0.75);
  assert.equal(summary.avgLcpMs, 2500);
  assert.equal(summary.jsRequiredCount, 1);
  assert.equal(summary.consoleErrorSampleCount, 1);
  db.close();
});

test('template performance CSV exposes expected columns', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  aggregateTemplatePerformance(db, runId);
  assert.equal(
    collectCsvExport(db, runId, 'template-performance').split('\n')[0],
    'templateClusterKey,sampleCount,playwrightSuccessCount,lighthouseSuccessCount,avgPerformanceScore,minPerformanceScore,avgSeoScore,minSeoScore,avgAccessibilityScore,avgBestPracticesScore,avgLcpMs,avgTbtMs,avgCls,jsRequiredCount,consoleErrorSampleCount,worstSampleUrls'
  );
  db.close();
});

test('template-performance API returns stored summary data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-api-batch6-'));
  const dbPath = path.join(dir, 'audit.sqlite');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const runId = createRun(db);
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  aggregateTemplatePerformance(db, runId);
  db.close();

  const port = await freePort();
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: dbPath, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const payload = await waitForJson(`http://127.0.0.1:${port}/api/audits/${runId}/template-performance`);
    assert.equal(payload.templates.length, 1);
    assert.equal(payload.templates[0].templateClusterKey, 'article:/blog/{slug}');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteRun removes sampling data', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  insertPlaywrightResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  insertLighthouseResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  aggregateTemplatePerformance(db, runId);

  assert.equal(deleteRun(db, runId), true);
  for (const table of ['template_sample_results', 'playwright_results', 'lighthouse_results', 'template_performance_summary']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE runId = ?`).get(runId).count, 0);
  }
  db.close();
});

test('template checks create evidence-backed findings and disabled sampling is not a hard error', async () => {
  const db = setupDb();
  const runId = createRun(db, {
    enableTemplateSampling: 1,
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1
  });
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a');
  insertSampleResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/b');
  insertLighthouseResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a', { performanceScore: 0.4, seoScore: 0.7, largestContentfulPaintMs: 4500, totalBlockingTimeMs: 700 });
  insertLighthouseResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/b', { performanceScore: 0.45, seoScore: 0.72, largestContentfulPaintMs: 4400, totalBlockingTimeMs: 650 });
  insertPlaywrightResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/a', { jsRequiredLikely: 1, consoleErrorsCount: 2 });
  insertPlaywrightResult(db, runId, 'article:/blog/{slug}', 'https://example.com/blog/b', { jsRequiredLikely: 0, consoleErrorsCount: 0 });
  aggregateTemplatePerformance(db, runId);

  await runChecks(db, runId);
  const lowPerf = result(db, runId, 'template.low_lighthouse_performance');
  assert.equal(lowPerf.status, 'Error');
  assert.ok(Object.keys(JSON.parse(lowPerf.evidenceJson)).length > 0);
  assert.equal(result(db, runId, 'template.console_errors').status, 'Warning');

  const disabledRunId = createRun(db, {
    enableTemplateSampling: 0,
    enablePlaywrightSampling: 0,
    enableLighthouseSampling: 0
  });
  await runChecks(db, disabledRunId);
  const templateFindings = db.prepare("SELECT status FROM check_results WHERE runId = ? AND checkId LIKE 'template.%'").all(disabledRunId);
  assert.ok(templateFindings.length > 0);
  assert.equal(templateFindings.some((row) => ['Warning', 'Error'].includes(row.status)), false);
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db, overrides = {}) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain) VALUES ('example.com', 'https://example.com')").run().lastInsertRowid;
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency, respectRobotsTxt,
      currentPhase, startedAt, enableTemplateSampling, enablePlaywrightSampling,
      enableLighthouseSampling, samplesTotal, samplesProcessed
    )
    VALUES (
      @projectId, 'completed', 'both', 20, 2, 1, 0,
      'completed', CURRENT_TIMESTAMP, @enableTemplateSampling, @enablePlaywrightSampling,
      @enableLighthouseSampling, 0, 0
    )
  `).run({
    projectId,
    enableTemplateSampling: overrides.enableTemplateSampling ?? 1,
    enablePlaywrightSampling: overrides.enablePlaywrightSampling ?? 0,
    enableLighthouseSampling: overrides.enableLighthouseSampling ?? 0
  }).lastInsertRowid;
}

function insertPage(db, runId, url, {
  pageType = 'other',
  indexable = 1,
  wordCountRaw = 120,
  h1Count = 1,
  schemaTypes = []
} = {}) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, h1Json, h1Count, wordCountRaw, internalLinksCount,
      externalLinksCount, schemaTypesJson, pageType
    )
    VALUES (?, ?, ?, ?, 1, 200, 'text/html; charset=utf-8',
      ?, 'Sample', '["Sample"]', ?, ?, 2, 1, ?, ?)
  `).run(runId, url, url, url, indexable, h1Count, wordCountRaw, JSON.stringify(schemaTypes), pageType);
}

function insertSampleResult(db, runId, templateClusterKey, url) {
  db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus
    )
    VALUES (?, ?, ?, ?, 'template_cluster_sample', 'success', 'success')
  `).run(runId, templateClusterKey, url, url);
}

function insertPlaywrightResult(db, runId, templateClusterKey, url, overrides = {}) {
  db.prepare(`
    INSERT INTO playwright_results (
      runId, templateClusterKey, url, status, finalUrl, title, h1Count,
      renderedWordCount, renderedLinksCount, rawRenderedWordDelta,
      consoleErrorsCount, consoleErrorsJson, networkErrorsCount, networkErrorsJson,
      pageErrorsCount, pageErrorsJson, cspViolationsJson, navigationError,
      textNormalizationVersion, jsRequiredLikely, loadTimeMs
    )
    VALUES (
      @runId, @templateClusterKey, @url, 'success', @url, 'Rendered', 1,
      200, 4, 80, @consoleErrorsCount, '[]', 0, '[]',
      0, '[]', '[]', NULL, 'visible_text_v1', @jsRequiredLikely, 100
    )
  `).run({
    runId,
    templateClusterKey,
    url,
    consoleErrorsCount: overrides.consoleErrorsCount ?? 0,
    jsRequiredLikely: overrides.jsRequiredLikely ?? 0
  });
}

function insertLighthouseResult(db, runId, templateClusterKey, url, overrides = {}) {
  db.prepare(`
    INSERT INTO lighthouse_results (
      runId, templateClusterKey, url, device, performanceScore, accessibilityScore,
      bestPracticesScore, seoScore, firstContentfulPaintMs, largestContentfulPaintMs,
      totalBlockingTimeMs, cumulativeLayoutShift, speedIndexMs, interactiveMs,
      totalByteWeight, domSize, auditsJson, errorMessage
    )
    VALUES (
      @runId, @templateClusterKey, @url, 'mobile', @performanceScore, 0.9,
      0.9, @seoScore, 1000, @largestContentfulPaintMs,
      @totalBlockingTimeMs, @cumulativeLayoutShift, 1200, 2000,
      100000, 800, '{}', NULL
    )
  `).run({
    runId,
    templateClusterKey,
    url,
    performanceScore: overrides.performanceScore ?? 0.8,
    seoScore: overrides.seoScore ?? 0.9,
    largestContentfulPaintMs: overrides.largestContentfulPaintMs ?? 2000,
    totalBlockingTimeMs: overrides.totalBlockingTimeMs ?? 100,
    cumulativeLayoutShift: overrides.cumulativeLayoutShift ?? 0.05
  });
}

function result(db, runId, checkId) {
  return db.prepare('SELECT * FROM check_results WHERE runId = ? AND checkId = ?').get(runId, checkId);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}
