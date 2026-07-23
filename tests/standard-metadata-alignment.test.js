import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { availabilityResult, makeResult } from '../src/checks/helpers.js';
import {
  AUDIT_STANDARD_VERSION,
  DISABLED_CHECK_IDS,
  STANDARD_ALIGNED_CHECK_IDS,
  applyStandardCheckMetadata,
  standardMetadataFor
} from '../src/checks/standardMetadata.js';
import { loadResultsWithScores } from '../src/checks/checkEngine.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import {
  loadCheckValidationRegistry,
  validateCheckValidationRegistry
} from '../src/validation/checkValidationRegistry.js';

const expectedDisabled = [
  'geo.llms_full_txt_present',
  'geo.speakable_present',
  'tech.speakable_missing'
];

test('the runtime registry applies 36 metadata alignments and exactly three deactivations', () => {
  const checks = [...techChecks(), ...geoChecks()];
  assert.equal(STANDARD_ALIGNED_CHECK_IDS.length, 39);
  assert.deepEqual([...DISABLED_CHECK_IDS].sort(), expectedDisabled);
  assert.equal(checks.length, 134);
  for (const id of expectedDisabled) assert.equal(checks.some((check) => check.id === id), false, id);
  assert.equal(checks.filter((check) => check.standardVersion === AUDIT_STANDARD_VERSION).length, 36);

  const byId = new Map(checks.map((check) => [check.id, check]));
  assert.equal(byId.get('tech.duplicate_titles').priority, 'Medium');
  assert.equal(byId.get('tech.h1_missing').priority, 'Medium');
  assert.equal(byId.get('tech.internal_links_to_3xx').priority, 'Low');
  assert.equal(byId.get('tech.redirect_pages').priority, 'Info');
  assert.equal(byId.get('tech.redirect_pages').diagnosticOnly, true);
  assert.equal(byId.get('tech.canonical_non_self').standardUsage, 'automated_with_limits');
  assert.equal(
    byId.get('geo.article_blog_pages_article_schema').standardScoreOwnerCheckId,
    'tech.article_coverage_on_article_like_pages'
  );
});

test('result metadata follows score, review, applicability and diagnostic policy without changing check logic', () => {
  const fullyAutomated = applyStandardCheckMetadata(fixtureCheck('tech.meta_description_missing'));
  const scored = makeResult(fullyAutomated, 'Warning', {
    evaluationState: 'fail',
    scoreEligible: false,
    reviewRecommended: true,
    evidence: { affectedCount: 1 },
    affectedCount: 1
  });
  assert.equal(scored.priority, 'Low');
  assert.equal(scored.scoreEligible, true);
  assert.equal(scored.reviewRecommended, false);
  assert.equal(scored.standardUsage, 'fully_automated');
  assert.match(scored.standardApplicability, /indexable HTML pages/);

  const unavailable = availabilityResult(fullyAutomated, 'insufficient_evidence', {
    evidence: { missing: 'effective document state' }
  });
  assert.equal(unavailable.scoreEligible, false);

  const diagnostic = makeResult(applyStandardCheckMetadata(fixtureCheck('tech.redirect_pages')), 'Warning', {
    evaluationState: 'fail',
    scoreEligible: true,
    reviewRecommended: true,
    evidence: { redirectCount: 2 }
  });
  assert.equal(diagnostic.priority, 'Info');
  assert.equal(diagnostic.findingType, 'info');
  assert.equal(diagnostic.scoreEligible, false);
  assert.equal(diagnostic.reviewRecommended, false);
  assert.equal(diagnostic.diagnosticOnly, true);

  const conditional = makeResult(applyStandardCheckMetadata(fixtureCheck('tech.canonical_non_self')), 'Warning', {
    evaluationState: 'fail',
    scoreEligible: false,
    reviewRecommended: true,
    evidence: { canonical: 'https://example.test/other' }
  });
  assert.equal(conditional.priority, 'Info');
  assert.equal(conditional.scoreEligible, false);
  assert.equal(conditional.reviewRecommended, true);
  assert.equal(conditional.standardReviewStatus, 'required_before_scoring');
});

test('registry records the same standard metadata and deprecation policy as runtime definitions', () => {
  const registry = loadCheckValidationRegistry();
  const activeChecks = [...techChecks(), ...geoChecks()];
  assert.deepEqual(validateCheckValidationRegistry(registry, activeChecks), []);
  const byId = new Map(registry.checks.map((entry) => [entry.check_id, entry]));

  for (const id of STANDARD_ALIGNED_CHECK_IDS) {
    const entry = byId.get(id);
    const standard = standardMetadataFor(id);
    assert.equal(entry.standard_version, AUDIT_STANDARD_VERSION, id);
    assert.equal(entry.standard_usage, standard.usage, id);
    assert.equal(entry.standard_score_effect, standard.scoreEffect, id);
    assert.equal(entry.standard_finding_type, standard.findingType, id);
    assert.equal(entry.finding_type, standard.findingType, id);
    assert.equal(entry.applicability, standard.applicability, id);
    assert.equal(entry.not_applicable_rule, standard.notApplicableRule, id);
    assert.equal(entry.rollup_role, standard.rollupRole, id);
    assert.equal(entry.pattern_role, standard.patternRole, id);
  }

  for (const id of expectedDisabled) {
    const entry = byId.get(id);
    assert.equal(entry.active, false, id);
    assert.equal(entry.validation_status, 'deprecated', id);
    assert.equal(entry.default_severity, 'None', id);
    assert.equal(entry.score_effect, 'score_free', id);
    assert.equal(entry.recommended_trust_action, 'disabled', id);
  }
});

test('HTML, JSON, CSV, detail API data and UI source expose the same standard metadata', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertHistoricalResult(db, runId);

  const result = loadResultsWithScores(db, runId).results[0];
  assertStandardMetadata(result);

  const csv = collectCsvExport(db, runId, 'findings');
  const csvResult = csvRow(csv, 'tech.meta_description_missing');
  assert.equal(csvResult.standardVersion, AUDIT_STANDARD_VERSION);
  assert.equal(csvResult.standardUsage, 'fully_automated');
  assert.equal(csvResult.standardScoreEffect, 'score_capable');
  assert.equal(csvResult.scoreEligible, 'true');

  const reviewsCsv = collectCsvExport(db, runId, 'reviews');
  const reviewResult = csvRow(reviewsCsv, 'tech.meta_description_missing');
  assert.equal(reviewResult.standardUsage, 'fully_automated');
  assert.match(reviewResult.standardApplicability, /indexable HTML pages/);
  assert.equal(reviewResult.standardReviewStatus, 'not_required');

  const json = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  const jsonResult = json.findings.find((row) => row.checkId === 'tech.meta_description_missing');
  assertStandardMetadata(jsonResult);

  const detail = getCheckDetail(db, runId, result.id);
  assertStandardMetadata(detail);

  const html = generateReportHtml(db, runId);
  assert.match(html, /standard: fully_automated/);

  const uiSource = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(uiSource, /standardUsage/);
  assert.match(uiSource, /Audit-Standard/);
  db.close();
});

function fixtureCheck(id) {
  return {
    id,
    category: 'Fixture',
    name: id,
    auditType: id.startsWith('geo.') ? 'geo' : 'tech',
    priority: 'Medium',
    effort: 'S'
  };
}

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain, brandName) VALUES ('example.com', 'https://example.com', 'Example')").run().lastInsertRowid;
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, startedAt
    )
    VALUES (?, 'completed', 'tech', 20, 2, 1, 0, 'completed', CURRENT_TIMESTAMP)
  `).run(projectId).lastInsertRowid;
}

function insertHistoricalResult(db, runId) {
  db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson,
      evidenceJson, factsJson, requirementsJson, evaluationState, scoreEligible,
      scoreExclusionReason, findingType, confidence, reviewRecommended,
      automationCoverage, reportGroupingKey
    )
    VALUES (
      ?, 'tech.meta_description_missing', 'HTML Head & Meta', 'Meta description missing',
      'Warning', 'Low', 'S', NULL, 'Historical metadata finding', 'Fixture details',
      'Add a description.', 1, '["https://example.com/"]', '{"affectedCount":1}',
      '{"completeEffectiveDocumentState":true}', '{}', 'fail', 0,
      'historical_review_policy', 'opportunity', 'high', 1,
      'requires_human_review', 'html_head.meta_description'
    )
  `).run(runId);
}

function assertStandardMetadata(row) {
  assert.equal(row.standardVersion, AUDIT_STANDARD_VERSION);
  assert.equal(row.standardStatus, 'active');
  assert.equal(row.standardUsage, 'fully_automated');
  assert.equal(row.standardSeverity, 'Low');
  assert.equal(row.standardScoreEffect, 'score_capable');
  assert.equal(row.standardFindingType, 'core_issue');
  assert.equal(row.findingType, 'core_issue');
  assert.equal(Boolean(row.diagnosticOnly), false);
  assert.equal(Boolean(row.disabled), false);
  assert.equal(Boolean(row.scoreEligible), true);
}

function csvRow(csv, checkId) {
  const [headerLine, ...lines] = csv.trim().split('\n');
  const headers = parseCsvLine(headerLine);
  for (const line of lines) {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    if (row.checkId === checkId) return row;
  }
  throw new Error(`CSV row not found: ${checkId}`);
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function generateReportHtml(db, runId) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-standard-metadata-'));
  try {
    process.chdir(tempDir);
    return fs.readFileSync(generateReport(db, runId), 'utf8');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
