import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  deleteRun,
  getRunComparison,
  listComparisonCandidates,
  saveRunComparison
} from '../src/db/repositories.js';
import {
  compareRuns,
  comparePerformanceDelta,
  compareTemplateDelta,
  compareUrlDelta
} from '../src/comparison/runComparison.js';
import { collectComparisonCsv } from '../src/reports/comparisonCsvExporter.js';
import { renderComparisonReport } from '../src/reports/comparisonReportGenerator.js';

test('migration creates run_comparisons with persisted delta columns', () => {
  const db = setupDb();
  const columns = db.prepare('PRAGMA table_info(run_comparisons)').all().map((column) => column.name);
  for (const column of [
    'id',
    'baseRunId',
    'compareRunId',
    'summaryJson',
    'findingsDeltaJson',
    'urlDeltaJson',
    'templateDeltaJson',
    'performanceDeltaJson',
    'regressionFindingsJson',
    'warningsJson'
  ]) {
    assert.ok(columns.includes(column), `${column} should exist`);
  }
  db.close();
});

test('comparison candidates only include completed runs from the same normalized domain', () => {
  const db = setupDb();
  const projectId = insertProject(db, 'https://www.example.com', 'https://example.com');
  const targetRunId = insertRun(db, projectId, { status: 'completed' });
  const candidateRunId = insertRun(db, projectId, { status: 'completed' });
  insertRun(db, projectId, { status: 'running' });
  const otherProjectId = insertProject(db, 'https://other.example', 'https://other.example');
  insertRun(db, otherProjectId, { status: 'completed' });

  const candidates = listComparisonCandidates(db, targetRunId);
  assert.deepEqual(candidates.map((row) => row.runId), [candidateRunId]);
  db.close();
});

test('compareRuns detects finding, URL, template, performance and regression deltas', () => {
  const db = setupDb();
  const { baseRunId, compareRunId } = createComparisonFixture(db);

  const comparison = compareRuns(db, { baseRunId, compareRunId });
  assert.equal(comparison.status, 'completed');

  const findings = new Map(comparison.findingsDelta.map((row) => [row.checkId, row]));
  assert.equal(findings.get('tech.title')?.deltaType, 'new');
  assert.equal(findings.get('tech.meta')?.deltaType, 'resolved');
  assert.equal(findings.get('tech.canonical')?.deltaType, 'worsened');
  assert.equal(findings.get('tech.h1')?.deltaType, 'improved');
  assert.equal(findings.get('tech.alt')?.deltaType, 'unchanged_issue');

  const urls = new Map(comparison.urlDelta.map((row) => [row.url, row]));
  assert.equal(urls.get('https://example.com/new')?.deltaType, 'newUrl');
  assert.equal(urls.get('https://example.com/old')?.deltaType, 'removedUrl');
  assert.equal(urls.get('https://example.com/status')?.deltaType, 'statusChanged');
  assert.equal(urls.get('https://example.com/')?.deltaType, 'titleChanged');

  const templates = new Map(comparison.templateDelta.map((row) => [row.templateClusterKey, row]));
  assert.equal(templates.get('product')?.deltaType, 'urlCountChanged');
  assert.equal(templates.get('article')?.deltaType, 'newTemplate');

  const performance = new Map(comparison.performanceDelta.map((row) => [row.templateClusterKey, row]));
  assert.equal(performance.get('product')?.deltaType, 'performanceRegressed');
  assert.equal(performance.get('faq')?.deltaType, 'lighthouseUnavailableInOneRun');
  assert.equal(performance.get('legacy')?.deltaType, 'notComparable');

  assert.ok(comparison.regressionFindings.some((row) => row.id === 'regression.new_high_priority_issue'));
  assert.equal(comparison.summary.findingDeltaCounts.new, 2);
  assert.equal(comparison.summary.regressionFindingCount, comparison.regressionFindings.length);
  db.close();
});

test('different domains return a not-comparable comparison with warning instead of throwing', () => {
  const db = setupDb();
  const baseRunId = insertRun(db, insertProject(db, 'https://example.com'), { status: 'completed' });
  const compareRunId = insertRun(db, insertProject(db, 'https://other.example'), { status: 'completed' });

  const comparison = compareRuns(db, { baseRunId, compareRunId });
  assert.equal(comparison.status, 'not_comparable');
  assert.equal(comparison.summary.notComparableReason, 'different_domain');
  assert.match(comparison.comparisonWarning, /different domains/i);
  db.close();
});

test('comparison repository saves, reads and deletes persisted comparisons with runs', () => {
  const db = setupDb();
  const { baseRunId, compareRunId } = createComparisonFixture(db);
  const comparison = compareRuns(db, { baseRunId, compareRunId });

  const saved = saveRunComparison(db, comparison);
  assert.equal(saved.baseRunId, baseRunId);
  assert.equal(saved.compareRunId, compareRunId);
  assert.ok(saved.findingsDelta.length > 0);
  assert.ok(saved.regressionFindings.length > 0);

  const loaded = getRunComparison(db, saved.id);
  assert.equal(loaded.summary.baseRunId, baseRunId);
  assert.equal(loaded.performanceDelta.length, comparison.performanceDelta.length);

  assert.equal(deleteRun(db, baseRunId), true);
  assert.equal(getRunComparison(db, saved.id), null);
  db.close();
});

test('comparison CSV exports expose stable headers for all delta types', () => {
  const db = setupDb();
  const { baseRunId, compareRunId } = createComparisonFixture(db);
  const comparison = compareRuns(db, { baseRunId, compareRunId });

  assert.equal(collectComparisonCsv(comparison, 'findings-delta').split('\n')[0], 'checkId,category,checkName,deltaType,baseStatus,compareStatus,basePriority,comparePriority,baseScore,compareScore,baseAffectedCount,compareAffectedCount,affectedDelta,findingType,confidence,reviewRecommended,sampleUrlsAdded,sampleUrlsRemoved,sampleUrlsStillAffected');
  assert.equal(collectComparisonCsv(comparison, 'url-delta').split('\n')[0], 'url,deltaType,baseStatusCode,compareStatusCode,baseIndexable,compareIndexable,baseTitle,compareTitle,baseCanonical,compareCanonical,basePageType,comparePageType');
  assert.equal(collectComparisonCsv(comparison, 'template-delta').split('\n')[0], 'templateClusterKey,deltaType,baseUrlCount,compareUrlCount,urlCountDelta,baseIndexableCount,compareIndexableCount,baseAvgWordCount,compareAvgWordCount,avgWordCountDelta,baseSchemaTypesSummary,compareSchemaTypesSummary');
  assert.equal(collectComparisonCsv(comparison, 'performance-delta').split('\n')[0], 'templateClusterKey,deltaType,baseAvgPerformanceScore,compareAvgPerformanceScore,performanceScoreDelta,baseAvgLcpMs,compareAvgLcpMs,lcpDeltaMs,baseAvgTbtMs,compareAvgTbtMs,tbtDeltaMs,baseAvgCls,compareAvgCls,clsDelta,baseConsoleErrorSampleCount,compareConsoleErrorSampleCount');
  db.close();
});

test('comparison report contains executive summary and escapes dynamic content', () => {
  const db = setupDb();
  const { baseRunId, compareRunId } = createComparisonFixture(db);
  const comparison = compareRuns(db, { baseRunId, compareRunId });
  const html = renderComparisonReport(comparison);

  assert.match(html, /Executive Delta Summary/);
  assert.match(html, /New Issues/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  db.close();
});

test('standalone delta helpers classify not-comparable edge cases', () => {
  assert.equal(compareUrlDelta([], [{ url: 'https://example.com/', normalizedUrl: 'https://example.com/' }])[0].deltaType, 'newUrl');
  assert.equal(compareTemplateDelta([{ clusterKey: 'a', urlCount: 1 }], [])[0].deltaType, 'removedTemplate');
  assert.equal(comparePerformanceDelta([{ templateClusterKey: 'a', lighthouseSuccessCount: 1 }], [])[0].deltaType, 'notComparable');
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createComparisonFixture(db) {
  const projectId = insertProject(db, 'https://example.com', 'https://example.com');
  const baseRunId = insertRun(db, projectId, { status: 'completed', processedUrls: 3, successfulUrls: 3 });
  const compareRunId = insertRun(db, projectId, { status: 'completed', processedUrls: 4, successfulUrls: 3, failedUrls: 1 });

  insertCheckResult(db, baseRunId, { checkId: 'tech.title', status: 'OK', priority: 'Low', score: 10, affectedCount: 0 });
  insertCheckResult(db, compareRunId, { checkId: 'tech.title', status: 'Warning', priority: 'High', score: 4, affectedCount: 2, finding: 'New high title issue', sampleUrls: ['https://example.com/new'] });

  insertCheckResult(db, baseRunId, { checkId: 'tech.meta', status: 'Warning', priority: 'Low', score: 5, affectedCount: 1, sampleUrls: ['https://example.com/old'] });
  insertCheckResult(db, compareRunId, { checkId: 'tech.meta', status: 'OK', priority: 'Low', score: 10, affectedCount: 0 });

  insertCheckResult(db, baseRunId, { checkId: 'tech.canonical', status: 'Warning', priority: 'Low', score: 6, affectedCount: 1 });
  insertCheckResult(db, compareRunId, { checkId: 'tech.canonical', status: 'Error', priority: 'High', score: 2, affectedCount: 3 });

  insertCheckResult(db, baseRunId, { checkId: 'tech.h1', status: 'Error', priority: 'High', score: 1, affectedCount: 3 });
  insertCheckResult(db, compareRunId, { checkId: 'tech.h1', status: 'Warning', priority: 'Medium', score: 4, affectedCount: 2 });

  insertCheckResult(db, baseRunId, { checkId: 'tech.alt', status: 'Warning', priority: 'Medium', score: 5, affectedCount: 1 });
  insertCheckResult(db, compareRunId, { checkId: 'tech.alt', status: 'Warning', priority: 'Medium', score: 5, affectedCount: 1 });

  insertCheckResult(db, compareRunId, {
    checkId: 'tech.xss',
    status: 'Warning',
    priority: 'Low',
    score: 5,
    affectedCount: 1,
    finding: '<script>alert(1)</script>'
  });

  insertPage(db, baseRunId, { url: 'https://example.com/', statusCode: 200, indexable: 1, title: 'Old title', canonical: 'https://example.com/', pageType: 'homepage' });
  insertPage(db, compareRunId, { url: 'https://example.com/', statusCode: 200, indexable: 1, title: 'New title', canonical: 'https://example.com/', pageType: 'homepage' });
  insertPage(db, baseRunId, { url: 'https://example.com/old', statusCode: 200, indexable: 1, title: 'Old', canonical: 'https://example.com/old', pageType: 'article' });
  insertPage(db, compareRunId, { url: 'https://example.com/new', statusCode: 200, indexable: 1, title: 'New', canonical: 'https://example.com/new', pageType: 'article' });
  insertPage(db, baseRunId, { url: 'https://example.com/status', statusCode: 200, indexable: 1, title: 'Status', canonical: 'https://example.com/status', pageType: 'other' });
  insertPage(db, compareRunId, { url: 'https://example.com/status', statusCode: 404, indexable: 1, title: 'Status', canonical: 'https://example.com/status', pageType: 'other' });

  insertTemplate(db, baseRunId, { clusterKey: 'product', urlCount: 5, indexableCount: 5, avgWordCount: 300, schema: '{"Product":5}' });
  insertTemplate(db, compareRunId, { clusterKey: 'product', urlCount: 8, indexableCount: 8, avgWordCount: 315, schema: '{"Product":8}' });
  insertTemplate(db, compareRunId, { clusterKey: 'article', urlCount: 2, indexableCount: 2, avgWordCount: 900, schema: '{"Article":2}' });

  insertPerformance(db, baseRunId, { templateClusterKey: 'product', lighthouseSuccessCount: 2, avgPerformanceScore: 0.92, avgLcpMs: 900, avgTbtMs: 60, avgCls: 0.01 });
  insertPerformance(db, compareRunId, { templateClusterKey: 'product', lighthouseSuccessCount: 2, avgPerformanceScore: 0.7, avgLcpMs: 1800, avgTbtMs: 220, avgCls: 0.08 });
  insertPerformance(db, baseRunId, { templateClusterKey: 'faq', lighthouseSuccessCount: 1, avgPerformanceScore: 0.9 });
  insertPerformance(db, compareRunId, { templateClusterKey: 'faq', lighthouseSuccessCount: 0, avgPerformanceScore: null });
  insertPerformance(db, baseRunId, { templateClusterKey: 'legacy', lighthouseSuccessCount: 1, avgPerformanceScore: 0.8 });

  return { baseRunId, compareRunId };
}

function insertProject(db, inputDomain, finalDomain = inputDomain) {
  return db.prepare('INSERT INTO projects (inputDomain, finalDomain, brandName) VALUES (?, ?, ?)').run(inputDomain, finalDomain, 'Example').lastInsertRowid;
}

function insertRun(db, projectId, overrides = {}) {
  const run = {
    status: 'completed',
    auditType: 'both',
    currentPhase: 'completed',
    processedUrls: 0,
    successfulUrls: 0,
    failedUrls: 0,
    ...overrides
  };
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, processedUrls, successfulUrls,
      failedUrls, startedAt, finishedAt
    )
    VALUES (?, ?, ?, 20, 2, 1, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(projectId, run.status, run.auditType, run.currentPhase, run.processedUrls, run.successfulUrls, run.failedUrls).lastInsertRowid;
}

function insertCheckResult(db, runId, overrides = {}) {
  const row = {
    checkId: 'tech.fixture',
    category: 'Technical SEO',
    checkName: overrides.checkId || 'Fixture Check',
    status: 'Warning',
    priority: 'Medium',
    effort: 'M',
    score: 5,
    finding: 'Fixture finding',
    details: 'Based on fixture evidence.',
    recommendation: 'Fix the fixture issue.',
    affectedCount: 1,
    sampleUrls: ['https://example.com/'],
    evidence: { fixture: true },
    reportGroupingKey: overrides.checkId || 'tech.fixture',
    findingType: 'core_issue',
    confidence: 'high',
    reviewRecommended: 0,
    ...overrides
  };
  return db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson,
      evidenceJson, reportGroupingKey, findingType, confidence, reviewRecommended
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    row.checkId,
    row.category,
    row.checkName,
    row.status,
    row.priority,
    row.effort,
    row.score,
    row.finding,
    row.details,
    row.recommendation,
    row.affectedCount,
    JSON.stringify(row.sampleUrls || []),
    JSON.stringify(row.evidence || {}),
    row.reportGroupingKey,
    row.findingType,
    row.confidence,
    row.reviewRecommended ? 1 : 0
  ).lastInsertRowid;
}

function insertPage(db, runId, row) {
  db.prepare(`
    INSERT INTO pages (runId, url, normalizedUrl, depth, statusCode, indexable, title, canonical, pageType)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(runId, row.url, row.url, row.statusCode, row.indexable, row.title, row.canonical, row.pageType);
}

function insertTemplate(db, runId, row) {
  db.prepare(`
    INSERT INTO template_clusters (
      runId, clusterKey, urlPattern, urlCount, indexableCount, avgWordCount, schemaTypesSummaryJson
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, row.clusterKey, `/${row.clusterKey}/:slug`, row.urlCount, row.indexableCount, row.avgWordCount, row.schema);
}

function insertPerformance(db, runId, row) {
  db.prepare(`
    INSERT INTO template_performance_summary (
      runId, templateClusterKey, sampleCount, lighthouseSuccessCount,
      avgPerformanceScore, minPerformanceScore, avgLcpMs, avgTbtMs, avgCls,
      jsRequiredCount, consoleErrorSampleCount
    )
    VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    runId,
    row.templateClusterKey,
    row.lighthouseSuccessCount,
    row.avgPerformanceScore,
    row.avgPerformanceScore,
    row.avgLcpMs ?? null,
    row.avgTbtMs ?? null,
    row.avgCls ?? null
  );
}
