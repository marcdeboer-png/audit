import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, resetInterruptedWork } from '../db/database.js';
import {
  bulkUpsertFindingReviews,
  createScheduledRun,
  deleteReview,
  deleteRun,
  deleteScheduledRun,
  disableScheduledRun,
  enableScheduledRun,
  getLatestLogs,
  getReviewSummary,
  getSamplingSummary,
  getScheduledRun,
  getScheduleSummary,
  getRunComparison,
  getRunHealth,
  getRunWithProject,
  listComparisonsForSchedule,
  listComparisonCandidates,
  listLighthouseResults,
  listPlaywrightResults,
  listReviewsForRun,
  listRunComparisons,
  listRunsForSchedule,
  listScheduledRuns,
  listTemplatePerformanceSummary,
  listTemplateSampleResults,
  listTemplateClusterPages,
  listTemplateClusters,
  saveRunComparison,
  updateScheduledRun,
  upsertFindingReview
} from '../db/repositories.js';
import { cancelAudit, pauseAudit, recoverAudit, resumeAudit, startAudit } from '../crawler/auditRunner.js';
import { loadResultsWithScores } from '../checks/checkEngine.js';
import { compareRuns } from '../comparison/runComparison.js';
import { generateReport } from '../reports/reportGenerator.js';
import { renderComparisonReport } from '../reports/comparisonReportGenerator.js';
import { elapsedSeconds, estimatedRemainingSeconds, pagesPerMinute } from '../utils/time.js';
import { getCsvExportSpec, listCsvExports, streamCsvExport } from '../reports/csvExporter.js';
import { collectComparisonCsv, getComparisonCsvSpec } from '../reports/comparisonCsvExporter.js';
import { SchedulerService } from '../scheduler/schedulerService.js';
import { getCheckDetail } from '../results/checkDetailService.js';
import {
  collectCheckDetailCsv,
  collectFullAuditJson,
  collectFullAuditZip,
  fullAuditJsonFilename,
  fullAuditZipFilename
} from '../results/checkExportService.js';
import { getCapabilities } from '../runtime/capabilities.js';
import { buildMaturityModel } from '../maturity/maturityService.js';
import { estimateStorage, normalizeEnterpriseConfig, storageProfileSummary } from '../storage/storageProfiles.js';
import { importScreamingFrogAudit } from '../importers/screamingFrog/screamingFrogImportService.js';
import { buildBenchmarkSummary } from '../analysis/benchmarkSummary.js';
import { getLatestValidationReport, validateRunAgainstReference } from '../validation/referenceAudit/validationService.js';
import { buildValidationExportPayload } from '../validation/referenceAudit/validationExportService.js';
import { buildUnresolvedAuditQueue } from '../validation/unresolved/unresolvedAuditPointService.js';
import {
  createEvidenceJobExecution,
  dryRunEvidenceJob,
  getEvidenceJobDetails,
  listEvidenceJobsForRun
} from '../evidenceJobs/evidenceJobRunner.js';
import { buildEvidenceImpactForRun } from '../evidenceJobs/evidenceImpactService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const db = getDb();
resetInterruptedWork(db);
const schedulerService = new SchedulerService(db, {
  pollIntervalMs: Number(process.env.SCHEDULER_POLL_INTERVAL_MS || 60000)
});

app.use(express.json({ limit: '25mb' }));
app.use(express.static(publicDir));

app.get('/api/capabilities', async (req, res) => {
  try {
    res.json(await getCapabilities());
  } catch (error) {
    res.status(500).json({ error: 'Capability check failed', message: error.message });
  }
});

app.get('/api/schedules', (req, res) => {
  const schedules = listScheduledRuns(db).map(formatScheduleSummary);
  res.json({ schedules });
});

app.post('/api/schedules', (req, res) => {
  try {
    validateSchedulePayload(req.body || {});
    const scheduleId = createScheduledRun(db, schedulePayloadFromRequest(req.body || {}));
    res.status(201).json({ schedule: formatScheduleSummary(getScheduledRun(db, scheduleId)) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/schedules/:id', (req, res) => {
  const summary = getScheduleSummary(db, Number(req.params.id));
  if (!summary) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ schedule: formatScheduleSummary(summary) });
});

app.put('/api/schedules/:id', (req, res) => {
  const existing = getScheduledRun(db, Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  try {
    validateSchedulePayload(req.body || {}, { partial: true });
    const schedule = updateScheduledRun(db, existing.id, schedulePayloadFromRequest(req.body || {}, { partial: true }));
    res.json({ schedule: formatScheduleSummary(schedule) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/schedules/:id', (req, res) => {
  const deleted = deleteScheduledRun(db, Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ deleted: true, scheduleId: Number(req.params.id) });
});

app.post('/api/schedules/:id/run-now', async (req, res) => {
  try {
    const result = await schedulerService.runNow(Number(req.params.id));
    res.status(result.error ? 400 : 202).json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/schedules/:id/enable', (req, res) => {
  const schedule = enableScheduledRun(db, Number(req.params.id));
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ schedule: formatScheduleSummary(schedule) });
});

app.post('/api/schedules/:id/disable', (req, res) => {
  const schedule = disableScheduledRun(db, Number(req.params.id));
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ schedule: formatScheduleSummary(schedule) });
});

app.get('/api/schedules/:id/runs', (req, res) => {
  const schedule = getScheduledRun(db, Number(req.params.id));
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ scheduleId: schedule.id, runs: listRunsForSchedule(db, schedule.id).map(formatRunSummary) });
});

app.get('/api/schedules/:id/comparisons', (req, res) => {
  const schedule = getScheduledRun(db, Number(req.params.id));
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ scheduleId: schedule.id, comparisons: listComparisonsForSchedule(db, schedule.id) });
});

app.post('/api/audits/start', async (req, res) => {
  try {
    const { runId } = await startAudit(req.body);
    res.status(201).json({ runId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/audits/storage-estimate', (req, res) => {
  try {
    const normalized = normalizeEnterpriseConfig(req.body || {});
    res.json({
      estimate: estimateStorage({ ...(req.body || {}), ...normalized }),
      storageProfile: storageProfileSummary(normalized.storageProfile),
      crawlScaleMode: normalized.crawlScaleMode
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/audits/import/screaming-frog', async (req, res) => {
  try {
    const result = await importScreamingFrogAudit(db, req.body || {});
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/imports/screaming-frog', async (req, res) => {
  try {
    const result = await importScreamingFrogAudit(db, req.body || {});
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/audits', (req, res) => {
  const rows = db.prepare(`
    SELECT
      r.id, r.status, r.auditType, r.maxUrls, r.maxDepth, r.concurrency,
      r.currentPhase, r.discoveredUrls, r.processedUrls, r.successfulUrls,
      r.failedUrls, r.skippedUrls, r.startedAt, r.finishedAt, r.updatedAt,
      r.crawlMode, r.userAgent, r.robotsUserAgent, r.targetPagesPerSecond,
      r.crawlDelayMs, r.requestTimeoutMs, r.usePlaywright,
      r.playwrightMode, r.playwrightSampleLimit,
      r.maxSitemapUrls, r.maxSitemaps, r.sitemapBatchSize,
      r.enableTemplateSampling, r.enablePlaywrightSampling, r.enableLighthouseSampling,
      r.sampleUrlsPerTemplate, r.maxTemplateSamplesTotal,
      r.lighthouseDevice, r.lighthouseCategoriesJson, r.lighthouseTimeoutMs,
      r.playwrightTimeoutMs, r.collectScreenshots, r.sampleOnlyIndexable,
      r.samplesTotal, r.samplesProcessed, r.currentSampleUrl,
      r.sitemapUrlsDiscovered, r.sitemapUrlsQueued, r.sitemapFilesProcessed,
      r.currentSitemapUrl, r.scheduledRunId, r.triggerType, r.baselineRunId,
      r.comparisonId,
      r.sourceType, r.crawlScaleMode, r.storageProfile,
      r.storeRawHtml, r.storeRenderedHtml, r.storeResponseHeaders,
      r.storeAllLinks, r.storeAllImages, r.storeAllResources,
      r.storeAffectedOnlyDetails, r.maxEvidenceSamplesPerCheck,
      r.maxStoredDetailRowsPerCheck, r.maxRawHtmlBytesPerUrl,
      r.storageEstimateJson, r.importSummaryJson,
      r.enableLlmChecks, r.llmProvider, r.llmModel, r.llmMaxSampleUrls,
      r.llmMaxChecks, r.llmMaxTokens, r.llmDryRun, r.llmWarningsJson,
      r.benchmarkSummaryJson,
      p.inputDomain, p.finalDomain, p.brandName,
      sr.name AS scheduleName,
      sr.baselineMode AS scheduleBaselineMode,
      sr.autoCompare AS scheduleAutoCompare
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    LEFT JOIN scheduled_runs sr ON sr.id = r.scheduledRunId
    ORDER BY r.id DESC
    LIMIT 100
  `).all();
  res.json({ audits: rows.map(formatRunSummary) });
});

app.get('/api/audits/:runId', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(formatRunDetail(run));
});

app.get('/api/audits/:runId/logs', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ logs: getLatestLogs(db, run.id, Number(req.query.limit || 100)) });
});

app.get('/api/audits/:runId/reviews', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    summary: getReviewSummary(db, run.id),
    reviews: listReviewsForRun(db, run.id)
  });
});

app.get('/api/audits/:runId/review-summary', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(getReviewSummary(db, run.id));
});

app.get('/api/audits/:runId/maturity', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'completed') {
    return res.status(409).json({ error: 'Run not completed yet', status: run.status, runId: run.id });
  }
  res.json(buildMaturityModel(db, run.id));
});

app.post('/api/audits/:runId/validation', async (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'completed') {
    return res.status(409).json({ error: 'Run not completed yet', status: run.status, runId: run.id });
  }
  try {
    const report = await validateRunAgainstReference(db, {
      ...(req.body || {}),
      runId: run.id
    });
    res.status(201).json(report);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/audits/:runId/validation', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const validation = getLatestValidationReport(db, run.id);
  if (!validation) return res.status(404).json({ error: 'Validation report not found for run' });
  res.json(validation.report);
});

app.get('/api/audits/:runId/validation/export/:file', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  return sendValidationExport(res, run.id, req.params.file);
});

app.get('/api/audits/:runId/unresolved', (req, res) => {
  const payload = latestUnresolvedPayload(Number(req.params.runId));
  if (!payload) return res.status(404).json({ error: 'Validation report not found for run' });
  res.json(payload.queue);
});

app.get('/api/audits/:runId/evidence-packs', (req, res) => {
  const payload = latestUnresolvedPayload(Number(req.params.runId));
  if (!payload) return res.status(404).json({ error: 'Validation report not found for run' });
  res.json(payload.evidencePacks);
});

app.get('/api/audits/:runId/evidence-job-plan', (req, res) => {
  const payload = latestUnresolvedPayload(Number(req.params.runId));
  if (!payload) return res.status(404).json({ error: 'Validation report not found for run' });
  res.json(payload.evidenceJobPlan);
});

app.get('/api/audits/:runId/evidence-impact', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(buildEvidenceImpactForRun(db, run.id));
});

app.post('/api/audits/:runId/evidence-impact/recompute', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(buildEvidenceImpactForRun(db, run.id));
});

app.post('/api/audits/:runId/evidence-jobs/dry-run', async (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  try {
    res.json(await dryRunEvidenceJob(db, run.id, req.body || {}));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/audits/:runId/evidence-jobs', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  try {
    const execution = createEvidenceJobExecution(db, run.id, req.body || {});
    execution.run().catch((error) => {
      console.error('Evidence job failed', { runId: run.id, jobId: execution.job.jobId, error });
    });
    res.status(202).json({ job: execution.job, dryRun: execution.dryRun });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/audits/:runId/evidence-jobs', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(listEvidenceJobsForRun(db, run.id));
});

app.get('/api/evidence-jobs/:jobId', (req, res) => {
  const details = getEvidenceJobDetails(db, Number(req.params.jobId), { limit: Number(req.query.limit || 1000) });
  if (!details) return res.status(404).json({ error: 'Evidence job not found' });
  res.json(details);
});

app.get('/api/audits/:runId/samples', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    summary: getSamplingSummary(db, run.id),
    ...listTemplateSampleResults(db, run.id, {
      templateClusterKey: req.query.templateClusterKey || null,
      status: req.query.status || null,
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 500)
    })
  });
});

app.get('/api/audits/:runId/playwright-results', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(listPlaywrightResults(db, run.id, {
    page: Number(req.query.page || 1),
    limit: Number(req.query.limit || 500)
  }));
});

app.get('/api/audits/:runId/lighthouse-results', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(listLighthouseResults(db, run.id, {
    page: Number(req.query.page || 1),
    limit: Number(req.query.limit || 500)
  }));
});

app.get('/api/audits/:runId/template-performance', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    summary: getSamplingSummary(db, run.id),
    ...listTemplatePerformanceSummary(db, run.id, {
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 500)
    })
  });
});

app.get('/api/audits/:runId/check-results/:checkResultId/details', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const detail = getCheckDetail(db, run.id, Number(req.params.checkResultId), {
    maxRows: Number(req.query.limit || 10000)
  });
  if (!detail) return res.status(404).json({ error: 'Check result not found for run' });
  res.json(detail);
});

app.get('/api/audits/:runId/check-results/:checkResultId/export.csv', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const payload = collectCheckDetailCsv(db, run.id, Number(req.params.checkResultId));
  if (!payload) return res.status(404).json({ error: 'Check result not found for run' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
  res.send(payload.csv);
});

app.post('/api/audits/:runId/check-results/:checkResultId/review', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    const review = upsertFindingReview(db, run.id, Number(req.params.checkResultId), req.body || {});
    if (!review) return res.status(404).json({ error: 'Check result not found for run' });
    res.status(200).json({ review, summary: getReviewSummary(db, run.id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/audits/:runId/check-results/:checkResultId/review', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const deleted = deleteReview(db, run.id, Number(req.params.checkResultId));
  if (!deleted) return res.status(404).json({ error: 'Check result not found for run' });
  res.json({ deleted: true, summary: getReviewSummary(db, run.id) });
});

app.post('/api/audits/:runId/reviews/bulk', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    const reviews = bulkUpsertFindingReviews(db, run.id, req.body?.checkResultIds, req.body || {});
    if (!reviews) return res.status(404).json({ error: 'One or more check results were not found for run' });
    res.json({ updated: reviews.length, reviews, summary: getReviewSummary(db, run.id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/audits/:runId/comparison-candidates', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    runId: run.id,
    candidates: listComparisonCandidates(db, run.id).map(enrichComparisonCandidate)
  });
});

app.post('/api/audits/compare', (req, res) => {
  try {
    const baseRunId = Number(req.body?.baseRunId);
    const compareRunId = Number(req.body?.compareRunId);
    if (!Number.isFinite(baseRunId) || !Number.isFinite(compareRunId)) {
      return res.status(400).json({ error: 'baseRunId and compareRunId are required.' });
    }
    const comparison = compareRuns(db, { baseRunId, compareRunId });
    const saved = req.body?.save ? saveRunComparison(db, comparison) : null;
    res.json(saved ? { ...comparison, comparisonId: saved.id, savedComparison: saved } : comparison);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/audits/comparisons/:comparisonId', (req, res) => {
  const comparison = getRunComparison(db, Number(req.params.comparisonId));
  if (!comparison) return res.status(404).json({ error: 'Comparison not found' });
  res.json(comparison);
});

app.get('/api/audits/:runId/comparisons', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ comparisons: listRunComparisons(db, run.id) });
});

app.get('/api/audits/compare/report', (req, res) => {
  try {
    const comparison = comparisonFromQuery(req.query);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderComparisonReport(comparison));
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/audits/comparisons/:comparisonId/report', (req, res) => {
  const comparison = getRunComparison(db, Number(req.params.comparisonId));
  if (!comparison) return res.status(404).json({ error: 'Comparison not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderComparisonReport(comparison));
});

app.get('/api/audits/compare/export/:file', (req, res) => {
  try {
    const comparison = comparisonFromQuery(req.query);
    sendComparisonCsv(res, comparison, req.params.file);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/audits/comparisons/:comparisonId/export/:file', (req, res) => {
  const comparison = getRunComparison(db, Number(req.params.comparisonId));
  if (!comparison) return res.status(404).json({ error: 'Comparison not found' });
  sendComparisonCsv(res, comparison, req.params.file);
});

app.post('/api/audits/:runId/pause', (req, res) => {
  try {
    res.json(formatRunDetail(pauseAudit(req.params.runId)));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/audits/:runId/resume', (req, res) => {
  try {
    res.json(formatRunDetail(resumeAudit(req.params.runId)));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/audits/:runId/recover', (req, res) => {
  try {
    res.json(formatRunDetail(recoverAudit(req.params.runId)));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/audits/:runId/cancel', (req, res) => {
  try {
    res.json(formatRunDetail(cancelAudit(req.params.runId)));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.delete('/api/audits/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  const run = getRunWithProject(db, runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    cancelAudit(runId);
  } catch {
    // The delete operation below is authoritative for persisted data.
  }

  removeGeneratedFiles(runId);
  deleteRun(db, runId);
  res.json({ deleted: true, runId });
});

app.get('/api/audits/:runId/results', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const { scores, results } = loadResultsWithScores(db, run.id);
  const reviewSummary = getReviewSummary(db, run.id);
  const samplingSummary = getSamplingSummary(db, run.id);
  const summary = db.prepare(`
    SELECT status, priority, COUNT(*) AS count
    FROM check_results
    WHERE runId = ?
    GROUP BY status, priority
  `).all(run.id);
  res.json({ run: formatRunDetail(run), scores, summary, reviewSummary, samplingSummary, results });
});

app.get('/api/audits/:runId/pages', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const offset = (page - 1) * limit;
  const total = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(run.id).count;
  const pages = db.prepare(`
    SELECT id, url, finalUrl, statusCode, contentType, indexable, title, titleLength,
      metaDescriptionLength, h1Count, canonical, htmlLang, wordCountRaw,
      wordCountRendered, rawHtmlSize, internalLinksCount, externalLinksCount,
      imagesCount, imagesWithoutAltCount, loadTimeMs, ttfbMs, schemaTypesJson,
      pageType, hasTables, hasLists, hasFaqPattern, hasVisibleDate,
      hasAuthorPattern, externalSourceLinksCount, hasVideoEmbed,
      templateClusterId, templateClusterKey
    FROM pages
    WHERE runId = ?
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `).all(run.id, limit, offset).map((row) => ({
    ...row,
    schemaTypes: safeParse(row.schemaTypesJson, [])
  }));
  res.json({ page, limit, total, pages });
});

app.get('/api/audits/:runId/templates', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({ templates: listTemplateClusters(db, run.id) });
});

app.get('/api/audits/:runId/templates/:clusterId/pages', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const payload = listTemplateClusterPages(db, run.id, Number(req.params.clusterId), {
    page: Number(req.query.page || 1),
    limit: Number(req.query.limit || 50)
  });
  res.json(payload);
});

app.get('/api/audits/:runId/report', (req, res) => {
  const run = getRunWithProject(db, Number(req.params.runId));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const reportPath = path.join(process.cwd(), 'reports', `run-${run.id}.html`);
  if (!fs.existsSync(reportPath)) {
    generateReport(db, run.id);
  }
  res.sendFile(reportPath);
});

app.get('/api/audits/:runId/export/:file', async (req, res) => {
  const runId = Number(req.params.runId);
  const run = getRunWithProject(db, runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const requested = String(req.params.file || '');
  if (requested === 'full.zip' || requested === 'full-audit.zip') {
    if (run.status !== 'completed') {
      return res.status(409).json({ error: 'Run not completed yet', status: run.status, runId });
    }
    try {
      const payload = collectFullAuditZip(db, runId, listCsvExports());
      if (!payload) return res.status(404).json({ error: 'Run not found' });
      const filename = fullAuditZipFilename(runId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', payload.buffer.length);
      res.send(payload.buffer);
    } catch (error) {
      console.error('Full ZIP export failed', { runId, endpoint: req.originalUrl, error });
      res.status(500).json({
        error: 'Full ZIP export failed',
        message: error.message,
        endpoint: req.originalUrl,
        runId
      });
    }
    return;
  }

  if (requested === 'full.json' || requested === 'full-audit.json') {
    if (run.status !== 'completed') {
      return res.status(409).json({ error: 'Run not completed yet', status: run.status, runId });
    }
    try {
      const payload = collectFullAuditJson(db, runId, listCsvExports());
      if (!payload) return res.status(404).json({ error: 'Run not found' });
      const filename = fullAuditJsonFilename(runId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', Buffer.byteLength(payload.body));
      res.send(payload.body);
    } catch (error) {
      console.error('Full JSON export failed', { runId, endpoint: req.originalUrl, error });
      res.status(500).json({
        error: 'Full JSON export failed',
        message: error.message,
        endpoint: req.originalUrl,
        runId
      });
    }
    return;
  }

  if (requested === 'maturity.json') {
    if (run.status !== 'completed') {
      return res.status(409).json({ error: 'Run not completed yet', status: run.status, runId });
    }
    const maturity = buildMaturityModel(db, runId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${runId}-maturity.json"`);
    res.send(`${JSON.stringify(maturity, null, 2)}\n`);
    return;
  }

  if (requested === 'benchmark-summary.json') {
    const summary = safeParse(run.benchmarkSummaryJson, null) || buildBenchmarkSummary(db, runId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${runId}-benchmark-summary.json"`);
    res.send(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  if (isValidationExportFile(requested)) {
    return sendValidationExport(res, runId, requested);
  }

  const type = requested.endsWith('.csv') ? requested.slice(0, -4) : requested;
  const spec = getCsvExportSpec(type, runId);
  if (!spec) return res.status(404).json({ error: 'Export not found' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${spec.filename}"`);

  try {
    await streamCsvExport(db, runId, type, res);
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  }
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Audit UI: http://localhost:${port}`);
  if (process.env.SCHEDULER_DISABLED !== 'true') {
    schedulerService.start();
  }
});

function formatScheduleSummary(schedule) {
  if (!schedule) return null;
  const lastRun = schedule.lastRunId ? getRunWithProject(db, schedule.lastRunId) : null;
  const latestComparison = schedule.latestComparison || listComparisonsForSchedule(db, schedule.id, { limit: 1 })[0] || null;
  const scores = lastRun ? safeScores(lastRun.id) : null;
  const regressionFindings = latestComparison?.regressionFindings || [];
  return {
    ...schedule,
    isActive: Boolean(schedule.isActive),
    enabled: Boolean(schedule.enabled),
    autoCompare: Boolean(schedule.autoCompare),
    config: schedule.config || {},
    lastRun: lastRun ? formatRunSummary(lastRun) : null,
    lastScores: scores,
    lastScore: scores?.overallScore ?? null,
    latestComparison: latestComparison ? {
      id: latestComparison.id,
      status: latestComparison.status,
      baseRunId: latestComparison.baseRunId,
      compareRunId: latestComparison.compareRunId,
      summary: latestComparison.summary || {},
      regressionFindingCount: regressionFindings.length,
      resolvedCount: latestComparison.summary?.findingDeltaCounts?.resolved || 0
    } : null,
    scoreDelta: latestComparison?.summary?.overallScoreDelta ?? null,
    regressionFindingCount: regressionFindings.length,
    resolvedCount: latestComparison?.summary?.findingDeltaCounts?.resolved || 0
  };
}

function safeScores(runId) {
  try {
    return loadResultsWithScores(db, runId).scores;
  } catch {
    return { overallScore: null, techScore: null, geoScore: null };
  }
}

function validateSchedulePayload(body, { partial = false } = {}) {
  if (!partial && !String(body.domain || '').trim()) throw new Error('domain is required');
  const allowedScheduleTypes = new Set(['daily', 'weekly', 'monthly', 'manual']);
  const allowedAuditTypes = new Set(['tech', 'geo', 'both']);
  const allowedBaselineModes = new Set(['previous_successful', 'fixed_run', 'none']);
  if (body.scheduleType !== undefined && !allowedScheduleTypes.has(body.scheduleType)) {
    throw new Error('Invalid scheduleType');
  }
  if (body.auditType !== undefined && !allowedAuditTypes.has(body.auditType)) {
    throw new Error('Invalid auditType');
  }
  if (body.baselineMode !== undefined && !allowedBaselineModes.has(body.baselineMode)) {
    throw new Error('Invalid baselineMode');
  }
  if (body.dayOfWeek !== undefined && (Number(body.dayOfWeek) < 0 || Number(body.dayOfWeek) > 6)) {
    throw new Error('dayOfWeek must be between 0 and 6');
  }
  if (body.dayOfMonth !== undefined && (Number(body.dayOfMonth) < 1 || Number(body.dayOfMonth) > 31)) {
    throw new Error('dayOfMonth must be between 1 and 31');
  }
  if (body.timeOfDay !== undefined && !/^\d{1,2}:\d{2}$/.test(String(body.timeOfDay))) {
    throw new Error('timeOfDay must use HH:mm format');
  }
}

function schedulePayloadFromRequest(body, { partial = false } = {}) {
  const payload = {};
  for (const key of [
    'projectId',
    'name',
    'domain',
    'brandName',
    'auditType',
    'scheduleType',
    'intervalValue',
    'dayOfWeek',
    'dayOfMonth',
    'timeOfDay',
    'timezone',
    'nextRunAt',
    'isActive',
    'enabled',
    'baselineMode',
    'baselineRunId',
    'autoCompare',
    'lastError'
  ]) {
    if (body[key] !== undefined) payload[key] = body[key];
  }

  const config = normalizeScheduleConfig(body);
  if (!partial || Object.keys(config).length || body.config !== undefined) payload.config = config;
  return payload;
}

function normalizeScheduleConfig(body) {
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? { ...body.config } : {};
  for (const key of [
    'maxUrls',
    'maxDepth',
    'concurrency',
    'respectRobotsTxt',
    'crawlMode',
    'userAgent',
    'robotsUserAgent',
    'targetPagesPerSecond',
    'includePatterns',
    'excludePatterns',
    'usePlaywright',
    'playwrightMode',
    'playwrightSampleLimit',
    'enableTemplateSampling',
    'enablePlaywrightSampling',
    'enableLighthouseSampling',
    'sampleUrlsPerTemplate',
    'requestTimeoutMs',
    'crawlDelayMs',
    'maxAttempts',
    'maxConcurrentPerHost',
    'retryBaseDelayMs',
    'retryMaxDelayMs',
    'maxSitemapUrls',
    'maxSitemaps',
    'sitemapBatchSize',
    'maxTemplateSamplesTotal',
    'lighthouseDevice',
    'lighthouseCategories',
    'lighthouseTimeoutMs',
    'playwrightTimeoutMs',
    'renderSettlingMaxMs',
    'renderSettlingIntervalMs',
    'renderSettlingMaxSnapshots',
    'renderSettlingStableSnapshots',
    'renderSettlingMinimumObservationMs',
    'maxConcurrentRenderedPages',
    'collectScreenshots',
    'sampleOnlyIndexable',
    'storageProfile',
    'storeRawHtml',
    'storeRenderedHtml',
    'storeResponseHeaders',
    'storeAllLinks',
    'storeAllImages',
    'storeAllResources',
    'storeAffectedOnlyDetails',
    'maxEvidenceSamplesPerCheck',
    'maxStoredDetailRowsPerCheck',
    'maxRawHtmlBytesPerUrl',
    'enableLlmChecks',
    'llmProvider',
    'llmModel',
    'llmMaxSampleUrls',
    'llmMaxChecks',
    'llmMaxTokens',
    'llmDryRun'
  ]) {
    if (body[key] !== undefined) config[key] = normalizeConfigValue(key, body[key]);
  }
  return config;
}

function normalizeConfigValue(key, value) {
  const numeric = new Set([
    'maxUrls',
    'maxDepth',
    'concurrency',
    'targetPagesPerSecond',
    'playwrightSampleLimit',
    'sampleUrlsPerTemplate',
    'requestTimeoutMs',
    'crawlDelayMs',
    'maxAttempts',
    'maxConcurrentPerHost',
    'retryBaseDelayMs',
    'retryMaxDelayMs',
    'maxSitemapUrls',
    'maxSitemaps',
    'sitemapBatchSize',
    'maxTemplateSamplesTotal',
    'lighthouseTimeoutMs',
    'playwrightTimeoutMs',
    'renderSettlingMaxMs',
    'renderSettlingIntervalMs',
    'renderSettlingMaxSnapshots',
    'renderSettlingStableSnapshots',
    'renderSettlingMinimumObservationMs',
    'maxConcurrentRenderedPages',
    'maxEvidenceSamplesPerCheck',
    'maxStoredDetailRowsPerCheck',
    'maxRawHtmlBytesPerUrl',
    'llmMaxSampleUrls',
    'llmMaxChecks',
    'llmMaxTokens'
  ]);
  const booleans = new Set([
    'respectRobotsTxt',
    'usePlaywright',
    'enableTemplateSampling',
    'enablePlaywrightSampling',
    'enableLighthouseSampling',
    'collectScreenshots',
    'sampleOnlyIndexable',
    'storeRawHtml',
    'storeRenderedHtml',
    'storeResponseHeaders',
    'storeAllLinks',
    'storeAllImages',
    'storeAllResources',
    'storeAffectedOnlyDetails',
    'enableLlmChecks',
    'llmDryRun'
  ]);
  if (numeric.has(key)) return value === '' || value === null ? undefined : Number(value);
  if (booleans.has(key)) return value === true || value === 'true' || value === 1 || value === '1';
  return value;
}

function enrichComparisonCandidate(candidate) {
  try {
    const { scores } = loadResultsWithScores(db, candidate.runId);
    return {
      ...candidate,
      scores,
      overallScore: scores.overallScore,
      techScore: scores.techScore,
      geoScore: scores.geoScore
    };
  } catch {
    return {
      ...candidate,
      scores: { overallScore: null, techScore: null, geoScore: null },
      overallScore: null,
      techScore: null,
      geoScore: null
    };
  }
}

function comparisonFromQuery(query) {
  if (query.comparisonId) {
    const comparison = getRunComparison(db, Number(query.comparisonId));
    if (!comparison) throw httpError(404, 'Comparison not found');
    return comparison;
  }
  const baseRunId = Number(query.baseRunId);
  const compareRunId = Number(query.compareRunId);
  if (!Number.isFinite(baseRunId) || !Number.isFinite(compareRunId)) {
    throw httpError(400, 'baseRunId and compareRunId query parameters are required.');
  }
  return compareRuns(db, { baseRunId, compareRunId });
}

function sendComparisonCsv(res, comparison, requestedFile) {
  const requested = String(requestedFile || '');
  const type = requested.endsWith('.csv') ? requested.slice(0, -4) : requested;
  const spec = getComparisonCsvSpec(type, comparison);
  if (!spec) return res.status(404).json({ error: 'Comparison export not found' });
  const csv = collectComparisonCsv(comparison, type);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${spec.filename}"`);
  res.send(csv);
}

function sendValidationExport(res, runId, requestedFile) {
  const validation = getLatestValidationReport(db, runId);
  if (!validation?.report) return res.status(404).json({ error: 'Validation report not found for run' });
  const report = withEvidenceImpact(runId, withDerivedUnresolved(validation.report));
  const files = buildValidationExportPayload(report);
  const requested = String(requestedFile || '');
  const content = files[requested];
  if (content === undefined) return res.status(404).json({ error: 'Validation export not found' });
  const contentType = requested.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : requested.endsWith('.csv')
      ? 'text/csv; charset=utf-8'
      : requested.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${requested}"`);
  res.send(content);
}

function isValidationExportFile(file) {
  return [
    'validation-report.html',
    'validation-report.md',
    'coverage-matrix.csv',
    'coverage-matrix.json',
    'partial-coverage-diagnostics.md',
    'partial-coverage-diagnostics.json',
    'unresolved-audit-points.md',
    'unresolved-audit-points.json',
    'evidence-packs.md',
    'evidence-packs.json',
    'evidence-job-plan.md',
    'evidence-job-plan.json',
    'evidence-job-impact.md',
    'evidence-job-impact.json',
    'tool-gap-backlog.md',
    'tool-gap-backlog.json',
    'validation-summary.json',
    'benchmark-summary.json'
  ].includes(String(file || ''));
}

function latestUnresolvedPayload(runId) {
  const run = getRunWithProject(db, runId);
  if (!run) return null;
  const validation = getLatestValidationReport(db, run.id);
  if (!validation?.report) return null;
  const report = withDerivedUnresolved(validation.report);
  return {
    queue: report.unresolvedAuditQueue,
    evidencePacks: report.evidencePacks || report.unresolvedAuditQueue?.evidencePacks,
    evidenceJobPlan: report.evidenceJobPlan || report.unresolvedAuditQueue?.evidenceJobPlan
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

function withEvidenceImpact(runId, report = {}) {
  try {
    return {
      ...report,
      evidenceJobImpact: report.evidenceJobImpact || buildEvidenceImpactForRun(db, runId, { validationReport: report })
    };
  } catch {
    return report;
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatRunSummary(run) {
  const ppm = pagesPerMinute(run.processedUrls, run.startedAt, run.finishedAt);
  const health = getRunHealth(db, run.id) || {};
  const reviewSummary = getReviewSummary(db, run.id);
  const samplingSummary = getSamplingSummary(db, run.id);
  const autoComparison = run.comparisonId ? getRunComparison(db, run.comparisonId) : null;
  return {
    ...run,
    scheduledRunId: run.scheduledRunId || null,
    triggerType: run.triggerType || 'manual',
    baselineRunId: run.baselineRunId || null,
    comparisonId: run.comparisonId || null,
    sourceType: run.sourceType || 'crawl',
    crawlScaleMode: run.crawlScaleMode || 'medium',
    storageProfile: run.storageProfile || 'standard',
    storageEstimate: safeParse(run.storageEstimateJson, null),
    importSummary: safeParse(run.importSummaryJson, null),
    benchmarkSummary: safeParse(run.benchmarkSummaryJson, null),
    llm: {
      enabled: Boolean(run.enableLlmChecks),
      provider: run.llmProvider || 'none',
      model: run.llmModel || null,
      maxSampleUrls: run.llmMaxSampleUrls || 0,
      maxChecks: run.llmMaxChecks || 0,
      dryRun: Boolean(run.llmDryRun),
      warnings: safeParse(run.llmWarningsJson, [])
    },
    scheduleName: run.scheduleName || null,
    schedule: run.scheduledRunId ? {
      id: run.scheduledRunId,
      name: run.scheduleName || `Schedule ${run.scheduledRunId}`,
      baselineMode: run.scheduleBaselineMode || null,
      autoCompare: Boolean(run.scheduleAutoCompare)
    } : null,
    autoComparison: autoComparison ? {
      id: autoComparison.id,
      status: autoComparison.status,
      baseRunId: autoComparison.baseRunId,
      compareRunId: autoComparison.compareRunId,
      summary: autoComparison.summary,
      regressionFindings: autoComparison.regressionFindings || []
    } : null,
    queuedUrls: queueCount(run.id, 'pending'),
    health: health.health || 'unknown',
    healthStatus: health.health || 'unknown',
    heartbeatAt: health.heartbeatAt ?? run.heartbeatAt ?? null,
    lockedAt: health.lockedAt ?? run.lockedAt ?? null,
    workerCount: health.workerCount ?? run.workerCount ?? 0,
    waitingUrls: health.waitingUrls ?? queueCount(run.id, 'waiting'),
    retryableFailures: health.retryableFailures ?? 0,
    permanentFailures: health.permanentFailures ?? 0,
    oldestProcessingAgeSeconds: health.oldestProcessingAgeSeconds ?? null,
    oldestPendingAgeSeconds: health.oldestPendingAgeSeconds ?? null,
    sitemapUrlsDiscovered: run.sitemapUrlsDiscovered || 0,
    sitemapUrlsQueued: run.sitemapUrlsQueued || 0,
    sitemapFilesProcessed: run.sitemapFilesProcessed || 0,
    currentSitemapUrl: run.currentSitemapUrl || null,
    pagesPerMinute: ppm,
    reviewSummary,
    reviewProgress: `${reviewSummary.reviewed}/${reviewSummary.reviewableFindings}`,
    reviewNeedsFix: reviewSummary.needsFix,
    reviewFalsePositive: reviewSummary.falsePositive,
    reviewDone: reviewSummary.done,
    samplingSummary,
    samplesTotal: run.samplesTotal || samplingSummary.samplesTotal || 0,
    samplesProcessed: run.samplesProcessed || samplingSummary.samplesProcessed || 0,
    currentSampleUrl: run.currentSampleUrl || null,
    elapsedTime: elapsedSeconds(run.startedAt, run.finishedAt),
    estimatedRemainingTime: estimatedRemainingSeconds(run.discoveredUrls, run.processedUrls, ppm)
  };
}

function formatRunDetail(run) {
  const summary = formatRunSummary(run);
  return {
    ...summary,
    latestLogMessages: getLatestLogs(db, run.id, 20)
  };
}

function queueCount(runId, status) {
  return db.prepare('SELECT COUNT(*) AS count FROM crawl_queue WHERE runId = ? AND status = ?').get(runId, status).count;
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function removeGeneratedFiles(runId) {
  const reportPath = path.join(process.cwd(), 'reports', `run-${runId}.html`);
  if (fs.existsSync(reportPath)) fs.rmSync(reportPath, { force: true });
  const screenshotDir = path.join(process.cwd(), 'reports', 'screenshots', `run-${runId}`);
  if (fs.existsSync(screenshotDir)) fs.rmSync(screenshotDir, { recursive: true, force: true });
  const validationDir = path.join(process.cwd(), 'reports', `validation-run-${runId}`);
  if (fs.existsSync(validationDir)) fs.rmSync(validationDir, { recursive: true, force: true });
  for (const type of listCsvExports()) {
    const spec = getCsvExportSpec(type, runId);
    const csvPath = path.join(process.cwd(), 'reports', spec.filename);
    if (fs.existsSync(csvPath)) fs.rmSync(csvPath, { force: true });
  }
}
