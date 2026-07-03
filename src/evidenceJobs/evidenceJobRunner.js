import { getRunWithProject } from '../db/repositories.js';
import { getEvidenceJobType, estimateEvidenceJobStorage } from './evidenceJobTypes.js';
import { getLatestValidationReport } from '../validation/referenceAudit/validationService.js';
import { buildUnresolvedAuditQueue } from '../validation/unresolved/unresolvedAuditPointService.js';
import {
  completeEvidenceJob,
  countTargetedEvidenceFacts,
  createEvidenceJob,
  failEvidenceJob,
  getEvidenceJob,
  insertTargetedEvidenceFact,
  latestValidationIdForRun,
  listEvidenceJobs,
  listTargetedEvidenceFacts,
  resolveEvidenceJobUrls,
  serializeEvidenceJobFactCsv,
  startEvidenceJob,
  updateEvidenceJob
} from './evidenceJobRepository.js';
import { factStorageEstimate, extractTargetedFacts, isSupportedTargetedJobType } from './targetedFactExtractors.js';
import { fetchTargetedHtml, normalizeTargetedCrawlerConfig, runWithConcurrency, TARGETED_CRAWLER_DEFAULTS } from './targetedCrawler.js';
import { normalizeUrl } from '../utils/url.js';

export const TARGETED_EVIDENCE_LIMITS = Object.freeze({
  defaultMaxUrls: 100,
  uiDefaultMaxUrls: 20,
  absoluteMaxUrls: 10000,
  warningMaxUrls: 500,
  defaultTimeoutMs: TARGETED_CRAWLER_DEFAULTS.timeoutMs,
  defaultConcurrency: TARGETED_CRAWLER_DEFAULTS.concurrency,
  maxConcurrency: TARGETED_CRAWLER_DEFAULTS.maxConcurrency,
  defaultMaxResponseBytes: TARGETED_CRAWLER_DEFAULTS.maxResponseBytes
});

export async function dryRunEvidenceJob(db, runId, input = {}) {
  const context = buildEvidenceJobContext(db, runId, input);
  return dryRunPayload(context);
}

export async function createAndRunEvidenceJob(db, runId, input = {}) {
  const execution = createEvidenceJobExecution(db, runId, input);
  await execution.run();
  return getEvidenceJobDetails(db, execution.job.jobId);
}

export function createEvidenceJobExecution(db, runId, input = {}) {
  const context = buildEvidenceJobContext(db, runId, input);
  const dryRun = dryRunPayload(context);
  if (!dryRun.canRun) {
    const error = new Error(dryRun.warnings[0] || 'Evidence job cannot run');
    error.statusCode = 400;
    throw error;
  }
  const job = createEvidenceJob(db, {
    runId: context.run.id,
    validationId: context.validationId,
    jobType: context.definition.jobType,
    label: context.definition.label,
    urlSource: context.urlSource,
    urlCountPlanned: context.effectiveUrls.length,
    maxUrls: context.maxUrls,
    dryRun: false,
    storageProfile: context.definition.storageProfile || 'targeted_minimal',
    factsToExtract: context.definition.factsToExtract,
    storesRawHtml: false,
    storesRenderedHtml: false,
    estimatedBytesPerUrl: context.definition.estimatedBytesPerUrl,
    estimatedTotalBytes: context.estimatedTotalBytes,
    closesGapTypes: context.closesGapTypes,
    relatedManualItemIds: context.relatedManualItemIds,
    relatedCheckIds: context.relatedCheckIds,
    summary: {
      beforeCoverage: context.beforeCoverage,
      afterCoverage: context.beforeCoverage,
      coverageRecalculated: false,
      potentiallyAffectedManualItems: context.relatedManualItems
    },
    warnings: context.warnings,
    errors: [],
    config: {
      urlSource: context.urlSource,
      maxUrls: context.maxUrls,
      timeoutMs: context.crawlerConfig.timeoutMs,
      concurrency: context.crawlerConfig.concurrency,
      maxResponseBytes: context.crawlerConfig.maxResponseBytes,
      storageProfile: 'targeted_minimal',
      noRawHtmlStorage: true,
      noRenderedHtmlStorage: true
    }
  });

  return {
    job,
    dryRun,
    run: () => runEvidenceJob(db, job.jobId, context.effectiveUrls, context)
  };
}

export async function runEvidenceJob(db, jobId, urls = null, context = null) {
  const job = getEvidenceJob(db, jobId);
  if (!job) throw new Error(`Evidence job not found: ${jobId}`);
  if (!context) context = buildEvidenceJobContext(db, job.runId, { jobType: job.jobType, urlSource: job.urlSource, maxUrls: job.maxUrls, ...job.config });
  const effectiveUrls = urls || context.effectiveUrls;
  const counters = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    storedBytesEstimate: 0,
    errors: []
  };
  startEvidenceJob(db, jobId);

  try {
    await runWithConcurrency(effectiveUrls, async (url) => {
      const result = await processEvidenceUrl(db, job, url, context);
      counters.processed += 1;
      if (result.ok) counters.succeeded += 1;
      else counters.failed += 1;
      counters.storedBytesEstimate += result.storedBytesEstimate || 0;
      if (result.error) counters.errors.push(result.error);
      updateEvidenceJob(db, jobId, {
        urlCountProcessed: counters.processed,
        urlCountSucceeded: counters.succeeded,
        urlCountFailed: counters.failed,
        actualStoredBytesEstimate: counters.storedBytesEstimate,
        errors: counters.errors.slice(0, 50)
      });
    }, context.crawlerConfig);

    const summary = {
      beforeCoverage: context.beforeCoverage,
      afterCoverage: context.beforeCoverage,
      coverageRecalculated: false,
      changedManualItems: [],
      upgradedItems: [],
      stillMissingReasons: context.relatedManualItems.map((item) => ({
        manualItemId: item.manualItemId,
        title: item.manualTitle,
        reason: 'Facts collected; rerun validation/check calibration is required before changing coverage.'
      })),
      potentiallyAffectedManualItems: context.relatedManualItems,
      factRowsStored: countTargetedEvidenceFacts(db, jobId).count || 0,
      rawHtmlStored: false,
      renderedHtmlStored: false,
      note: 'Batch 10.8 collects targeted facts only. It does not automatically inflate validation coverage.'
    };

    return completeEvidenceJob(db, jobId, {
      urlCountProcessed: counters.processed,
      urlCountSucceeded: counters.succeeded,
      urlCountFailed: counters.failed,
      actualStoredBytesEstimate: counters.storedBytesEstimate,
      summary,
      warnings: context.warnings,
      errors: counters.errors.slice(0, 50)
    });
  } catch (error) {
    return failEvidenceJob(db, jobId, error, {
      urlCountProcessed: counters.processed,
      urlCountSucceeded: counters.succeeded,
      urlCountFailed: counters.failed,
      actualStoredBytesEstimate: counters.storedBytesEstimate
    });
  }
}

export function getEvidenceJobDetails(db, jobId, options = {}) {
  const job = getEvidenceJob(db, jobId);
  if (!job) return null;
  const facts = listTargetedEvidenceFacts(db, jobId, { limit: options.limit || 1000 });
  const counts = countTargetedEvidenceFacts(db, jobId);
  return {
    ...job,
    factCount: counts.count || 0,
    factsStoredBytesEstimate: counts.storedBytesEstimate || 0,
    facts,
    factsCsv: options.includeCsv ? serializeEvidenceJobFactCsv(facts) : undefined
  };
}

export function listEvidenceJobsForRun(db, runId) {
  return {
    runId,
    jobs: listEvidenceJobs(db, runId).map((job) => ({
      ...job,
      facts: undefined
    }))
  };
}

export function buildEvidenceJobImpactSummary(db, runId) {
  const jobs = listEvidenceJobs(db, runId);
  return {
    runId,
    generatedAt: new Date().toISOString(),
    jobCount: jobs.length,
    completedJobs: jobs.filter((job) => job.status === 'completed').length,
    runningJobs: jobs.filter((job) => job.status === 'running').length,
    failedJobs: jobs.filter((job) => job.status === 'failed').length,
    rawHtmlStored: false,
    renderedHtmlStored: false,
    jobs: jobs.map((job) => ({
      jobId: job.jobId,
      jobType: job.jobType,
      status: job.status,
      urlSource: job.urlSource,
      processed: job.urlCountProcessed,
      succeeded: job.urlCountSucceeded,
      failed: job.urlCountFailed,
      actualStoredBytesEstimate: job.actualStoredBytesEstimate,
      potentiallyAffectedManualItems: job.summary?.potentiallyAffectedManualItems || [],
      coverageRecalculated: Boolean(job.summary?.coverageRecalculated)
    }))
  };
}

async function processEvidenceUrl(db, job, url, context) {
  try {
    const response = await fetchTargetedHtml(url, context.crawlerConfig);
    const normalizedFinalUrl = normalizeUrl(response.url) || url;
    const contentType = response.contentType || '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    const facts = isHtml
      ? extractTargetedFacts(job.jobType, response.body, {
          url,
          finalUrl: normalizedFinalUrl,
          statusCode: response.statusCode,
          contentType,
          headers: response.headers
        })
      : nonHtmlFacts({ url, finalUrl: normalizedFinalUrl, statusCode: response.statusCode, contentType });
    const error = response.statusCode >= 400 ? `HTTP ${response.statusCode}` : isHtml ? null : 'Non-HTML response';
    const storedBytesEstimate = factStorageEstimate(facts);
    insertTargetedEvidenceFact(db, {
      jobId: job.jobId,
      runId: job.runId,
      jobType: job.jobType,
      url,
      normalizedUrl: normalizeUrl(url) || url,
      finalUrl: normalizedFinalUrl,
      statusCode: response.statusCode,
      contentType,
      indexability: facts.indexability,
      facts,
      error,
      storedBytesEstimate
    });
    return {
      ok: !error,
      error,
      storedBytesEstimate
    };
  } catch (error) {
    const normalized = normalizeUrl(url) || url;
    const facts = {
      url: normalized,
      finalUrl: null,
      statusCode: null,
      contentType: null,
      indexability: 'fetch_failed',
      error: errorMessage(error)
    };
    const storedBytesEstimate = factStorageEstimate(facts);
    insertTargetedEvidenceFact(db, {
      jobId: job.jobId,
      runId: job.runId,
      jobType: job.jobType,
      url,
      normalizedUrl: normalized,
      finalUrl: null,
      statusCode: null,
      contentType: null,
      indexability: 'fetch_failed',
      facts,
      error: errorMessage(error),
      storedBytesEstimate
    });
    return { ok: false, error: errorMessage(error), storedBytesEstimate };
  }
}

function buildEvidenceJobContext(db, runId, input = {}) {
  const run = getRunWithProject(db, Number(runId));
  if (!run) {
    const error = new Error('Run not found');
    error.statusCode = 404;
    throw error;
  }
  const definition = getEvidenceJobType(input.jobType);
  const warnings = [];
  if (!definition) {
    const error = new Error(`Unknown evidence job type: ${input.jobType}`);
    error.statusCode = 400;
    throw error;
  }
  if (!isSupportedTargetedJobType(definition.jobType)) {
    warnings.push(`${definition.jobType} is planned but not executable in Batch 10.8.`);
  }
  if (definition.storesRawHtml || definition.storesRenderedHtml) {
    warnings.push('Job type is not allowed because Batch 10.8 does not store raw or rendered HTML.');
  }

  const requestedMaxUrls = input.maxUrls === undefined ? TARGETED_EVIDENCE_LIMITS.defaultMaxUrls : Number(input.maxUrls);
  const maxUrls = Math.min(TARGETED_EVIDENCE_LIMITS.absoluteMaxUrls, Math.max(1, Number.isFinite(requestedMaxUrls) ? Math.round(requestedMaxUrls) : TARGETED_EVIDENCE_LIMITS.defaultMaxUrls));
  if (Number(input.maxUrls || 0) > TARGETED_EVIDENCE_LIMITS.absoluteMaxUrls) {
    warnings.push(`maxUrls capped at ${TARGETED_EVIDENCE_LIMITS.absoluteMaxUrls} for Batch 10.8 safety.`);
  }
  if (maxUrls > TARGETED_EVIDENCE_LIMITS.warningMaxUrls) {
    warnings.push(`Large targeted job (${maxUrls} URLs). Keep this below ${TARGETED_EVIDENCE_LIMITS.warningMaxUrls} unless the URL set is deliberate.`);
  }

  const resolved = resolveEvidenceJobUrls(db, run, input);
  warnings.push(...resolved.warnings);
  const effectiveUrls = resolved.urls.slice(0, maxUrls);
  if (!effectiveUrls.length) warnings.push('No URLs available for this evidence job.');
  const storageEstimate = estimateEvidenceJobStorage(definition, effectiveUrls.length);
  const validation = getLatestValidationReport(db, run.id);
  const queue = validation?.report ? buildUnresolvedAuditQueue(validation.report) : null;
  const relatedManualItems = relatedManualItemsForJob(queue, definition.jobType);
  const crawlerConfig = normalizeTargetedCrawlerConfig({
    timeoutMs: input.timeoutMs,
    concurrency: input.concurrency,
    maxResponseBytes: input.maxResponseBytes,
    userAgent: input.userAgent,
    respectRobots: input.respectRobots
  });
  if (crawlerConfig.respectRobots) warnings.push('Robots checks are not enforced by the Batch 10.8 runner yet; use existing audit crawl for robots-aware discovery.');

  return {
    run,
    validationId: latestValidationIdForRun(db, run.id),
    definition,
    urlSource: resolved.urlSource,
    plannedUrlCount: resolved.plannedUrlCount,
    effectiveUrls,
    maxUrls,
    storageEstimate,
    estimatedTotalBytes: storageEstimate?.estimatedBytes || 0,
    closesGapTypes: definition.closesGapTypes || [],
    relatedManualItems,
    relatedManualItemIds: relatedManualItems.map((item) => item.manualItemId),
    relatedCheckIds: definition.relatedCheckIds || [],
    beforeCoverage: validation?.report?.validationSummary?.coveragePercent ?? validation?.summary?.coveragePercent ?? null,
    warnings,
    crawlerConfig
  };
}

function dryRunPayload(context) {
  const canRun = isSupportedTargetedJobType(context.definition.jobType)
    && !context.definition.storesRawHtml
    && !context.definition.storesRenderedHtml
    && context.effectiveUrls.length > 0;
  return {
    dryRun: true,
    jobType: context.definition.jobType,
    label: context.definition.label,
    runId: context.run.id,
    validationId: context.validationId,
    urlSource: context.urlSource,
    plannedUrlCount: context.plannedUrlCount,
    effectiveUrlCount: context.effectiveUrls.length,
    maxUrls: context.maxUrls,
    storageProfile: context.definition.storageProfile || 'targeted_minimal',
    storesRawHtml: false,
    storesRenderedHtml: false,
    estimatedBytesPerUrl: context.definition.estimatedBytesPerUrl,
    estimatedTotalBytes: context.estimatedTotalBytes,
    estimatedTotalHuman: context.storageEstimate?.estimatedHuman,
    closesGapTypes: context.closesGapTypes,
    relatedManualItems: context.relatedManualItems,
    relatedCheckIds: context.relatedCheckIds,
    warnings: context.warnings,
    canRun,
    config: {
      timeoutMs: context.crawlerConfig.timeoutMs,
      concurrency: context.crawlerConfig.concurrency,
      maxResponseBytes: context.crawlerConfig.maxResponseBytes,
      userAgent: context.crawlerConfig.userAgent,
      respectRobots: context.crawlerConfig.respectRobots
    }
  };
}

function relatedManualItemsForJob(queue, jobType) {
  return (queue?.points || [])
    .filter((point) => (point.recommendedJobTypes || []).includes(jobType))
    .map((point) => ({
      manualItemId: point.manualItemId,
      manualTitle: point.manualTitle,
      priority: point.priority,
      currentCoverageStatus: point.currentCoverageStatus,
      primaryGapType: point.primaryGapType,
      missingReasons: point.missingReasons || []
    }))
    .slice(0, 100);
}

function nonHtmlFacts({ url, finalUrl, statusCode, contentType }) {
  return {
    url: normalizeUrl(url) || url,
    finalUrl,
    statusCode,
    contentType,
    indexability: 'non_html'
  };
}

function errorMessage(error) {
  if (error?.name === 'AbortError') return 'Request timeout';
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
