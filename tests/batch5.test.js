import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  bulkUpsertFindingReviews,
  deleteReview,
  deleteRun,
  getReviewForCheckResult,
  getReviewSummary,
  upsertFindingReview
} from '../src/db/repositories.js';
import { loadResultsWithScores } from '../src/checks/checkEngine.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('migration creates finding_reviews table with unique check result reviews', () => {
  const db = setupDb();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finding_reviews'").get());
  const columns = db.prepare('PRAGMA table_info(finding_reviews)').all().map((column) => column.name);
  for (const column of [
    'id',
    'runId',
    'checkResultId',
    'reviewStatus',
    'reviewerName',
    'note',
    'manualStatus',
    'manualPriority',
    'manualEffort',
    'manualFinding',
    'manualRecommendation',
    'actionStatus',
    'createdAt',
    'updatedAt'
  ]) {
    assert.ok(columns.includes(column), `${column} should exist`);
  }
  db.close();
});

test('upsertFindingReview creates and updates a single current review', () => {
  const db = setupDb();
  const runId = createRun(db);
  const checkResultId = insertCheckResult(db, runId, { status: 'Warning', priority: 'Medium' });

  const created = upsertFindingReview(db, runId, checkResultId, {
    reviewStatus: 'confirmed',
    actionStatus: 'planned',
    reviewerName: 'QA',
    note: 'Validated against evidence.',
    manualStatus: 'Error',
    manualPriority: 'High',
    manualEffort: 'L',
    manualFinding: 'Manual finding',
    manualRecommendation: 'Manual recommendation'
  });

  assert.equal(created.reviewStatus, 'confirmed');
  assert.equal(created.manualStatus, 'Error');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finding_reviews WHERE checkResultId = ?').get(checkResultId).count, 1);

  const updated = upsertFindingReview(db, runId, checkResultId, {
    reviewStatus: 'needs_fix',
    actionStatus: 'in_progress',
    manualStatus: 'OK',
    manualPriority: 'Low'
  });

  assert.equal(updated.reviewStatus, 'needs_fix');
  assert.equal(updated.actionStatus, 'in_progress');
  assert.equal(updated.manualStatus, 'OK');
  assert.equal(updated.manualPriority, 'Low');
  assert.equal(updated.manualFinding, 'Manual finding');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finding_reviews WHERE checkResultId = ?').get(checkResultId).count, 1);
  db.close();
});

test('review validation rejects invalid statuses and requires check result ownership', () => {
  const db = setupDb();
  const runId = createRun(db);
  const otherRunId = createRun(db);
  const checkResultId = insertCheckResult(db, runId);

  assert.throws(
    () => upsertFindingReview(db, runId, checkResultId, { reviewStatus: 'bad' }),
    /reviewStatus must be one of/
  );
  assert.throws(
    () => upsertFindingReview(db, runId, checkResultId, { actionStatus: 'bad' }),
    /actionStatus must be one of/
  );
  assert.equal(upsertFindingReview(db, otherRunId, checkResultId, { reviewStatus: 'confirmed' }), null);
  db.close();
});

test('effective values use manual overrides without mutating original check results', () => {
  const db = setupDb();
  const runId = createRun(db);
  const checkResultId = insertCheckResult(db, runId, {
    status: 'Warning',
    priority: 'Medium',
    effort: 'M',
    finding: 'Original finding',
    recommendation: 'Original recommendation'
  });

  upsertFindingReview(db, runId, checkResultId, {
    manualStatus: 'Error',
    manualPriority: 'High',
    manualEffort: 'L',
    manualFinding: 'Manual finding',
    manualRecommendation: 'Manual recommendation'
  });

  const row = loadResultsWithScores(db, runId).results.find((result) => result.id === checkResultId);
  assert.equal(row.status, 'Warning');
  assert.equal(row.priority, 'Medium');
  assert.equal(row.effort, 'M');
  assert.equal(row.effectiveStatus, 'Error');
  assert.equal(row.effectivePriority, 'High');
  assert.equal(row.effectiveEffort, 'L');
  assert.equal(row.effectiveFinding, 'Manual finding');
  assert.equal(row.effectiveRecommendation, 'Manual recommendation');
  assert.equal(row.hasManualOverride, 1);
  db.close();
});

test('deleteReview removes the review and returns effective values to originals', () => {
  const db = setupDb();
  const runId = createRun(db);
  const checkResultId = insertCheckResult(db, runId, { status: 'Warning' });
  upsertFindingReview(db, runId, checkResultId, { manualStatus: 'OK', reviewStatus: 'confirmed' });

  assert.equal(deleteReview(db, runId, checkResultId), true);
  assert.equal(getReviewForCheckResult(db, checkResultId), null);
  const row = loadResultsWithScores(db, runId).results[0];
  assert.equal(row.reviewStatus, 'unreviewed');
  assert.equal(row.effectiveStatus, 'Warning');
  db.close();
});

test('bulk review updates several findings and summary counts reflect review state', () => {
  const db = setupDb();
  const runId = createRun(db);
  const first = insertCheckResult(db, runId, { checkId: 'tech.first', confidence: 'low', reviewRecommended: 1 });
  const second = insertCheckResult(db, runId, { checkId: 'tech.second', confidence: 'medium' });

  const updated = bulkUpsertFindingReviews(db, runId, [first, second], {
    reviewStatus: 'false_positive',
    actionStatus: 'wont_do',
    manualPriority: 'Low',
    note: 'Bulk reviewed.'
  });

  assert.equal(updated.length, 2);
  const summary = getReviewSummary(db, runId);
  assert.equal(summary.totalFindings, 2);
  assert.equal(summary.falsePositive, 2);
  assert.equal(summary.wontDo, 2);
  assert.equal(summary.reviewRecommendedCount, 0);
  assert.equal(summary.lowConfidenceCount, 0);
  assert.throws(() => bulkUpsertFindingReviews(db, runId, [], { reviewStatus: 'confirmed' }), /at least one/);
  db.close();
});

test('findings and reviews CSV expose review and effective columns', () => {
  const db = setupDb();
  const runId = createRun(db);
  const checkResultId = insertCheckResult(db, runId, { status: 'Warning', priority: 'Medium' });
  upsertFindingReview(db, runId, checkResultId, {
    reviewStatus: 'confirmed',
    actionStatus: 'done',
    reviewerName: 'Auditor',
    note: 'Checked.',
    manualStatus: 'OK',
    manualPriority: 'Low',
    manualEffort: 'S'
  });

  const findingsHeader = collectCsvExport(db, runId, 'findings').split('\n')[0];
  for (const column of [
    'checkId', 'category', 'checkName', 'status', 'priority', 'effort', 'score',
    'finding', 'details', 'recommendation', 'affectedCount', 'sampleUrls', 'evidence',
    'reviewStatus', 'actionStatus', 'reviewerName', 'reviewNote',
    'manualStatus', 'manualPriority', 'manualEffort',
    'effectiveStatus', 'effectivePriority', 'effectiveEffort', 'effectiveFinding',
    'effectiveRecommendation', 'confidence', 'reviewRecommended', 'findingType',
    'reportGroupingKey', 'displayStatus', 'displayReviewStatus', 'displayActionStatus',
    'isActionable', 'reportSection', 'normalizedFindingType', 'displayReviewRecommended'
  ]) {
    assert.ok(findingsHeader.split(',').includes(column), `${column} should be present`);
  }

  const reviewsHeader = collectCsvExport(db, runId, 'reviews').split('\n')[0];
  for (const column of [
    'checkId', 'category', 'checkName',
    'originalStatus', 'originalPriority', 'originalEffort',
    'effectiveStatus', 'effectivePriority', 'effectiveEffort',
    'reviewStatus', 'actionStatus', 'reviewerName', 'note',
    'findingType', 'confidence', 'reviewRecommended',
    'affectedCount', 'sampleUrls', 'displayStatus', 'displayReviewStatus',
    'displayActionStatus', 'isActionable', 'reportSection', 'normalizedFindingType',
    'displayReviewRecommended'
  ]) {
    assert.ok(reviewsHeader.split(',').includes(column), `${column} should be present`);
  }

  assert.match(collectCsvExport(db, runId, 'findings'), /confirmed,done,Auditor,Checked\.,OK,Low,S,OK,Low,S/);
  db.close();
});

test('deleteRun removes finding reviews for the run', () => {
  const db = setupDb();
  const runId = createRun(db);
  const checkResultId = insertCheckResult(db, runId);
  upsertFindingReview(db, runId, checkResultId, { reviewStatus: 'confirmed' });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finding_reviews WHERE runId = ?').get(runId).count, 1);
  assert.equal(deleteRun(db, runId), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM finding_reviews WHERE runId = ?').get(runId).count, 0);
  db.close();
});

test('false positive findings stay out of top core findings but remain visible in review report section', () => {
  const db = setupDb();
  const runId = createRun(db);
  const falsePositiveId = insertCheckResult(db, runId, {
    checkId: 'tech.false_positive_core',
    status: 'Error',
    priority: 'High',
    finding: 'False positive core finding'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.real_core',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Real core finding'
  });
  upsertFindingReview(db, runId, falsePositiveId, { reviewStatus: 'false_positive', actionStatus: 'wont_do' });

  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-batch5-'));
  try {
    process.chdir(tempDir);
    const reportPath = generateReport(db, runId);
    const html = fs.readFileSync(reportPath, 'utf8');
    const reviewSection = html.split('<h2>Review Summary</h2>')[1].split('<h2>Technical Appendix</h2>')[0];
    const coreSection = html.split('<h2>Action Items</h2>')[1].split('<h2>Confirmed / Needs Fix Findings</h2>')[0];

    assert.match(coreSection, /Real core finding/);
    assert.doesNotMatch(coreSection, /False positive core finding/);
    assert.match(reviewSection, /False positive core finding/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    db.close();
  }
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain) VALUES ('example.com', 'https://example.com')").run().lastInsertRowid;
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, startedAt
    )
    VALUES (?, 'completed', 'both', 10, 2, 1, 0, 'completed', CURRENT_TIMESTAMP)
  `).run(projectId).lastInsertRowid;
}

function insertCheckResult(db, runId, overrides = {}) {
  const row = {
    checkId: 'tech.example',
    category: 'Technical SEO',
    checkName: 'Example Check',
    status: 'Warning',
    priority: 'Medium',
    effort: 'M',
    score: 65,
    finding: 'Original finding',
    details: 'Based on stored evidence.',
    recommendation: 'Original recommendation',
    affectedCount: 1,
    sampleUrlsJson: '["https://example.com/"]',
    evidenceJson: '{"count":1}',
    reportGroupingKey: 'core.example',
    findingType: 'issue',
    confidence: 'high',
    reviewRecommended: 0,
    relatedCheckIdsJson: '[]',
    ...overrides
  };

  return db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson,
      reportGroupingKey, findingType, confidence, reviewRecommended, relatedCheckIdsJson
    )
    VALUES (
      @runId, @checkId, @category, @checkName, @status, @priority, @effort, @score,
      @finding, @details, @recommendation, @affectedCount, @sampleUrlsJson, @evidenceJson,
      @reportGroupingKey, @findingType, @confidence, @reviewRecommended, @relatedCheckIdsJson
    )
  `).run({ ...row, runId }).lastInsertRowid;
}
