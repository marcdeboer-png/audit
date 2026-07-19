import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  insertCheckResults,
  persistRunScores,
  updateProject,
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import {
  SCORING_VERSION,
  computeScores,
  scopeFactorForCount,
  scoringConfig
} from '../src/utils/scoring.js';
import { loadResultsWithScores } from '../src/checks/checkEngine.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { applyEvidenceAvailability } from '../src/coverage/evidenceCoverage.js';

test('severity calibration, score-free states and optional-low budget satisfy invariants', () => {
  const pass = finding('pass', { status: 'OK', severity: 'none' });
  const severities = ['critical', 'high', 'medium', 'low'];
  const penalties = Object.fromEntries(severities.map((severity) => {
    const result = computeScores([pass, finding(severity, { severity })]);
    return [severity, result.breakdown.appliedPenalty];
  }));
  assert.ok(penalties.critical > penalties.high);
  assert.ok(penalties.high > penalties.medium);
  assert.ok(penalties.medium > penalties.low);

  const optionalLows = Array.from({ length: 20 }, (_, index) => finding(`optional-${index}`, {
    severity: 'low', priority: 'Low', findingType: 'opportunity', category: 'GEO Opportunities'
  }));
  const lowResult = computeScores([pass, ...optionalLows]);
  assert.ok(penalties.critical > lowResult.breakdown.appliedPenalty);
  assert.equal(lowResult.breakdown.capsApplied.find((cap) => cap.type === 'optional_low_global')?.limit, scoringConfig.optionalLowPenaltyCap);

  const scoreFree = ['not_applicable', 'insufficient_evidence', 'not_executed', 'technical_error']
    .map((state, index) => finding(`free-${index}`, { evaluationState: state, status: 'NA', scoreEligible: false }));
  const freeResult = computeScores([pass, ...scoreFree]);
  assert.equal(freeResult.breakdown.appliedPenalty, 0);
  assert.equal(freeResult.breakdown.rootCauseCount, 0);
  assert.equal(Object.values(freeResult.breakdown.excludedResults.byReason).reduce((sum, row) => sum + row.count, 0), 4);

  const lowConfidencePass = computeScores([finding('uncertain-pass', { status: 'OK', severity: 'none', confidence: 'low' })]);
  assert.equal(lowConfidencePass.breakdown.excludedResults.byReason.low_confidence.count, 1);
  assert.equal(lowConfidencePass.breakdown.excludedResults.byReason.pass, undefined);
});

test('scoring properties are monotone and duplicates do not create a second full penalty', () => {
  const passRows = Array.from({ length: 10 }, (_, index) => finding(`pass-${index}`, { status: 'OK', severity: 'none' }));
  let previous = 100;
  for (const severity of ['low', 'medium', 'high', 'critical']) {
    const score = computeScores([...passRows, finding(`risk-${severity}`, { severity })]).diagnosticOverallScore;
    assert.ok(score <= previous, `${severity} must not improve score`);
    previous = score;
  }

  const first = finding('first', { severity: 'high', rootCauseKey: 'shared.server.failure' });
  const duplicate = finding('second', { severity: 'high', rootCauseKey: 'shared.server.failure', auditType: 'geo' });
  const unique = finding('unique', { severity: 'medium', rootCauseKey: 'different.server.failure' });
  const one = computeScores([...passRows, first]);
  const two = computeScores([...passRows, first, duplicate]);
  const three = computeScores([...passRows, first, duplicate, unique]);
  assert.equal(two.breakdown.rootCauseCount, one.breakdown.rootCauseCount);
  assert.equal(two.breakdown.appliedPenalty, one.breakdown.appliedPenalty);
  assert.equal(two.breakdown.deduplicatedFindingCount, 1);
  assert.ok(three.diagnosticOverallScore <= two.diagnosticOverallScore);

  const missingEvidence = computeScores([
    ...passRows.slice(0, 5),
    ...Array.from({ length: 5 }, (_, index) => finding(`measurement-${index}`, { evaluationState: 'insufficient_evidence', status: 'NA', scoreEligible: false }))
  ]);
  assert.notEqual(missingEvidence.scoreStatus, 'final');
  assert.equal(missingEvidence.breakdown.rootCauseCount, 0);
});

test('root-cause rules preserve occurrences, merge only deterministic peers and protect different causes', () => {
  const oneHundredMembers = Array.from({ length: 100 }, (_, index) => finding('tech.template_missing_title', {
    findingId: `member-${index}`,
    rootCauseKey: 'template.missing_title.main',
    sampleUrls: [`https://example.invalid/${index}`],
    affectedCount: 1,
    scopeType: 'template'
  }));
  const clustered = computeScores(oneHundredMembers);
  assert.equal(clustered.breakdown.rootCauseCount, 1);
  assert.equal(clustered.breakdown.rootCauses[0].affectedUrlCount, 100);
  assert.equal(clustered.breakdown.rootCauses[0].occurrenceCount, 100);
  assert.equal(clustered.breakdown.deduplicatedFindingCount, 99);

  const article = computeScores([
    finding('tech.article_coverage_on_article_like_pages', { affectedCount: 8, scopeType: 'template' }),
    finding('geo.article_blog_pages_article_schema', { affectedCount: 8, scopeType: 'template', auditType: 'geo' })
  ]);
  assert.equal(article.breakdown.rootCauseCount, 1);
  assert.deepEqual(article.breakdown.rootCauses[0].relatedCheckIds, [
    'geo.article_blog_pages_article_schema',
    'tech.article_coverage_on_article_like_pages'
  ]);

  const sameRecommendationDifferentCause = computeScores([
    finding('tech.large_image_resources', { rootCauseKey: 'media.large_bytes', recommendation: 'Optimize images' }),
    finding('tech.images_without_width_height', { rootCauseKey: 'media.missing_dimensions', recommendation: 'Optimize images' })
  ]);
  assert.equal(sameRecommendationDifferentCause.breakdown.rootCauseCount, 2);

  const titleGroups = computeScores([finding('tech.duplicate_titles', {
    evidence: {
      rootCauseCandidates: [
        { key: 'html_meta.duplicate_title:aaa', family: 'html_meta.duplicate_title', count: 20 },
        { key: 'html_meta.duplicate_title:bbb', family: 'html_meta.duplicate_title', count: 30 }
      ]
    }
  })]);
  assert.equal(titleGroups.breakdown.rootCauseCount, 2);

  const siteAndMembers = computeScores([
    finding('tech.sitewide', { findingId: 'site', rootCauseKey: 'template.shared', affectedCount: 100, scopeType: 'template' }),
    finding('tech.url_member', { findingId: 'url-member', rootCauseKey: 'template.shared', affectedCount: 1, scopeType: 'url' })
  ]);
  assert.equal(siteAndMembers.breakdown.rootCauseCount, 1);
  assert.equal(siteAndMembers.breakdown.rootCauses[0].affectedUrlCount, 100);

  const technicalAndWebsite = computeScores([
    finding('tech.runner', { evaluationState: 'technical_error', status: 'NA', scoreEligible: false, rootCauseKey: 'browser.console' }),
    finding('tech.console_errors_present', { rootCauseKey: 'browser.console' })
  ]);
  assert.equal(technicalAndWebsite.breakdown.rootCauseCount, 1);
  assert.equal(technicalAndWebsite.breakdown.scoredFindingCount, 1);

  const noUnsafeCrossMerge = computeScores([
    finding('tech.unknown_a'),
    finding('geo.unknown_b', { auditType: 'geo' })
  ]);
  assert.equal(noUnsafeCrossMerge.breakdown.rootCauseCount, 2);
});

test('scope factor distinguishes 1, 10, 100 and 1000 URLs with a fixed cap', () => {
  const values = [1, 10, 100, 1000].map((count) => scopeFactorForCount(count, 'url'));
  assert.deepEqual(values, [1, 1.25, 1.5, 1.75]);
  assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]));
  assert.ok(scopeFactorForCount(1_000_000, 'sitewide') <= scoringConfig.scope.totalFactorCap);
  assert.ok(values[3] < values[0] * 1000);
});

test('weighted coverage controls final, provisional and insufficient headline scores', () => {
  const cases = [
    [100, 'final', true],
    [85, 'final', true],
    [70, 'provisional', true],
    [59, 'insufficient_coverage', false],
    [0, 'insufficient_coverage', false]
  ];
  for (const [evaluated, expectedStatus, hasHeadline] of cases) {
    const rows = Array.from({ length: 100 }, (_, index) => index < evaluated
      ? finding(`coverage-pass-${evaluated}-${index}`, { status: 'OK', severity: 'none' })
      : finding(`coverage-missing-${evaluated}-${index}`, { evaluationState: 'insufficient_evidence', status: 'NA', scoreEligible: false }));
    const result = computeScores(rows);
    assert.equal(result.weightedCoverage, evaluated);
    assert.equal(result.scoreStatus, expectedStatus);
    assert.equal(result.overallScore !== null, hasHeadline);
  }

  const categories = computeScores([
    finding('tech.complete', { status: 'OK', severity: 'none', category: 'Server & Infrastructure' }),
    finding('geo.missing', { evaluationState: 'technical_error', status: 'NA', scoreEligible: false, auditType: 'geo', category: 'GEO Opportunities' })
  ]);
  assert.equal(categories.primaryCoverage, 100, 'an optional GEO diagnostic must not reduce primary evidence coverage');
  assert.equal(categories.weightedCoverage, 95.2, 'optional evidence remains visible at its reduced diagnostic weight');
  const categoryRows = categories.breakdown.categoryScores;
  assert.equal(categoryRows.find((row) => row.categoryKey === 'technical_seo').scoreStatus, 'final');
  assert.equal(categoryRows.find((row) => row.categoryKey === 'geo').scoreStatus, 'not_applicable');
  assert.equal(categoryRows.find((row) => row.categoryKey === 'geo').score, null);
});

test('low, category and scope caps expose raw and applied penalties', () => {
  const optional = Array.from({ length: 20 }, (_, index) => finding(`optional-cap-${index}`, {
    severity: 'low', priority: 'Low', findingType: 'opportunity', category: 'GEO Opportunities'
  }));
  const highMedia = Array.from({ length: 4 }, (_, index) => finding(`tech.large_image_${index}`, {
    severity: 'high', category: 'Media SEO', rootCauseKey: `media.large.${index}`, affectedCount: 1000, scopeType: 'resource'
  }));
  const result = computeScores([...optional, ...highMedia]);
  assert.ok(result.breakdown.rawPenalty > result.breakdown.appliedPenalty);
  assert.ok(result.breakdown.capsApplied.some((cap) => cap.type === 'optional_low_global'));
  assert.ok(result.breakdown.capsApplied.some((cap) => cap.type === 'category:media'));
  assert.ok(result.breakdown.rootCauses.every((root) => root.scopeFactor <= scoringConfig.scope.totalFactorCap));
});

test('controlled scenarios A-E remain calibrated', () => {
  const coveragePasses = Array.from({ length: 20 }, (_, index) => finding(`scenario-pass-${index}`, { status: 'OK', severity: 'none' }));
  const a = computeScores([...coveragePasses, finding('optional-note', { severity: 'low', priority: 'Low', findingType: 'opportunity' })]);
  const b = computeScores([...coveragePasses, finding('critical-server', { severity: 'critical', scopeType: 'sitewide' })]);
  const c = computeScores([...coveragePasses, finding('template-1000', { severity: 'medium', affectedCount: 1000, scopeType: 'template' })]);
  const d = computeScores([...coveragePasses.slice(0, 5), ...Array.from({ length: 10 }, (_, index) => finding(`missing-${index}`, { status: 'NA', evaluationState: 'insufficient_evidence', scoreEligible: false }))]);
  const e = computeScores([...coveragePasses,
    finding('tech.article_coverage_on_article_like_pages', { rootCauseKey: 'structured_data.article_coverage' }),
    finding('geo.article_blog_pages_article_schema', { rootCauseKey: 'structured_data.article_coverage', auditType: 'geo' })
  ]);
  assert.ok(a.overallScore >= 95 && a.scoreStatus === 'final');
  assert.ok(b.overallScore <= 70 && b.scoreStatus === 'final');
  assert.equal(c.breakdown.rootCauseCount, 1);
  assert.ok(c.breakdown.rootCauses[0].scopeFactor < 1000);
  assert.equal(d.scoreStatus, 'insufficient_coverage');
  assert.equal(d.overallScore, null);
  assert.equal(e.breakdown.rootCauseCount, 1);
  assert.equal(e.breakdown.deduplicatedFindingCount, 1);
});

test('CLI output exposes score status and weighted coverage', () => {
  const cliSource = fs.readFileSync(new URL('../src/cli/audit.js', import.meta.url), 'utf8');
  assert.match(cliSource, /Score status:/);
  assert.match(cliSource, /weighted coverage=/);
});

test('versioned score snapshot stays consistent across DB, HTML, JSON, CSV and detail', () => {
  const { db, runId } = fixtureDb();
  const rows = [
    finding('tech.pass', { status: 'OK', severity: 'none' }),
    finding('tech.primary', { severity: 'high', rootCauseKey: 'shared.failure', affectedCount: 10, sampleUrls: ['https://example.invalid/a'] }),
    finding('geo.peer', { severity: 'medium', rootCauseKey: 'shared.failure', auditType: 'geo', affectedCount: 10, sampleUrls: ['https://example.invalid/a'] }),
    ...Array.from({ length: 4 }, (_, index) => finding(`tech.media-${index}`, {
      severity: 'high',
      category: 'Media SEO',
      rootCauseKey: `media.large.${index}`,
      scopeType: 'resource',
      affectedCount: 1000
    }))
  ].map((row) => applyEvidenceAvailability(row));
  insertCheckResults(db, runId, rows);
  const calculated = computeScores(rows);
  persistRunScores(db, runId, calculated);

  const loaded = loadResultsWithScores(db, runId);
  assert.equal(loaded.scores.scoringVersion, SCORING_VERSION);
  assert.equal(loaded.scores.overallScore, calculated.overallScore);
  assert.equal(loaded.scores.breakdown.rootCauseCount, 5);
  const storedRun = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  assert.equal(storedRun.overallScore, calculated.overallScore);
  assert.equal(storedRun.scoreStatus, calculated.scoreStatus);
  assert.equal(JSON.parse(storedRun.scoreBreakdownJson).breakdown.appliedPenalty, calculated.breakdown.appliedPenalty);

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings', 'score-root-causes']).body);
  assert.equal(fullJson.scores.overallScore, calculated.overallScore);
  assert.equal(fullJson.scores.breakdown.rootCauseCount, 5);
  assert.equal(fullJson.scores.scoreStatus, calculated.scoreStatus);
  assert.equal(fullJson.scores.weightedCoverage, calculated.weightedCoverage);
  assert.equal(fullJson.scores.primaryCoverage, calculated.primaryCoverage);
  assert.equal(fullJson.scores.availabilitySemanticsVersion, calculated.availabilitySemanticsVersion);
  assert.deepEqual(fullJson.scores.breakdown.coverageUnits, calculated.breakdown.coverageUnits);
  assert.deepEqual(fullJson.scores.breakdown.categoryScores, calculated.breakdown.categoryScores);
  assert.deepEqual(fullJson.scores.breakdown.capsApplied, calculated.breakdown.capsApplied);
  const csv = collectCsvExport(db, runId, 'score-root-causes');
  assert.match(csv, new RegExp(`${SCORING_VERSION}.*shared\.failure`));
  assert.match(csv, /category:media/);
  const coverageCsv = collectCsvExport(db, runId, 'coverage-units');
  assert.match(coverageCsv, /evidence-class-coverage-v3/);
  assert.match(coverageCsv, /primary_required/);
  const resultId = db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.primary'").get(runId).id;
  const detail = getCheckDetail(db, runId, resultId);
  assert.equal(detail.evidenceClass, 'primary_required');
  assert.equal(detail.coverageStatus, 'covered');
  assert.equal(detail.rootCauseMemberships.length, 1);
  assert.equal(detail.rootCauseMemberships[0].appliedPenalty, calculated.breakdown.rootCauses[0].appliedPenalty);
  const reportPath = generateReport(db, runId);
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, new RegExp(SCORING_VERSION));
  assert.match(html, new RegExp(String(calculated.breakdown.appliedPenalty).replace('.', '\\.')));
  assert.match(html, /category:media/);
  assert.match(html, /export\/score-root-causes\.csv/);
  assert.match(html, /Primary Coverage/);
  assert.match(html, /export\/coverage-units\.csv/);
  fs.rmSync(reportPath, { force: true });
  db.close();
});

test('unversioned historical run remains readable and is not silently persisted as v2', () => {
  const { db, runId } = fixtureDb();
  insertCheckResults(db, runId, [
    finding('tech.old-pass', { status: 'OK', severity: 'none' }),
    finding('tech.old-warning', { severity: 'medium' })
  ]);
  db.prepare(`UPDATE runs SET scoringVersion=NULL,deduplicationVersion=NULL,coverageModelVersion=NULL,checkLogicVersion=NULL,scoreStatus=NULL,overallScore=NULL,scoreBreakdownJson=NULL WHERE id=?`).run(runId);
  db.prepare(`UPDATE check_results SET evaluationState=NULL,scoreDeduplicationKey=NULL,rootCauseId=NULL,rootCauseKey=NULL,rootCauseMembershipsJson=NULL WHERE runId=?`).run(runId);
  const before = db.prepare('SELECT scoringVersion,overallScore,scoreBreakdownJson FROM runs WHERE id=?').get(runId);
  const loaded = loadResultsWithScores(db, runId);
  const after = db.prepare('SELECT scoringVersion,overallScore,scoreBreakdownJson FROM runs WHERE id=?').get(runId);
  assert.deepEqual(after, before);
  assert.equal(loaded.scores.scoringVersion, null);
  assert.equal(loaded.scores.scoreStatus, 'historical_unknown');
  assert.equal(loaded.scores.overallScore, 75);
  assert.equal(loaded.scores.breakdown.scoringModel, 'legacy-unversioned-original');
  assert.equal(loaded.scores.breakdown.rootCauses, undefined);
  assert.doesNotMatch(collectCsvExport(db, runId, 'score-root-causes'), /root-cause-scoring-v2/);
  const resultId = db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.old-warning'").get(runId).id;
  assert.deepEqual(getCheckDetail(db, runId, resultId).rootCauseMemberships, []);
  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings', 'score-root-causes']).body);
  assert.equal(fullJson.scores.overallScore, 75);
  assert.equal(fullJson.scores.scoringVersion, null);
  const reportPath = generateReport(db, runId);
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, /Historical scoring metadata is unavailable/);
  assert.doesNotMatch(html, /root-cause-scoring-v2/);
  fs.rmSync(reportPath, { force: true });
  db.close();
});

function fixtureDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const projectId = createProject(db, { inputDomain: 'https://example.invalid', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.invalid' });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'https://example.invalid', auditType: 'both', maxUrls: 20, maxDepth: 2, concurrency: 1,
    enableTemplateSampling: false, enablePlaywrightSampling: false, enableLighthouseSampling: false
  }));
  updateRun(db, runId, { status: 'completed', currentPhase: 'completed', processedUrls: 1, successfulUrls: 1 });
  return { db, runId };
}

function finding(checkId, options = {}) {
  const status = options.status || 'Warning';
  const evaluationState = options.evaluationState || (status === 'OK' ? 'pass' : status === 'NA' ? 'insufficient_evidence' : 'fail');
  const severity = options.severity || (status === 'Error' ? 'high' : status === 'Warning' ? 'medium' : 'none');
  const affectedCount = options.affectedCount ?? (evaluationState === 'fail' ? 1 : 0);
  return {
    id: checkId,
    findingId: options.findingId,
    checkId,
    name: checkId,
    category: options.category || 'Server & Infrastructure',
    auditType: options.auditType || (/^(geo|trust|llm)\./.test(checkId) ? 'geo' : 'tech'),
    status,
    priority: options.priority || (severity === 'low' ? 'Low' : severity === 'high' || severity === 'critical' ? 'High' : 'Medium'),
    effort: 'S',
    finding: `${checkId} finding`,
    details: 'Controlled fixture evidence.',
    recommendation: options.recommendation || `${checkId} recommendation`,
    affectedCount,
    occurrenceCount: options.occurrenceCount ?? affectedCount,
    affectedUrlCount: options.affectedUrlCount ?? affectedCount,
    sampleUrls: options.sampleUrls || (affectedCount ? [`https://example.invalid/${encodeURIComponent(checkId)}`] : []),
    evidence: options.evidence || { affectedCount },
    facts: { evaluated: true },
    assessment: { severity, confidence: options.confidence || 'high' },
    evaluationState,
    scoreEligible: options.scoreEligible ?? ['pass', 'fail'].includes(evaluationState),
    findingType: options.findingType || 'core_issue',
    confidence: options.confidence || 'high',
    rootCauseKey: options.rootCauseKey || null,
    rootCauseFamily: options.rootCauseFamily || null,
    scopeType: options.scopeType || 'url',
    deduplicationConfidence: options.deduplicationConfidence || 'high',
    deduplicationReason: options.deduplicationReason || null
  };
}
