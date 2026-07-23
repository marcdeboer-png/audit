import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  insertCheckResults,
  updateProject,
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { buildMaturityModel, maturityPointForResult } from '../src/maturity/maturityService.js';
import { getMappedCheckIds, getMaturityCategoryForCheck } from '../src/maturity/maturityCategories.js';
import { collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('maturity categories map every registered check id and keep unknown checks visible', () => {
  const mapped = getMappedCheckIds();
  const registered = [...techChecks(), ...geoChecks()].map((check) => check.id);

  for (const checkId of registered) {
    assert.equal(mapped.has(checkId), true, `${checkId} has a maturity category`);
  }

  assert.equal(getMaturityCategoryForCheck({ checkId: 'tech.title_missing' }), 'html-head');
  assert.equal(getMaturityCategoryForCheck({ checkId: 'geo.robots_mentions_gptbot' }), 'ai-crawler-policy');
  assert.equal(getMaturityCategoryForCheck({ checkId: 'template.low_lighthouse_performance' }), 'media-performance');
  assert.equal(getMaturityCategoryForCheck({ checkId: 'tech.custom_future_check' }), 'uncategorized');
});

test('maturity model scores existing findings without creating new checks', () => {
  const db = setupDb();
  const { runId } = seedMaturityFixture(db);

  const model = buildMaturityModel(db, runId);

  assert.equal(model.runId, runId);
  assert.equal(model.domain, 'https://example.com');
  assert.equal(model.totalChecks, 7);
  assert.equal(model.evaluatedChecks, 6);
  assert.equal(model.excludedChecks, 1);
  assert.equal(model.passedChecks, 2);
  assert.equal(model.actionItems, 3);
  assert.equal(model.opportunities, 0);
  assert.equal(model.bestPracticeWarnings, 1);
  assert.equal(model.maturityScore, 6);
  assert.equal(model.weightedScore, 6);
  assert.equal(model.unweightedScore, 5.3);
  assert.equal(model.checkAverageScore, 5.3);
  assert.equal(model.scoreScale, '0-10');
  assert.ok(model.categories.find((category) => category.id === 'html-head'));
  assert.ok(model.categories.find((category) => category.id === 'security-server'));
  assert.deepEqual(model.uncategorizedCheckIds, ['tech.custom_future_check']);
  assert.ok(model.weaknesses.some((item) => item.categoryId === 'html-head'));
  assert.ok(model.quickWins.some((item) => item.checkId === 'tech.title_missing'));
  assert.ok(model.managementSummary.headline);
  assert.ok(model.topStrengths.length <= 5);
  assert.ok(model.topWeaknesses.length <= 5);
  assert.ok(model.quickWins.length <= 5);
  assert.ok(model.strategicNextSteps.length <= 5);
  assert.equal(model.scoringModel.Opportunity, 6);
  assert.equal(model.scoringModel.MissingOrUnavailableSignal, 1);
  assert.equal(model.scoringModel.MissingGeoAvailability, 1);
  assert.equal(model.scoringModel.ImplicitAiCrawlerPolicy, 1);
  assert.equal(model.scoringModel.BestPracticeWarning, 6);

  db.close();
});

test('maturity point mapping treats opportunities and best practices as medium signals and N/A as excluded', () => {
  assert.deepEqual(maturityPointForResult({ status: 'OK' }), { score: 10, weight: 1, excluded: false });
  assert.deepEqual(maturityPointForResult({ status: 'Warning', normalizedFindingType: 'opportunity' }), { score: 6, weight: 1, excluded: false });
  assert.deepEqual(maturityPointForResult({ checkId: 'geo.llms_txt_present', status: 'Warning', normalizedFindingType: 'opportunity' }), { score: 1, weight: 1, excluded: false, reason: 'missing_geo_availability' });
  assert.deepEqual(maturityPointForResult({ checkId: 'geo.ai_bots_policy_summary', status: 'Warning', normalizedFindingType: 'opportunity' }), { score: 1, weight: 1, excluded: false, reason: 'implicit_ai_policy' });
  assert.deepEqual(maturityPointForResult({ checkId: 'tech.webmanifest_missing', status: 'Warning', normalizedFindingType: 'opportunity', finding: 'Webmanifest missing.' }), { score: 1, weight: 1, excluded: false, reason: 'missing_or_unavailable_signal' });
  assert.deepEqual(maturityPointForResult({ checkId: 'geo.llms_txt_http_status', status: 'OK', normalizedFindingType: 'info', finding: 'llms.txt status recorded: 404.' }), { score: 1, weight: 1, excluded: false, reason: 'contradictory_missing_evidence' });
  assert.deepEqual(maturityPointForResult({ status: 'Warning', normalizedFindingType: 'best_practice' }), { score: 6, weight: 1, excluded: false });
  assert.deepEqual(maturityPointForResult({ status: 'Warning', normalizedFindingType: 'core_issue' }), { score: 4, weight: 1, excluded: false });
  assert.deepEqual(maturityPointForResult({ status: 'Error', normalizedFindingType: 'core_issue' }), { score: 1, weight: 1, excluded: false });
  assert.equal(maturityPointForResult({ status: 'NA' }).excluded, true);
  assert.equal(maturityPointForResult({ checkId: 'template.lighthouse_unavailable', status: 'NA' }).excluded, true);
});

test('maturity API returns model, concrete 404 and 409 responses, plus JSON export', async () => {
  const temp = useTempAuditDb('batch91-maturity-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const { runId, runningRunId } = seedMaturityFixture(seedDb);
  seedDb.close();

  const apiPort = 37000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: temp.dbPath, PORT: String(apiPort), SCHEDULER_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);

    const ok = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${runId}/maturity`);
    assert.equal(ok.status, 200);
    const model = await ok.json();
    assert.equal(model.runId, runId);
    assert.equal(model.maturityScore, 6);
    assert.equal(model.weightedScore, 6);

    const exportResponse = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${runId}/export/maturity.json`);
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-disposition') || '', new RegExp(`audit-${runId}-maturity\\.json`));
    assert.equal((await exportResponse.json()).weightedScore, 6);

    const running = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${runningRunId}/maturity`);
    assert.equal(running.status, 409);
    assert.equal((await running.json()).error, 'Run not completed yet');

    const missing = await fetch(`http://127.0.0.1:${apiPort}/api/audits/999999/maturity`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'Run not found');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
  }
});

test('full audit exports include maturity working data', () => {
  const db = setupDb();
  const { runId } = seedMaturityFixture(db);

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  assert.equal(fullJson.maturity.runId, runId);
  assert.equal(fullJson.maturity.maturityScore, 6);
  assert.equal(fullJson.maturity.weightedScore, 6);
  assert.ok(Array.isArray(fullJson.maturity.categories));

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries['summary/maturity.json']);
  const zipMaturity = JSON.parse(zipEntries['summary/maturity.json']);
  assert.equal(zipMaturity.runId, runId);
  assert.equal(zipMaturity.weightedScore, 6);

  db.close();
});

test('maturity UI source exposes branded route, export links and auto-redirect hook', () => {
  const app = readSource('../src/public/app.js');
  const css = readSource('../src/public/styles.css');
  const report = readSource('../src/reports/reportGenerator.js');

  assert.match(app, /#maturity\/\$\{runId\}/);
  assert.match(app, /GEO Visibility Reifegrad/);
  assert.match(app, /Reifegrad ansehen/);
  assert.match(app, /maturityAutoRedirectRunId/);
  assert.match(app, /\/api\/audits\/\$\{runId\}\/maturity/);
  assert.match(app, /export\/maturity\.json/);
  assert.match(css, /\.maturity-page/);
  assert.match(css, /\.maturity-bar-row/);
  assert.match(css, /\.maturity-insights/);
  assert.match(report, /GEO Visibility Reifegrad/);
  assert.doesNotMatch(`${app}\n${css}\n${report}`, /d3\.|spider-chart/i);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedMaturityFixture(db) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const config = normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 20,
    maxDepth: 2,
    concurrency: 1,
    enableTemplateSampling: true,
    enablePlaywrightSampling: true,
    enableLighthouseSampling: true
  });
  const runId = createRun(db, projectId, config);
  const runningRunId = createRun(db, projectId, config);
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 3,
    successfulUrls: 3,
    startedAt: '2026-06-29T08:00:00.000Z',
    finishedAt: '2026-06-29T08:03:00.000Z'
  });
  updateRun(db, runningRunId, {
    status: 'running',
    currentPhase: 'checks',
    processedUrls: 1,
    successfulUrls: 1,
    startedAt: '2026-06-29T08:00:00.000Z'
  });

  insertCheckResults(db, runId, [
    checkResult('tech.https_reachable', 'Server & Infrastructure', 'HTTPS reachable', 'OK', 'Low', 'info', { affectedCount: 0 }),
    checkResult('tech.title_missing', 'HTML Head & Meta', 'Title missing', 'Error', 'High', 'core_issue', { affectedCount: 2, sampleUrls: ['https://example.com/a', 'https://example.com/b'] }),
    checkResult('geo.robots_mentions_gptbot', 'AI Crawler Policy', 'GPTBot mentioned', 'Warning', 'Low', 'opportunity', { confidence: 'medium', reviewRecommended: true }),
    checkResult('tech.hsts_header', 'Security Best Practice', 'HSTS present', 'Warning', 'Medium', 'issue'),
    checkResult('template.lighthouse_unavailable', 'Template Performance', 'Lighthouse unavailable', 'NA', 'Low', 'info', { affectedCount: 0 }),
    checkResult('tech.custom_future_check', 'Experimental', 'Future custom check', 'Warning', 'Medium', 'core_issue'),
    checkResult('tech.webmanifest_missing', 'Browser Metadata Opportunity', 'Webmanifest missing', 'OK', 'Low', 'opportunity', { affectedCount: 0 })
  ]);

  return { runId, runningRunId };
}

function checkResult(id, category, name, status, priority, findingType, options = {}) {
  const affectedCount = options.affectedCount ?? (status === 'OK' || status === 'NA' ? 0 : 1);
  return {
    id,
    category,
    name,
    auditType: id.startsWith('geo.') ? 'geo' : 'tech',
    status,
    priority,
    effort: 'S',
    finding: `${name} finding`,
    details: `${name} details are based on stored evidence.`,
    recommendation: `${name} recommendation`,
    affectedCount,
    sampleUrls: options.sampleUrls || (affectedCount ? ['https://example.com/a'] : []),
    evidence: options.evidence || { affectedCount, status },
    reportGroupingKey: options.reportGroupingKey || null,
    findingType,
    confidence: options.confidence || 'high',
    reviewRecommended: Boolean(options.reviewRecommended)
  };
}

function readStoredZip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries[name] = buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    offset = dataStart + compressedSize;
  }
  return entries;
}

async function waitForApi(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/audits`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('API server did not start');
}

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
