import test from 'node:test';
import assert from 'node:assert/strict';
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
import { buildMaturityModel } from '../src/maturity/maturityService.js';
import { maturityCategoryWeights } from '../src/maturity/maturityCategories.js';
import { collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';

test('Batch 9.2 weighted score uses category scores instead of check volume', () => {
  const db = setupDb();
  const { runId } = seedWeightedDominanceFixture(db);

  const model = buildMaturityModel(db, runId);

  assert.equal(model.checkAverageScore, 8.8);
  assert.equal(model.unweightedScore, 3.3);
  assert.equal(model.weightedScore, 3.5);
  assert.equal(model.maturityScore, model.weightedScore);
  assert.equal(model.maturityLabel, 'Unausgereift');
  assert.equal(model.scoringModel.method, 'weighted_category_average');
  assert.equal(model.scoringModel.categoryWeights['geo-readiness'], 1.4);
  assert.equal(model.scoringModel.categoryWeights['structured-data'], 1.3);
  assert.equal(model.scoringModel.categoryWeights['security-server'], 0.5);
  assert.equal(maturityCategoryWeights['security-server'] < maturityCategoryWeights['geo-readiness'], true);

  const technical = model.categories.find((category) => category.id === 'technical-seo');
  const geo = model.categories.find((category) => category.id === 'geo-readiness');
  const security = model.categories.find((category) => category.id === 'security-server');
  assert.equal(technical.score, 10);
  assert.equal(geo.score, 1);
  assert.equal(security.score, 1);
  assert.equal(security.weightShare < geo.weightShare, true);

  db.close();
});

test('Batch 9.2 management summary and recommendations are derived from real categories or findings', () => {
  const db = setupDb();
  const { runId } = seedWeightedDominanceFixture(db);

  const model = buildMaturityModel(db, runId);

  assert.ok(model.managementSummary.headline);
  assert.ok(model.managementSummary.summaryText);
  assert.ok(model.managementSummary.mainStrength.categoryId);
  assert.ok(model.managementSummary.mainWeakness.categoryId);
  assert.equal(['critical', 'high', 'elevated', 'medium', 'low', 'very_low'].includes(model.managementSummary.riskLevel), true);
  assert.ok(model.managementSummary.recommendationFocus);

  for (const list of [model.topStrengths, model.topWeaknesses, model.quickWins, model.strategicNextSteps]) {
    assert.equal(list.length <= 5, true);
    for (const item of list) {
      assert.ok(item.categoryId || item.checkId, JSON.stringify(item));
      assert.ok(item.title);
      assert.notEqual(item.recommendation || item.description, 'TODO');
    }
  }

  assert.ok(model.topStrengths.some((item) => item.categoryId === 'technical-seo'));
  assert.ok(model.topWeaknesses.some((item) => item.categoryId === 'geo-readiness'));
  assert.ok(model.quickWins.some((item) => item.checkId === 'tech.hsts_header'));
  assert.ok(model.strategicNextSteps.some((item) => item.categoryId === 'structured-data'));

  db.close();
});

test('Batch 9.2 exports include weighted maturity fields and management narrative', () => {
  const db = setupDb();
  const { runId } = seedWeightedDominanceFixture(db);

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  assert.equal(fullJson.maturity.weightedScore, 3.5);
  assert.equal(fullJson.maturity.unweightedScore, 3.3);
  assert.ok(fullJson.maturity.managementSummary.headline);
  assert.ok(fullJson.maturity.scoringModel.categoryWeights);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  const zipMaturity = JSON.parse(zipEntries['summary/maturity.json']);
  assert.equal(zipMaturity.weightedScore, 3.5);
  assert.ok(zipMaturity.managementSummary.summaryText);
  assert.ok(zipMaturity.quickWins.length <= 5);

  db.close();
});

test('Batch 9.2 UI exposes management summary, compact score, weights and recommendation sections', () => {
  const app = readSource('../src/public/app.js');
  const css = readSource('../src/public/styles.css');

  assert.match(app, /Gesamtscore/);
  assert.match(app, /maturity-method-detail/);
  assert.match(app, /Management Summary/);
  assert.match(app, /Quick Wins/);
  assert.match(app, /Strategische nächste Schritte/);
  assert.match(app, /Gewicht \$\{escapeHtml\(category\.weight\)\}/);
  assert.match(app, /export\/maturity\.json/);
  assert.match(css, /\.management-summary/);
  assert.match(css, /\.maturity-list-tags/);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedWeightedDominanceFixture(db) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 20,
    maxDepth: 2,
    concurrency: 1,
    enableTemplateSampling: true,
    enablePlaywrightSampling: true,
    enableLighthouseSampling: true
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 20,
    successfulUrls: 20,
    startedAt: '2026-06-29T08:00:00.000Z',
    finishedAt: '2026-06-29T08:03:00.000Z'
  });

  const checks = [];
  for (let i = 0; i < 20; i += 1) {
    checks.push(checkResult('tech.https_reachable', 'Server & Infrastructure', `HTTPS reachable ${i + 1}`, 'OK', 'Low', 'info', { affectedCount: 0 }));
  }
  checks.push(checkResult('tech.organization_missing', 'Structured Data', 'Organization missing', 'Error', 'High', 'core_issue', { effort: 'M' }));
  checks.push(checkResult('geo.llms_txt_present', 'GEO Opportunities', 'llms.txt missing', 'Error', 'Medium', 'core_issue', { effort: 'S' }));
  checks.push(checkResult('tech.hsts_header', 'Security Best Practice', 'HSTS header missing', 'Warning', 'Medium', 'best_practice', { effort: 'S' }));
  insertCheckResults(db, runId, checks);

  return { runId };
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
    effort: options.effort || 'S',
    finding: `${name} finding`,
    details: `${name} details are based on stored evidence.`,
    recommendation: `${name} recommendation`,
    affectedCount,
    sampleUrls: affectedCount ? ['https://example.com/a'] : [],
    evidence: { affectedCount, status },
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

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
