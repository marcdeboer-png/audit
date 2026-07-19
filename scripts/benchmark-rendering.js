#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { processQueueItem } from '../src/crawler/pageProcessor.js';
import { launchBrowser } from '../src/extractors/renderExtractor.js';
import { buildTemplateClusters } from '../src/analysis/templateClusterer.js';
import { runDeterministicRenderPlan } from '../src/rendering/renderPlanRunner.js';
import { createRuntimeMetricsTracker } from '../src/runtime/renderMetrics.js';
import { runChecks, loadResultsWithScores } from '../src/checks/checkEngine.js';

const configPath = argument('--config');
if (!configPath) throw new Error('Usage: npm run benchmark:render -- --config /tmp/benchmark-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const outputDir = path.resolve(config.outputDir || '/tmp/audit-render-benchmark');
if (!outputDir.startsWith('/tmp/')) throw new Error('Benchmark outputDir must be under /tmp.');
fs.mkdirSync(outputDir, { recursive: true });
const strategies = config.strategies || ['raw_only', 'browser_all', 'deterministic_gate'];
const repetitions = Math.max(1, Number(config.repetitions || 1));
const results = [];

for (const target of config.domains || []) {
  validateTarget(target);
  for (const strategy of strategies) {
    const targetRepetitions = Math.max(1, Number(target.repetitions || repetitions));
    for (let repetition = 1; repetition <= targetRepetitions; repetition += 1) {
      results.push(await executeTarget(target, strategy, repetition));
    }
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  configPath: path.resolve(configPath),
  methodology: {
    concurrency: 1,
    maximumPagesPerSecond: 0.5,
    explicitUrlsOnly: true,
    productiveDatabase: false,
    screenshotHarDomStorage: false
  },
  results,
  analysis: buildBenchmarkAnalysis(results)
};
const outputPath = path.join(outputDir, 'benchmark-summary.json');
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
const manifest = fs.readdirSync(outputDir).sort().map((filename) => {
  const full = path.join(outputDir, filename);
  const stat = fs.statSync(full);
  return stat.isFile() ? { filename, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') } : null;
}).filter(Boolean);
fs.writeFileSync(path.join(outputDir, 'artifact-manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputDir, runs: results.length, summary: outputPath }, null, 2)}\n`);

async function executeTarget(target, strategy, repetition) {
  const slug = new URL(target.domain).hostname.replace(/[^a-z0-9.-]/gi, '-');
  const dbPath = path.join(outputDir, `${slug}-${strategy}-${repetition}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const db = new Database(dbPath);
  initDatabase(db);
  const playwrightMode = strategy === 'browser_all' ? 'all' : strategy === 'deterministic_gate' ? 'gate' : 'off';
  const auditConfig = normalizeAuditConfig({
    domain: target.domain,
    auditType: target.auditType || 'both',
    maxUrls: target.urls.length,
    maxDepth: 0,
    concurrency: 1,
    crawlMode: 'sitemap_only',
    usePlaywright: playwrightMode !== 'off',
    playwrightMode,
    metricsMode: config.metricsMode || 'profiling',
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false,
    storeRawHtml: false,
    storeRenderedHtml: false,
    maxRenderedUrls: config.renderBudget?.maxRenderedUrls,
    maxTotalRenderTimeMs: config.renderBudget?.maxTotalRenderTimeMs,
    maxSettlingTimeMsPerUrl: config.renderBudget?.maxSettlingTimeMsPerUrl,
    maxBrowserFailures: config.renderBudget?.maxBrowserFailures,
    maxPersistedRenderBytes: config.renderBudget?.maxPersistedRenderBytes
  });
  const projectId = createProject(db, { inputDomain: target.domain, brandName: target.archetype || null });
  const runId = Number(createRun(db, projectId, auditConfig));
  const hostname = new URL(target.domain).hostname;
  updateProject(db, projectId, { finalDomain: hostname });
  updateRun(db, runId, { status: 'running', currentPhase: 'benchmark', startedAt: new Date().toISOString() });
  const run = getRunWithProject(db, runId);
  const tracker = createRuntimeMetricsTracker(db, run);
  let browser = null;
  if (playwrightMode === 'all') {
    tracker.startPhase('browser_launch');
    browser = await launchBrowser();
    tracker.endPhase('browser_launch');
    tracker.recordBrowserLaunch({ success: Boolean(browser) });
  }
  const started = performance.now();
  const errors = [];
  try {
    let previousRequestStartedAt = 0;
    for (let index = 0; index < target.urls.length; index += 1) {
      const item = typeof target.urls[index] === 'string' ? { url: target.urls[index] } : target.urls[index];
      const waitMs = Math.max(0, 2000 - (Date.now() - previousRequestStartedAt));
      if (waitMs) await delay(waitMs);
      previousRequestStartedAt = Date.now();
      try {
        await processQueueItem(db, run, run, { url: item.url, normalizedUrl: item.url, depth: 0, sourceUrl: null }, browser, null, tracker);
        if (item.pageType) {
          db.prepare('UPDATE pages SET pageType=? WHERE runId=? AND url=?').run(item.pageType, runId, item.url);
          db.prepare('UPDATE url_runtime_metrics SET pageType=? WHERE runId=? AND url=?').run(item.pageType, runId, item.url);
        }
      } catch (error) {
        errors.push({ url: item.url, message: error.message });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  buildTemplateClusters(db, runId, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: target.urls.length });
  let renderPlan = null;
  if (playwrightMode === 'gate') renderPlan = await runDeterministicRenderPlan(db, getRunWithProject(db, runId), tracker);
  tracker.startPhase('checks');
  await runChecks(db, runId);
  tracker.endPhase('checks');
  updateRun(db, runId, { status: 'completed', currentPhase: 'completed', finishedAt: new Date().toISOString() });
  const runtime = tracker.finish({ status: 'completed' });
  const { scores, results: findings } = loadResultsWithScores(db, runId);
  const decisions = db.prepare('SELECT * FROM url_runtime_metrics WHERE runId=? ORDER BY url').all(runId);
  const pages = db.prepare('SELECT url,pageType,renderStatus,settlingStatus,metadataProvenanceComplete FROM pages WHERE runId=? ORDER BY url').all(runId);
  db.close();
  return {
    domain: target.domain,
    archetype: target.archetype || null,
    strategy,
    repetition,
    runId,
    database: path.basename(dbPath),
    configuredUrls: target.urls.length,
    successfulPages: pages.length,
    errors,
    wallDurationMs: Math.round(performance.now() - started),
    scoreStatus: scores.scoreStatus,
    score: scores.overallScore,
    weightedCoverage: scores.weightedCoverage,
    findingCounts: countBy(findings, (row) => row.evaluationState || row.status),
    rootCauseCount: scores.breakdown?.rootCauseCount ?? null,
    runtime: runtime ? { ...runtime, summaryJson: JSON.parse(runtime.summaryJson || '{}') } : null,
    renderPlan: renderPlan ? { ...renderPlan, plan: undefined } : null,
    decisions: decisions.map((row) => ({
      url: row.url,
      pageType: row.pageType,
      rawContentClass: row.rawContentClass,
      renderNeed: row.renderNeed,
      renderDecision: row.renderDecision,
      resultingBrowserRun: Boolean(row.resultingBrowserRun),
      settlingDurationMs: row.settlingDurationMs,
      snapshotCount: row.snapshotCount,
      renderProvenanceBytes: row.renderProvenanceBytes,
      renderStatus: row.renderStatus,
      finalSettlingStatus: row.finalSettlingStatus
    })),
    pages
  };
}

function validateTarget(target) {
  if (!target?.domain || !Array.isArray(target.urls) || !target.urls.length) throw new Error('Every benchmark target needs domain and explicit urls.');
  const primary = new URL(target.domain).hostname;
  for (const entry of target.urls) {
    const value = typeof entry === 'string' ? entry : entry.url;
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Unsupported URL protocol: ${value}`);
    if (url.hostname !== primary && !url.hostname.endsWith(`.${primary}`) && !primary.endsWith(`.${url.hostname}`)) throw new Error(`URL ${value} is outside configured target ${target.domain}`);
  }
}

function countBy(items, key) {
  return Object.fromEntries([...items.reduce((map, item) => map.set(key(item), (map.get(key(item)) || 0) + 1), new Map()).entries()].sort());
}

function buildBenchmarkAnalysis(allResults) {
  const primaryBrowserRuns = allResults.filter((row) => row.strategy === 'browser_all' && row.repetition === 1);
  const observations = primaryBrowserRuns.flatMap((run) => run.decisions
    .filter((row) => row.resultingBrowserRun && Number.isFinite(row.settlingDurationMs))
    .map((row) => ({ ...row, archetype: run.archetype || 'unknown' })));
  return {
    scope: 'browser_all_repetition_1',
    settlingOverall: numericDistribution(observations.map((row) => row.settlingDurationMs)),
    snapshotOverall: numericDistribution(observations.map((row) => row.snapshotCount)),
    settlingByArchetype: groupedNumericDistribution(observations, 'archetype'),
    settlingByPageType: groupedNumericDistribution(observations, 'pageType'),
    settlingByRawContentClass: groupedNumericDistribution(observations, 'rawContentClass'),
    settlingByRenderDecision: groupedNumericDistribution(observations, 'renderDecision'),
    settlingByStatus: groupedNumericDistribution(observations, 'finalSettlingStatus')
  };
}

function groupedNumericDistribution(rows, field) {
  return Object.fromEntries([...new Set(rows.map((row) => row[field] || 'unknown'))].sort().map((value) => [
    value,
    numericDistribution(rows.filter((row) => (row[field] || 'unknown') === value).map((row) => row.settlingDurationMs))
  ]));
}

function numericDistribution(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((total, value) => total + value, 0) / sorted.length : null,
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    maximum: sorted.length ? sorted.at(-1) : null
  };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * probability;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
