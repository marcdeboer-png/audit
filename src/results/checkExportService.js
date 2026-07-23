import fs from 'node:fs';
import { collectCsvExport, csvEscape } from '../reports/csvExporter.js';
import { generateReport } from '../reports/reportGenerator.js';
import { renderComparisonReport } from '../reports/comparisonReportGenerator.js';
import { loadResultsWithScores } from '../checks/checkEngine.js';
import {
  getReviewSummary,
  getRunComparison,
  getRunWithProject,
  getSamplingSummary,
  listRunComparisons
} from '../db/repositories.js';
import { createZipBuffer } from '../utils/simpleZip.js';
import { getCheckDetail } from './checkDetailService.js';
import { buildMaturityModel } from '../maturity/maturityService.js';
import { buildEnterpriseSummary } from '../analysis/enterpriseSummary.js';
import { buildBenchmarkSummary } from '../analysis/benchmarkSummary.js';
import { getLatestValidationReport } from '../validation/referenceAudit/validationService.js';
import { buildValidationExportPayload } from '../validation/referenceAudit/validationExportService.js';
import { buildUnresolvedAuditQueue } from '../validation/unresolved/unresolvedAuditPointService.js';
import {
  getEvidenceJobDetails,
  listEvidenceJobsForRun
} from '../evidenceJobs/evidenceJobRunner.js';
import { buildEvidenceImpactForRun, renderEvidenceImpactMarkdown } from '../evidenceJobs/evidenceImpactService.js';
import { requireRunId } from '../scope/runScope.js';

export function collectCheckDetailCsv(db, runId, checkResultId) {
  requireRunId(runId, 'export check detail');
  const detail = getCheckDetail(db, runId, checkResultId);
  if (!detail) return null;
  const metadataColumns = [
    { key: 'checkId', label: 'checkId' },
    { key: 'checkTitle', label: 'title' },
    { key: 'category', label: 'category' },
    { key: 'checkResultId', label: 'checkResultId' },
    { key: 'displayStatus', label: 'displayStatus' },
    { key: 'displayPriority', label: 'displayPriority' },
    { key: 'displayFindingType', label: 'displayFindingType' },
    { key: 'displayReviewStatus', label: 'displayReviewStatus' },
    { key: 'displayActionStatus', label: 'displayActionStatus' },
    { key: 'affectedCount', label: 'affectedCount' },
    { key: 'recommendation', label: 'recommendation' },
    { key: 'rawStatus', label: 'rawStatus' },
    { key: 'rawPriority', label: 'rawPriority' },
    { key: 'rawFindingType', label: 'rawFindingType' },
    { key: 'confidence', label: 'confidence' },
    { key: 'reportSection', label: 'reportSection' },
    { key: 'reviewRecommended', label: 'reviewRecommended' },
    { key: 'status', label: 'status' },
    { key: 'priority', label: 'priority' },
    { key: 'effectivePriority', label: 'effectivePriority' },
    { key: 'findingType', label: 'findingType' },
    { key: 'reviewStatus', label: 'reviewStatus' },
    { key: 'actionStatus', label: 'actionStatus' },
    { key: 'isActionable', label: 'isActionable' },
    { key: 'displayReviewRecommended', label: 'displayReviewRecommended' }
  ];
  const scoringColumns = [
    { key: 'rootCauseId', label: 'rootCauseId' },
    { key: 'rootCauseKey', label: 'rootCauseKey' },
    { key: 'rootCauseFamily', label: 'rootCauseFamily' },
    { key: 'scopeType', label: 'scopeType' },
    { key: 'occurrenceCount', label: 'occurrenceCount' },
    { key: 'affectedUrlCount', label: 'affectedUrlCount' },
    { key: 'displayedSampleCount', label: 'displayedSampleCount' },
    { key: 'primaryCheckId', label: 'primaryCheckId' },
    { key: 'deduplicationConfidence', label: 'deduplicationConfidence' },
    { key: 'deduplicationReason', label: 'deduplicationReason' },
    { key: 'rootCauseMemberships', label: 'rootCauseMemberships' },
    { key: 'evidenceClass', label: 'evidenceClass' },
    { key: 'executionStatus', label: 'executionStatus' },
    { key: 'evidenceStatus', label: 'evidenceStatus' },
    { key: 'evaluationStatus', label: 'evaluationStatus' },
    { key: 'coverageStatus', label: 'coverageStatus' },
    { key: 'coverageUnitKey', label: 'coverageUnitKey' },
    { key: 'coverageWeight', label: 'coverageWeight' },
    { key: 'coverageReason', label: 'coverageReason' },
    { key: 'availabilitySemanticsVersion', label: 'availabilitySemanticsVersion' }
  ];
  const standardColumns = [
    { key: 'standardVersion', label: 'standardVersion' },
    { key: 'standardStatus', label: 'standardStatus' },
    { key: 'standardUsage', label: 'standardUsage' },
    { key: 'standardSeverity', label: 'standardSeverity' },
    { key: 'standardScoreEffect', label: 'standardScoreEffect' },
    { key: 'standardFindingType', label: 'standardFindingType' },
    { key: 'diagnosticOnly', label: 'diagnosticOnly' },
    { key: 'disabled', label: 'disabled' },
    { key: 'standardApplicability', label: 'standardApplicability' },
    { key: 'standardNotApplicableRule', label: 'standardNotApplicableRule' },
    { key: 'standardReviewStatus', label: 'standardReviewStatus' },
    { key: 'standardRollupRole', label: 'standardRollupRole' },
    { key: 'standardPatternRole', label: 'standardPatternRole' },
    { key: 'standardScoreOwnerCheckId', label: 'standardScoreOwnerCheckId' }
  ];
  const metadataKeys = new Set([...metadataColumns, ...scoringColumns, ...standardColumns].map((column) => column.key));
  const detailColumns = (detail.columns || []).filter((column) => !metadataKeys.has(column.key));
  const columns = [...metadataColumns, ...detailColumns, ...scoringColumns, ...standardColumns];
  const metadata = {
    checkId: detail.checkId,
    checkTitle: detail.title || '',
    category: detail.category || '',
    checkResultId: detail.checkResultId,
    status: detail.status,
    displayStatus: detail.displayStatus || detail.effectiveStatus || detail.status,
    displayPriority: detail.displayPriority || detail.effectivePriority || detail.priority,
    displayFindingType: detail.displayFindingType || detail.normalizedFindingType || detail.findingType || '',
    standardVersion: detail.standardVersion || '',
    standardStatus: detail.standardStatus || '',
    standardUsage: detail.standardUsage || '',
    standardSeverity: detail.standardSeverity ?? '',
    standardScoreEffect: detail.standardScoreEffect || '',
    standardFindingType: detail.standardFindingType || '',
    diagnosticOnly: detail.diagnosticOnly ? 1 : 0,
    disabled: detail.disabled ? 1 : 0,
    standardApplicability: detail.standardApplicability || '',
    standardNotApplicableRule: detail.standardNotApplicableRule || '',
    standardReviewStatus: detail.standardReviewStatus || '',
    standardRollupRole: detail.standardRollupRole || '',
    standardPatternRole: detail.standardPatternRole || '',
    standardScoreOwnerCheckId: detail.standardScoreOwnerCheckId || '',
    priority: detail.priority,
    effectivePriority: detail.effectivePriority || detail.priority,
    findingType: detail.normalizedFindingType || detail.findingType || '',
    rawStatus: detail.rawStatus || detail.status,
    rawPriority: detail.rawPriority || detail.priority,
    rawFindingType: detail.rawFindingType || detail.findingType || '',
    confidence: detail.confidence || '',
    evidenceClass: detail.evidenceClass || '',
    executionStatus: detail.executionStatus || '',
    evidenceStatus: detail.evidenceStatus || '',
    evaluationStatus: detail.evaluationStatus || detail.evaluationState || '',
    coverageStatus: detail.coverageStatus || '',
    coverageUnitKey: detail.coverageUnitKey || '',
    coverageWeight: detail.coverageWeight ?? '',
    coverageReason: detail.coverageReason || '',
    availabilitySemanticsVersion: detail.availabilitySemanticsVersion || '',
    rootCauseId: detail.rootCauseId || '',
    rootCauseKey: detail.rootCauseKey || '',
    rootCauseFamily: detail.rootCauseFamily || '',
    scopeType: detail.scopeType || '',
    occurrenceCount: detail.occurrenceCount || 0,
    affectedUrlCount: detail.affectedUrlCount || 0,
    displayedSampleCount: detail.displayedSampleCount || 0,
    primaryCheckId: detail.primaryCheckId || '',
    deduplicationConfidence: detail.deduplicationConfidence || '',
    deduplicationReason: detail.deduplicationReason || '',
    rootCauseMemberships: JSON.stringify(detail.rootCauseMemberships || []),
    affectedCount: detail.affectedCount || 0,
    reviewRecommended: detail.reviewRecommended || 0,
    reviewStatus: detail.reviewStatus || 'unreviewed',
    displayReviewStatus: detail.displayReviewStatus || detail.reviewStatus || 'unreviewed',
    actionStatus: detail.actionStatus || 'open',
    displayActionStatus: detail.displayActionStatus || detail.actionStatus || 'open',
    isActionable: detail.isActionable || 0,
    reportSection: detail.reportSection || '',
    displayReviewRecommended: detail.displayReviewRecommended || 0,
    recommendation: detail.context?.recommendation || ''
  };
  const lines = [
    `${columns.map((column) => csvEscape(column.label || column.key)).join(',')}\n`
  ];
  for (const row of detail.rows || []) {
    const output = { ...row, ...metadata };
    lines.push(`${columns.map((column) => csvEscape(output[column.key])).join(',')}\n`);
  }
  return {
    filename: `audit-${runId}-${safeFileName(detail.checkId)}.csv`,
    csv: lines.join(''),
    detail
  };
}

export function collectFullAuditZip(db, runId, exportTypes) {
  requireRunId(runId, 'export full audit zip');
  const run = getRunWithProject(db, runId);
  if (!run) return null;
  const warnings = [];
  const entries = [];
  const manifest = createExportManifest(db, runId, run);
  const addText = (entryPath, data) => entries.push({ path: entryPath, data });
  const addJson = (entryPath, data) => addText(entryPath, `${JSON.stringify(data, null, 2)}\n`);
  const warn = (path, error) => warnings.push({
    path,
    message: error instanceof Error ? error.message : String(error || 'Unavailable')
  });

  const comparison = run.comparisonId
    ? getRunComparison(db, run.comparisonId)
    : listRunComparisons(db, runId)[0] || null;

  try {
    addJson('manifest.json', manifest);
    addJson('summary/enterprise-summary.json', buildEnterpriseSummary(db, runId, run));
    addJson('summary/audit-summary.json', buildAuditSummary(db, runId, run));
  } catch (error) {
    warn('summary/audit-summary.json', error);
    addJson('summary/audit-summary.json', { runId, error: 'audit summary unavailable' });
  }
  try {
    addJson('summary/run-config.json', buildRunConfig(run));
  } catch (error) {
    warn('summary/run-config.json', error);
    addJson('summary/run-config.json', { runId, error: 'run config unavailable' });
  }
  try {
    addJson('summary/review-summary.json', getReviewSummary(db, runId));
  } catch (error) {
    warn('summary/review-summary.json', error);
    addJson('summary/review-summary.json', { runId, error: 'review summary unavailable' });
  }
  try {
    addJson('summary/maturity.json', buildMaturityModel(db, runId));
  } catch (error) {
    warn('summary/maturity.json', error);
    addJson('summary/maturity.json', { runId, error: 'maturity summary unavailable' });
  }
  try {
    addJson('summary/benchmark-summary.json', benchmarkSummaryForRun(db, runId, run));
  } catch (error) {
    warn('summary/benchmark-summary.json', error);
    addJson('summary/benchmark-summary.json', { runId, error: 'benchmark summary unavailable' });
  }
  if (run.scheduledRunId || run.triggerType !== 'manual') {
    addJson('summary/schedule-context.json', buildScheduleContext(run));
  }
  if (comparison) {
    addJson('summary/comparison-context.json', comparison);
  }

  for (const type of exportTypes) {
    const targetPath = `csv/${fileNameForType(type)}.csv`;
    try {
      addText(targetPath, collectCsvExport(db, runId, type));
    } catch (error) {
      warn(targetPath, error);
      addText(targetPath, fallbackCsv(type, error));
    }
  }

  const checkRows = db.prepare(`
    SELECT id, checkId
    FROM check_results
    WHERE runId = ?
    ORDER BY checkId ASC
  `).all(runId);
  const checkDetails = [];
  for (const row of checkRows) {
    try {
      const detail = collectCheckDetailCsv(db, runId, row.id);
      if (detail) {
        addText(`checks/${detail.filename}`, detail.csv);
        checkDetails.push(detail.detail);
      }
      else {
        warn(`checks/audit-${runId}-${safeFileName(row.checkId)}.csv`, 'Check detail unavailable');
        addText(`checks/audit-${runId}-${safeFileName(row.checkId)}.csv`, fallbackCsv('check-detail', 'Check detail unavailable'));
      }
    } catch (error) {
      const targetPath = `checks/audit-${runId}-${safeFileName(row.checkId)}.csv`;
      warn(targetPath, error);
      addText(targetPath, fallbackCsv('check-detail', error));
    }
  }

  for (const entry of workingDataEntries(db, runId, run, checkDetails)) {
    try {
      addJson(entry.path, entry.data());
    } catch (error) {
      warn(entry.path, error);
      addJson(entry.path, { runId, error: error instanceof Error ? error.message : String(error || 'Unavailable') });
    }
  }

  const validation = getLatestValidationReport(db, runId);
  if (validation?.report) {
    try {
      const report = withEvidenceImpact(db, runId, withDerivedUnresolved(validation.report));
      const validationFiles = buildValidationExportPayload(report);
      for (const [filename, content] of Object.entries(validationFiles)) {
        addText(`validation/${filename}`, content);
      }
    } catch (error) {
      warn('validation/', error);
    }
  }
  try {
    addEvidenceJobZipEntries(db, runId, addJson, addText);
  } catch (error) {
    warn('evidence-jobs/', error);
  }

  try {
    const reportPath = generateReport(db, runId);
    addText('reports/audit-report.html', fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    warn('reports/audit-report.html', error);
  }
  if (comparison) {
    try {
      addText('reports/comparison-report.html', renderComparisonReport(comparison));
    } catch (error) {
      warn('reports/comparison-report.html', error);
    }
  }

  addJson('export-warnings.json', {
    manifest,
    warnings,
    generatedAt: new Date().toISOString()
  });

  return {
    filename: fullAuditZipFilename(runId),
    buffer: createZipBuffer(entries),
    warnings
  };
}

function withDerivedUnresolved(report = {}) {
  if (report.unresolvedAuditQueue && report.evidencePacks && report.evidenceJobPlan) return report;
  const queue = buildUnresolvedAuditQueue(report);
  return {
    ...report,
    unresolvedAuditQueue: report.unresolvedAuditQueue || queue,
    evidencePacks: report.evidencePacks || queue.evidencePacks,
    evidenceJobPlan: report.evidenceJobPlan || queue.evidenceJobPlan
  };
}

export function collectFullAuditJson(db, runId, exportTypes) {
  requireRunId(runId, 'export full audit json');
  const run = getRunWithProject(db, runId);
  if (!run) return null;
  const warnings = [];
  const warn = (path, error) => warnings.push({
    path,
    message: error instanceof Error ? error.message : String(error || 'Unavailable')
  });
  const files = {};
  for (const type of exportTypes) {
    const target = `${fileNameForType(type)}.csv`;
    try {
      files[target] = collectCsvExport(db, runId, type);
    } catch (error) {
      warn(`csv/${target}`, error);
      files[target] = fallbackCsv(type, error);
    }
  }
  const checkRows = db.prepare(`
    SELECT id, checkId
    FROM check_results
    WHERE runId = ?
    ORDER BY checkId ASC
  `).all(runId);
  const checkExports = {};
  const checkDetails = [];
  for (const row of checkRows) {
    try {
      const detail = collectCheckDetailCsv(db, runId, row.id);
      if (detail) {
        checkExports[`checks/${safeFileName(row.checkId)}.csv`] = detail.csv;
        checkDetails.push(detail.detail);
      }
    } catch (error) {
      warn(`checks/${safeFileName(row.checkId)}.csv`, error);
      checkExports[`checks/${safeFileName(row.checkId)}.csv`] = fallbackCsv('check-detail', error);
    }
  }
  const { scores, results } = loadResultsWithScores(db, runId);
  const manifest = createExportManifest(db, runId, run);
  return {
    filename: fullAuditJsonFilename(runId),
    body: JSON.stringify({
      format: 'full-audit-json-fallback',
      note: 'Full audit JSON export with structured working data plus CSV file contents as UTF-8 strings.',
      runId,
      exportManifest: manifest,
      summary: buildAuditSummary(db, runId, run),
      enterpriseSummary: buildEnterpriseSummary(db, runId, run),
      maturity: buildMaturityModel(db, runId),
      benchmarkSummary: benchmarkSummaryForRun(db, runId, run),
      validation: latestValidationReportWithDerivedUnresolved(db, runId),
      evidenceJobs: evidenceJobsForJson(db, runId),
      samplingSummary: getSamplingSummary(db, runId),
      runConfig: buildRunConfig(run),
      reviewSummary: getReviewSummary(db, runId),
      scheduleContext: (run.scheduledRunId || run.triggerType !== 'manual') ? buildScheduleContext(run) : null,
      comparisonContext: run.comparisonId ? getRunComparison(db, run.comparisonId) : null,
      scores,
      findings: results.map(formatFindingForExport),
      checkDetails,
      urlInventory: tableRows(db, 'pages', runId, manifest.tableLimits.pages).map(normalizeJsonFields),
      images: tableRows(db, 'page_images', runId, manifest.tableLimits.page_images),
      links: tableRows(db, 'page_links', runId, manifest.tableLimits.page_links),
      schemas: tableRows(db, 'schemas', runId, manifest.tableLimits.schemas).map(normalizeJsonFields),
      resources: tableRows(db, 'resources', runId, manifest.tableLimits.resources).map(normalizeJsonFields),
      httpTimingMeasurements: tableRows(db, 'http_timing_measurements', runId, manifest.tableLimits.http_timing_measurements).map(normalizeJsonFields),
      runtimeMetrics: runtimeMetricsForExport(db, runId),
      renderDecisions: tableRows(db, 'url_runtime_metrics', runId).map(normalizeJsonFields),
      reviews: tableRows(db, 'finding_reviews', runId),
      warnings,
      files,
      checkExports
    }, null, 2)
  };
}

function addEvidenceJobZipEntries(db, runId, addJson, addText) {
  const list = listEvidenceJobsForRun(db, runId);
  if (!list.jobs.length) return;
  addJson('evidence-jobs/jobs.json', list);
  if (!getLatestValidationReport(db, runId)?.report) {
    const impact = buildEvidenceImpactForRun(db, runId);
    addJson('validation/evidence-job-impact.json', impact);
    addText('validation/evidence-job-impact.md', renderEvidenceImpactMarkdown(impact));
  }
  for (const job of list.jobs) {
    const details = getEvidenceJobDetails(db, job.jobId, { limit: 1000, includeCsv: true });
    addJson(`evidence-jobs/job-${job.jobId}-summary.json`, {
      ...details,
      facts: undefined,
      factsCsv: undefined
    });
    addText(`evidence-jobs/job-${job.jobId}-facts.csv`, details.factsCsv || '');
  }
}

function evidenceJobsForJson(db, runId) {
  const list = listEvidenceJobsForRun(db, runId);
  if (!list.jobs.length) return { runId, jobs: [] };
  return {
    ...list,
    impact: buildEvidenceImpactForRun(db, runId),
    jobs: list.jobs.map((job) => getEvidenceJobDetails(db, job.jobId, { limit: 100 }))
  };
}

function latestValidationReportWithDerivedUnresolved(db, runId) {
  const validation = getLatestValidationReport(db, runId);
  return validation?.report ? withEvidenceImpact(db, runId, withDerivedUnresolved(validation.report)) : null;
}

function withEvidenceImpact(db, runId, report = {}) {
  try {
    return {
      ...report,
      evidenceJobImpact: report.evidenceJobImpact || buildEvidenceImpactForRun(db, runId, { validationReport: report })
    };
  } catch {
    return report;
  }
}

export function fullAuditZipFilename(runId) {
  return `audit-${runId}-full-audit.zip`;
}

export function fullAuditJsonFilename(runId) {
  return `audit-${runId}-full-audit.json`;
}

function workingDataEntries(db, runId, run, checkDetails) {
  const manifest = createExportManifest(db, runId, run);
  return [
    { path: 'data/findings.json', data: () => buildFindingsData(db, runId) },
    { path: 'data/check-details.json', data: () => checkDetails },
    { path: 'data/urls.json', data: () => tableRows(db, 'pages', runId, manifest.tableLimits.pages).map(normalizeJsonFields) },
    { path: 'data/links.json', data: () => tableRows(db, 'page_links', runId, manifest.tableLimits.page_links) },
    { path: 'data/images.json', data: () => tableRows(db, 'page_images', runId, manifest.tableLimits.page_images) },
    { path: 'data/resources.json', data: () => tableRows(db, 'resources', runId, manifest.tableLimits.resources).map(normalizeJsonFields) },
    { path: 'data/http-timing-measurements.json', data: () => tableRows(db, 'http_timing_measurements', runId, manifest.tableLimits.http_timing_measurements).map(normalizeJsonFields) },
    { path: 'data/render-runtime.json', data: () => tableRows(db, 'url_runtime_metrics', runId).map(normalizeJsonFields) },
    { path: 'summary/runtime-metrics.json', data: () => runtimeMetricsForExport(db, runId) },
    { path: 'data/schemas.json', data: () => tableRows(db, 'schemas', runId, manifest.tableLimits.schemas).map(normalizeJsonFields) },
    { path: 'data/geo-signals.json', data: () => tableRows(db, 'domain_assets', runId).map(normalizeJsonFields) },
    { path: 'data/reviews.json', data: () => tableRows(db, 'finding_reviews', runId) },
    { path: 'data/template-clusters.json', data: () => tableRows(db, 'template_clusters', runId).map(normalizeJsonFields) },
    { path: 'data/template-samples.json', data: () => tableRows(db, 'template_sample_results', runId) },
    { path: 'data/playwright-results.json', data: () => tableRows(db, 'playwright_results', runId).map(normalizeJsonFields) },
    { path: 'data/lighthouse-results.json', data: () => tableRows(db, 'lighthouse_results', runId).map(normalizeJsonFields) },
    { path: 'data/template-performance.json', data: () => tableRows(db, 'template_performance_summary', runId).map(normalizeJsonFields) },
    { path: 'data/run-logs.json', data: () => tableRows(db, 'run_logs', runId).map(normalizeJsonFields) },
    { path: 'summary/scores.json', data: () => loadResultsWithScores(db, runId).scores },
    { path: 'summary/run.json', data: () => buildRunConfig(run) }
  ];
}

function benchmarkSummaryForRun(db, runId, run) {
  return safeJson(run.benchmarkSummaryJson, null) || buildBenchmarkSummary(db, runId) || { runId, unavailable: true };
}

function buildFindingsData(db, runId) {
  return loadResultsWithScores(db, runId).results.map(formatFindingForExport);
}

function formatFindingForExport(row) {
  const sampleUrls = safeJson(row.sampleUrlsJson, row.sampleUrls || []);
  const evidence = safeJson(row.evidenceJson, row.evidence || {});
  const facts = safeJson(row.factsJson, row.facts || {});
  const assessment = safeJson(row.assessmentJson, row.assessment || {});
  const recommendationMeta = safeJson(row.recommendationMetaJson, row.recommendationMeta || {});
  const requirements = safeJson(row.requirementsJson, row.requirements || {});
  const provenance = safeJson(row.provenanceJson, row.provenance || {});
  const rootCauseMemberships = safeJson(row.rootCauseMembershipsJson, row.rootCauseMemberships || []);
  return {
    ...row,
    title: row.checkName || row.title || '',
    rawStatus: row.status || row.originalStatus || '',
    rawPriority: row.priority || row.originalPriority || '',
    rawFindingType: row.findingType || '',
    displayFindingType: row.normalizedFindingType || row.findingType || 'info',
    sampleUrls,
    evidence,
    evidenceJson: row.evidenceJson || JSON.stringify(evidence),
    facts,
    factsJson: row.factsJson || JSON.stringify(facts),
    assessment,
    assessmentJson: row.assessmentJson || JSON.stringify(assessment),
    recommendationMeta,
    recommendationMetaJson: row.recommendationMetaJson || JSON.stringify(recommendationMeta),
    requirements,
    requirementsJson: row.requirementsJson || JSON.stringify(requirements),
    provenance,
    provenanceJson: row.provenanceJson || JSON.stringify(provenance),
    relatedCheckIds: safeJson(row.relatedCheckIdsJson, row.relatedCheckIds || []),
    rootCauseMemberships,
    rootCauseMembershipsJson: row.rootCauseMembershipsJson || JSON.stringify(rootCauseMemberships)
  };
}

function buildAuditSummary(db, runId, run) {
  const { scores, results } = loadResultsWithScores(db, runId);
  const reviewSummary = getReviewSummary(db, runId);
  const samplingSummary = getSamplingSummary(db, runId);
  const pageCounts = db.prepare(`
    SELECT
      COUNT(*) AS pages,
      SUM(CASE WHEN statusCode >= 200 AND statusCode < 300 THEN 1 ELSE 0 END) AS okPages,
      SUM(CASE WHEN statusCode >= 300 AND statusCode < 400 THEN 1 ELSE 0 END) AS redirectPages,
      SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS errorPages,
      SUM(CASE WHEN indexable = 1 THEN 1 ELSE 0 END) AS indexablePages
    FROM pages
    WHERE runId = ?
  `).get(runId);
  const findingCounts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM check_results
    WHERE runId = ?
    GROUP BY status
    ORDER BY status ASC
  `).all(runId);
  const runtimeMetrics = db.prepare('SELECT * FROM run_runtime_metrics WHERE runId=?').get(runId) || null;
  return {
    runId,
    projectId: run.projectId || null,
    provenance: {
      primaryHost: run.primaryHost || null,
      gitCommit: run.runtimeGitCommit || null,
      buildVersion: run.runtimeBuildVersion || null,
      configHash: run.runtimeConfigHash || null
    },
    domain: run.finalDomain || run.inputDomain,
    auditType: run.auditType,
    status: run.status,
    triggerType: run.triggerType || 'manual',
    scheduledRunId: run.scheduledRunId || null,
    comparisonId: run.comparisonId || null,
    scores,
    scoring: {
      scoringVersion: scores.scoringVersion || run.scoringVersion || null,
      deduplicationVersion: scores.deduplicationVersion || run.deduplicationVersion || null,
      coverageModelVersion: scores.coverageModelVersion || run.coverageModelVersion || null,
      availabilitySemanticsVersion: scores.availabilitySemanticsVersion || run.availabilitySemanticsVersion || null,
      checkLogicVersion: scores.checkLogicVersion || run.checkLogicVersion || null,
      scoreStatus: scores.scoreStatus || run.scoreStatus || 'historical_unknown',
      weightedCoverage: scores.weightedCoverage ?? null,
      primaryCoverage: scores.primaryCoverage ?? null,
      diagnosticCoverage: scores.diagnosticCoverage ?? null,
      inventoryCoverage: scores.inventoryCoverage ?? null,
      renderRequiredCoverage: scores.renderRequiredCoverage ?? null,
      coverageUnits: scores.breakdown?.coverageUnits || []
    },
    processedUrls: run.processedUrls,
    successfulUrls: run.successfulUrls,
    failedUrls: run.failedUrls,
    skippedUrls: run.skippedUrls,
    pages: pageCounts,
    display: {
      actionItemCount: reviewSummary.actionItemCount || 0,
      actionableFindings: reviewSummary.actionableFindings || 0,
      opportunityCount: reviewSummary.opportunityCount || 0,
      securityBestPracticeCount: reviewSummary.securityBestPracticeCount || 0,
      mediaFindingCount: reviewSummary.mediaFindingCount || 0,
      templatePerformanceCount: reviewSummary.templatePerformanceCount || 0,
      passedChecks: reviewSummary.passedChecks || 0,
      notApplicableChecks: reviewSummary.notApplicableChecks || 0,
      reviewableFindings: reviewSummary.reviewableFindings || 0,
      reviewRecommendedCount: reviewSummary.reviewRecommendedCount || 0
    },
    samplingSummary,
    reviewSummary,
    findings: {
      total: results.length,
      byStatus: findingCounts
    },
    runtimeMetrics: runtimeMetrics ? normalizeJsonFields(runtimeMetrics) : null,
    enterpriseSummary: buildEnterpriseSummary(db, runId, run),
    storage: {
      profile: run.storageProfile || 'standard',
      crawlScaleMode: run.crawlScaleMode || null,
      estimate: safeJson(run.storageEstimateJson, null)
    },
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
}

function buildRunConfig(run) {
  return {
    id: run.id,
    inputDomain: run.inputDomain,
    finalDomain: run.finalDomain,
    brandName: run.brandName,
    auditType: run.auditType,
    maxUrls: run.maxUrls,
    maxDepth: run.maxDepth,
    concurrency: run.concurrency,
    respectRobotsTxt: Boolean(run.respectRobotsTxt),
    crawlMode: run.crawlMode,
    includePatternsJson: run.includePatternsJson,
    excludePatternsJson: run.excludePatternsJson,
    usePlaywright: Boolean(run.usePlaywright),
    playwrightMode: run.playwrightMode,
    metricsMode: run.runtimeMetricsVersion ? (run.metricsMode || 'off') : null,
    renderPlanningVersion: run.renderPlanningVersion || null,
    runtimeMetricsVersion: run.runtimeMetricsVersion || null,
    coverageModelVersion: run.coverageModelVersion || null,
    availabilitySemanticsVersion: run.availabilitySemanticsVersion || null,
    renderBudget: {
      maxRenderedUrls: run.maxRenderedUrls ?? null,
      maxTotalRenderTimeMs: run.maxTotalRenderTimeMs ?? null,
      maxSettlingTimeMsPerUrl: run.maxSettlingTimeMsPerUrl ?? null,
      maxBrowserFailures: run.maxBrowserFailures ?? null,
      maxPersistedRenderBytes: run.maxPersistedRenderBytes ?? null
    },
    enableTemplateSampling: Boolean(run.enableTemplateSampling),
    enablePlaywrightSampling: Boolean(run.enablePlaywrightSampling),
    enableLighthouseSampling: Boolean(run.enableLighthouseSampling),
    sampleOnlyIndexable: Boolean(run.sampleOnlyIndexable),
    triggerType: run.triggerType || 'manual',
    scheduledRunId: run.scheduledRunId || null,
    baselineRunId: run.baselineRunId || null,
    comparisonId: run.comparisonId || null
    ,
    provenance: {
      primaryHost: run.primaryHost || null,
      gitCommit: run.runtimeGitCommit || null,
      buildVersion: run.runtimeBuildVersion || null,
      configHash: run.runtimeConfigHash || null,
      runtime: safeJson(run.runtimeProvenanceJson, null)
    },
    scoring: {
      scoringVersion: run.scoringVersion || null,
      deduplicationVersion: run.deduplicationVersion || null,
      coverageModelVersion: run.coverageModelVersion || null,
      availabilitySemanticsVersion: run.availabilitySemanticsVersion || null,
      checkLogicVersion: run.checkLogicVersion || null,
      scoreStatus: run.scoreStatus || (run.scoringVersion ? null : 'historical_unknown'),
      scoreComputedAt: run.scoreComputedAt || null
    },
    sourceType: run.sourceType || 'crawl',
    crawlScaleMode: run.crawlScaleMode || 'medium',
    storageProfile: run.storageProfile || 'standard',
    storage: {
      storeRawHtml: Boolean(run.storeRawHtml),
      storeRenderedHtml: Boolean(run.storeRenderedHtml),
      storeResponseHeaders: Boolean(run.storeResponseHeaders),
      storeAllLinks: Boolean(run.storeAllLinks),
      storeAllImages: Boolean(run.storeAllImages),
      storeAllResources: Boolean(run.storeAllResources),
      storeAffectedOnlyDetails: Boolean(run.storeAffectedOnlyDetails),
      maxEvidenceSamplesPerCheck: run.maxEvidenceSamplesPerCheck,
      maxStoredDetailRowsPerCheck: run.maxStoredDetailRowsPerCheck,
      maxRawHtmlBytesPerUrl: run.maxRawHtmlBytesPerUrl,
      estimate: safeJson(run.storageEstimateJson, null)
    },
    llm: {
      enabled: Boolean(run.enableLlmChecks),
      provider: run.llmProvider || 'none',
      model: run.llmModel || null,
      maxSampleUrls: run.llmMaxSampleUrls || 0,
      maxChecks: run.llmMaxChecks || 0,
      dryRun: Boolean(run.llmDryRun),
      warnings: safeJson(run.llmWarningsJson, [])
    },
    importSummary: safeJson(run.importSummaryJson, null)
  };
}

function buildScheduleContext(run) {
  return {
    scheduledRunId: run.scheduledRunId || null,
    triggerType: run.triggerType || 'manual',
    scheduleName: run.scheduleName || null,
    baselineMode: run.scheduleBaselineMode || null,
    autoCompare: Boolean(run.scheduleAutoCompare),
    baselineRunId: run.baselineRunId || null,
    comparisonId: run.comparisonId || null
  };
}

function fallbackCsv(type, error) {
  const message = error instanceof Error ? error.message : String(error || 'Unavailable');
  return `info,message\n${csvEscape(type)},${csvEscape(message)}\n`;
}

function tableRows(db, table, runId, limit = null) {
  requireRunId(runId, `export table ${table}`);
  if (!limit) return db.prepare(`SELECT * FROM ${table} WHERE runId = ? ORDER BY id ASC`).all(runId);
  return db.prepare(`SELECT * FROM ${table} WHERE runId = ? ORDER BY id ASC LIMIT ?`).all(runId, limit);
}

function runtimeMetricsForExport(db, runId) {
  const row = db.prepare('SELECT * FROM run_runtime_metrics WHERE runId=?').get(runId);
  return row ? normalizeJsonFields(row) : null;
}

function createExportManifest(db, runId, run) {
  const tables = ['pages', 'page_links', 'page_images', 'resources', 'http_timing_measurements', 'schemas', 'domain_assets', 'template_clusters', 'check_results', 'run_runtime_metrics', 'url_runtime_metrics'];
  const tableLimits = exportTableLimits(run);
  const tableStats = {};
  for (const table of tables) {
    const totalRows = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE runId = ?`).get(runId).count || 0;
    const limit = tableLimits[table] || null;
    tableStats[table] = {
      totalRows,
      storedRows: limit ? Math.min(totalRows, limit) : totalRows,
      truncated: Boolean(limit && totalRows > limit),
      howToIncreaseLimit: limit && totalRows > limit
        ? 'Increase storage/export limits by using debug profile or raising maxStoredDetailRowsPerCheck for targeted runs.'
        : null
    };
  }
  return {
    format: 'omfire-enterprise-audit-export',
    version: 1,
    generatedAt: new Date().toISOString(),
    runId,
    projectId: run.projectId || null,
    provenance: {
      primaryHost: run.primaryHost || null,
      gitCommit: run.runtimeGitCommit || null,
      buildVersion: run.runtimeBuildVersion || null,
      configHash: run.runtimeConfigHash || null
    },
    scoring: {
      scoringVersion: run.scoringVersion || null,
      deduplicationVersion: run.deduplicationVersion || null,
      coverageModelVersion: run.coverageModelVersion || null,
      availabilitySemanticsVersion: run.availabilitySemanticsVersion || null,
      checkLogicVersion: run.checkLogicVersion || null,
      scoreStatus: run.scoreStatus || (run.scoringVersion ? null : 'historical_unknown')
    },
    sourceType: run.sourceType || 'crawl',
    storageProfile: run.storageProfile || 'standard',
    crawlScaleMode: run.crawlScaleMode || null,
    summaryFirst: true,
    tables: tableStats,
    tableLimits,
    warnings: Object.entries(tableStats)
      .filter(([, stat]) => stat.truncated)
      .map(([table, stat]) => ({
        table,
        truncated: true,
        storedRows: stat.storedRows,
        totalAffected: stat.totalRows,
        howToIncreaseLimit: stat.howToIncreaseLimit
      }))
  };
}

function exportTableLimits(run) {
  const profile = run.storageProfile || 'standard';
  const scale = run.crawlScaleMode || 'medium';
  const base = profile === 'debug'
    ? 50000
    : profile === 'lean'
      ? 5000
      : (scale === 'large' || scale === 'enterprise' ? 20000 : null);
  const detailCap = Number(run.maxStoredDetailRowsPerCheck || 1000);
  return {
    pages: base,
    page_links: profile === 'lean' ? detailCap : base,
    page_images: profile === 'lean' ? detailCap : base,
    resources: profile === 'lean' ? detailCap : base,
    http_timing_measurements: base,
    schemas: base,
    domain_assets: null,
    template_clusters: null,
    check_results: null
  };
}

function normalizeJsonFields(row) {
  const output = { ...row };
  for (const [key, value] of Object.entries(output)) {
    if (!key.endsWith('Json')) continue;
    output[key.replace(/Json$/, '')] = safeJson(value, value);
  }
  return output;
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function fileNameForType(type) {
  const names = {
    findings: 'findings',
    pages: 'urls',
    links: 'links',
    images: 'images',
    resources: 'resources',
    schemas: 'schemas',
    'geo-signals': 'geo-signals',
    reviews: 'reviews',
    templates: 'templates',
    samples: 'samples',
    'playwright-results': 'playwright-results',
    'lighthouse-results': 'lighthouse-results',
    'template-performance': 'template-performance',
    'status-summary': 'status-summary'
  };
  return names[type] || type;
}

function safeFileName(value) {
  return String(value || 'check')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
