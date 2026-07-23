import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { computeScores, COVERAGE_MODEL_VERSION, scoringConfig } from '../src/utils/scoring.js';
import {
  applyEvidenceAvailability,
  AVAILABILITY_SEMANTICS_VERSION,
  EVIDENCE_CLASSES
} from '../src/coverage/evidenceCoverage.js';
import { getCsvExportSpec } from '../src/reports/csvExporter.js';
import { scoresForStoredRun } from '../src/checks/checkEngine.js';

test('primary evidence controls headline status while optional diagnostics stay separate', () => {
  const primary = Array.from({ length: 8 }, (_, index) => annotated(`tech.primary_${index}`, 'pass', EVIDENCE_CLASSES.primaryRequired));
  const missingOptional = Array.from({ length: 20 }, (_, index) => annotated(`geo.optional_${index}`, 'not_executed', EVIDENCE_CLASSES.optionalOpportunity));
  const missingDiagnostic = Array.from({ length: 10 }, (_, index) => annotated(`tech.diagnostic_${index}`, 'not_executed', EVIDENCE_CLASSES.secondaryDiagnostic));
  const result = computeScores([...primary, ...missingOptional, ...missingDiagnostic]);

  assert.equal(result.primaryCoverage, 100);
  assert.equal(result.scoreStatus, 'final');
  assert.equal(result.diagnosticCoverage, 0);
  assert.equal(result.breakdown.optionalCoverage, 0);
  assert.ok(result.weightedCoverage < 100);
  assert.equal(result.coverageModelVersion, 'evidence-class-coverage-v3');
  assert.equal(result.availabilitySemanticsVersion, AVAILABILITY_SEMANTICS_VERSION);
  assert.equal(computeScores([{ ...primary[0], coverageWeight: null }]).breakdown.eligibleWeight, 1);
});

test('standard-aligned best practices can require conditional evidence and missing facts cannot earn coverage or score', () => {
  const cachePolicy = applyEvidenceAvailability(row('tech.cache_control_header', 'pass', {
    findingType: 'best_practice'
  }));
  assert.equal(cachePolicy.evidenceClass, EVIDENCE_CLASSES.primaryConditional);

  const measuredPerformance = applyEvidenceAvailability(row('tech.high_ttfb', 'pass', {
    findingType: 'best_practice'
  }));
  const missingPerformance = applyEvidenceAvailability(row('tech.high_ttfb', 'insufficient_evidence', {
    findingType: 'info'
  }));
  assert.equal(measuredPerformance.evidenceClass, EVIDENCE_CLASSES.primaryRequired);
  assert.equal(missingPerformance.evidenceClass, EVIDENCE_CLASSES.primaryRequired);

  const invalidFail = applyEvidenceAvailability(row('tech.canonical_missing', 'fail', {
    requirements: {
      requiredFacts: ['effectiveCanonical'],
      missingFacts: ['effectiveCanonical']
    }
  }));
  assert.equal(invalidFail.coverageStatus, 'uncovered');
  assert.equal(invalidFail.evidenceStatus, 'required_but_missing');
  const scores = computeScores([invalidFail]);
  assert.equal(scores.primaryCoverage, 0);
  assert.equal(scores.breakdown.appliedPenalty, 0);
  assert.equal(scores.breakdown.scoredFindingCount, 0);
});

test('missing required evidence and technical errors remain uncovered and score-free', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => annotated(`tech.complete_${index}`, 'pass', EVIDENCE_CLASSES.primaryRequired)),
    annotated('tech.http_status_missing', 'insufficient_evidence', EVIDENCE_CLASSES.primaryRequired),
    annotated('tech.canonical_error', 'technical_error', EVIDENCE_CLASSES.primaryRequired)
  ];
  const result = computeScores(rows);
  assert.equal(result.primaryCoverage, 80);
  assert.equal(result.scoreStatus, 'provisional', 'an uncovered critical crawling category keeps the run provisional');
  assert.equal(result.breakdown.missingPrimaryEvidence.length, 2);
  assert.equal(result.breakdown.coverageTechnicalErrors.length, 1);
  assert.equal(result.breakdown.coverageTechnicalErrors[0].executionStatus, 'technical_error');
  assert.equal(result.breakdown.appliedPenalty, 0);

  const below = computeScores(rows.slice(0, 7).concat([
    annotated('tech.missing_2', 'not_executed', EVIDENCE_CLASSES.primaryRequired),
    annotated('tech.missing_3', 'technical_error', EVIDENCE_CLASSES.primaryRequired),
    annotated('tech.missing_4', 'insufficient_evidence', EVIDENCE_CLASSES.primaryRequired)
  ]));
  assert.equal(below.primaryCoverage, 70);
  assert.equal(below.scoreStatus, 'provisional');
});

test('conditional applicability excludes irrelevant checks but requires evidence once applicable', () => {
  const notProduct = applyEvidenceAvailability(row('tech.product_coverage_on_product_like_pages', 'not_applicable', {
    evidenceClass: EVIDENCE_CLASSES.primaryConditional
  }));
  assert.equal(notProduct.coverageStatus, 'excluded');
  assert.equal(notProduct.evidenceStatus, 'not_required');

  const productMissing = applyEvidenceAvailability(row('tech.product_coverage_on_product_like_pages', 'insufficient_evidence', {
    evidenceClass: EVIDENCE_CLASSES.primaryConditional
  }));
  assert.equal(productMissing.coverageStatus, 'uncovered');
  assert.equal(productMissing.evidenceStatus, 'required_but_missing');
});

test('browser plan distinguishes raw-sufficient diagnostics from missing required CSR evidence', () => {
  const rawSufficient = applyEvidenceAvailability(
    row('tech.js_dependent_content', 'not_executed'),
    { render: { requiredCount: 0, budgetExhaustedCount: 0, unavailableCount: 0 } }
  );
  assert.equal(rawSufficient.evidenceClass, EVIDENCE_CLASSES.secondaryDiagnostic);
  assert.equal(rawSufficient.coverageStatus, 'excluded');
  assert.equal(rawSufficient.executionStatus, 'skipped_by_render_plan');

  const appShellMissing = applyEvidenceAvailability(
    row('tech.js_dependent_content', 'insufficient_evidence'),
    { render: { requiredCount: 1, budgetExhaustedCount: 1, unavailableCount: 0 } }
  );
  assert.equal(appShellMissing.evidenceClass, EVIDENCE_CLASSES.primaryConditional);
  assert.equal(appShellMissing.coverageStatus, 'uncovered');
  assert.equal(appShellMissing.executionStatus, 'skipped_by_budget');
  assert.equal(computeScores([appShellMissing]).renderRequiredCoverage, 0);
  const appShellRun = computeScores([
    ...Array.from({ length: 8 }, (_, index) => annotated(`tech.app_primary_${index}`, 'pass', EVIDENCE_CLASSES.primaryRequired)),
    appShellMissing
  ]);
  assert.equal(appShellRun.primaryCoverage, 88.9);
  assert.equal(appShellRun.scoreStatus, 'provisional', 'a missing required render cannot produce a final headline');

  const optionalBudget = applyEvidenceAvailability(
    row('tech.raw_h1_missing_rendered_present', 'not_executed'),
    { render: { requiredCount: 1, budgetExhaustedCount: 1, unavailableCount: 0 } }
  );
  assert.equal(optionalBudget.executionStatus, 'skipped_by_budget');
  assert.equal(optionalBudget.coverageStatus, 'diagnostic_unavailable');
});

test('disabled browser and performance modules do not pretend to be evaluated', () => {
  const lighthouse = applyEvidenceAvailability(
    row('template.high_lcp', 'not_executed'),
    { enableLighthouseSampling: false, render: {} }
  );
  const consoleDiagnostic = applyEvidenceAvailability(
    row('template.console_errors', 'not_executed'),
    { enablePlaywrightSampling: false, render: {} }
  );
  assert.equal(lighthouse.coverageStatus, 'excluded');
  assert.equal(consoleDiagnostic.coverageStatus, 'excluded');
  assert.equal(lighthouse.executionStatus, 'disabled');
  assert.equal(computeScores([lighthouse, consoleDiagnostic]).primaryCoverage, 0);
});

test('inventory collection contributes only to inventory coverage', () => {
  const complete = annotated('tech.noindex_pages', 'inventory', EVIDENCE_CLASSES.inventory);
  const failed = annotated('tech.security_headers_inventory', 'technical_error', EVIDENCE_CLASSES.inventory);
  const result = computeScores([complete, failed, annotated('tech.http', 'pass', EVIDENCE_CLASSES.primaryRequired)]);
  assert.equal(result.primaryCoverage, 100);
  assert.equal(result.inventoryCoverage, 50);
  assert.equal(result.scoreStatus, 'final');
});

test('coverage units prevent Tech/GEO and duplicate execution from inflating the denominator', () => {
  const sharedUnit = 'site:structured_data:article_coverage';
  const rows = [
    annotated('tech.article_coverage_on_article_like_pages', 'pass', EVIDENCE_CLASSES.primaryConditional, sharedUnit),
    annotated('geo.article_blog_pages_article_schema', 'pass', EVIDENCE_CLASSES.primaryConditional, sharedUnit),
    annotated('tech.article_coverage_on_article_like_pages', 'pass', EVIDENCE_CLASSES.primaryConditional, sharedUnit)
  ];
  const result = computeScores(rows);
  assert.equal(result.breakdown.coverageUnits.length, 1);
  assert.equal(result.breakdown.eligibleWeight, 1);
  assert.equal(result.primaryCoverage, 100);
});

test('coverage threshold boundaries are based on primary coverage', () => {
  const calculate = (covered) => computeScores(Array.from({ length: 10 }, (_, index) => annotated(
    `tech.boundary_${covered}_${index}`,
    index < covered ? 'pass' : 'insufficient_evidence',
    EVIDENCE_CLASSES.primaryRequired
  )));
  assert.equal(calculate(8).scoreStatus, 'final');
  assert.equal(calculate(6).scoreStatus, 'provisional');
  assert.equal(calculate(5).scoreStatus, 'insufficient_coverage');

  const weightedBoundary = (coveredWeight) => computeScores([
    { ...annotated(`tech.covered_${coveredWeight}`, 'pass', EVIDENCE_CLASSES.primaryRequired), coverageWeight: coveredWeight },
    { ...annotated(`tech.missing_${coveredWeight}`, 'insufficient_evidence', EVIDENCE_CLASSES.primaryRequired), coverageWeight: 1 - coveredWeight }
  ]);
  assert.equal(weightedBoundary(0.8).primaryCoverage, 80);
  assert.equal(weightedBoundary(0.8).scoreStatus, 'final');
  assert.equal(weightedBoundary(0.799).primaryCoverage, 79.9);
  assert.equal(weightedBoundary(0.799).scoreStatus, 'provisional');
  assert.equal(weightedBoundary(0.6).scoreStatus, 'provisional');
  assert.equal(weightedBoundary(0.599).scoreStatus, 'insufficient_coverage');

  const optionalInflation = computeScores([
    annotated('tech.required_missing', 'technical_error', EVIDENCE_CLASSES.primaryRequired),
    ...Array.from({ length: 100 }, (_, index) => annotated(`geo.covered_optional_${index}`, 'pass', EVIDENCE_CLASSES.optionalOpportunity))
  ]);
  assert.ok(optionalInflation.weightedCoverage > 80);
  assert.equal(optionalInflation.primaryCoverage, 0);
  assert.equal(optionalInflation.scoreStatus, 'insufficient_coverage');
  assert.deepEqual(scoringConfig.coverageThresholds, { final: 80, provisional: 60 });
});

test('additive schema and CSV expose evidence availability without rewriting historical values', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  const runColumns = db.prepare('PRAGMA table_info(runs)').all().map((row) => row.name);
  const resultColumns = db.prepare('PRAGMA table_info(check_results)').all().map((row) => row.name);
  assert.ok(runColumns.includes('availabilitySemanticsVersion'));
  for (const field of ['evidenceClass', 'executionStatus', 'evidenceStatus', 'evaluationStatus', 'coverageStatus', 'coverageUnitKey', 'coverageWeight', 'coverageReason', 'availabilitySemanticsVersion']) {
    assert.ok(resultColumns.includes(field), field);
  }
  assert.equal(COVERAGE_MODEL_VERSION, 'evidence-class-coverage-v3');
  assert.ok(getCsvExportSpec('coverage-units', 1).columns.includes('availabilitySemanticsVersion'));
  const historical = scoresForStoredRun({
    scoringVersion: 'root-cause-scoring-v3',
    coverageModelVersion: 'weighted-coverage-v2',
    scoreBreakdownJson: null
  }, [row('tech.historical', 'pass')]);
  assert.equal(historical.scoreStatus, 'historical_unknown');
  assert.equal(historical.breakdown.historicalCoverageModelVersion, 'weighted-coverage-v2');
  db.close();
});

function annotated(checkId, evaluationState, evidenceClass, coverageUnitKey = null) {
  return applyEvidenceAvailability(row(checkId, evaluationState, { evidenceClass, coverageUnitKey }));
}

function row(checkId, evaluationState, extras = {}) {
  const status = evaluationState === 'pass' ? 'OK' : evaluationState === 'fail' ? 'Warning' : 'NA';
  return {
    id: checkId,
    checkId,
    name: checkId,
    category: 'Server & Infrastructure',
    auditType: checkId.startsWith('geo.') ? 'geo' : 'tech',
    status,
    priority: 'Medium',
    findingType: 'core_issue',
    confidence: 'high',
    assessment: { severity: evaluationState === 'fail' ? 'medium' : 'none', confidence: 'high' },
    evaluationState,
    scoreEligible: ['pass', 'fail'].includes(evaluationState),
    evidence: { fixture: true },
    facts: { fixture: true },
    affectedCount: evaluationState === 'fail' ? 1 : 0,
    ...extras
  };
}
