import { detectDomain } from './domainDetector.js';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { discoverDomainAssets, fetchTextAsset } from './sitemap.js';
import { processQueueItem } from './pageProcessor.js';
import { runChecks } from '../checks/checkEngine.js';
import { getDb } from '../db/database.js';
import {
  acquireRunLock,
  createProject,
  createRun,
  getRunWithProject,
  heartbeatRun,
  logRun,
  recoverRun,
  releaseRunLock,
  syncRunCounters,
  updateProject,
  updateRun
} from '../db/repositories.js';
import {
  completeUrl,
  appendHttpAttempt,
  failUrlPermanent,
  claimNextUrlForLock,
  nextWaitingDelayMs,
  pendingCount,
  processedCount,
  resetProcessingForRun,
  scheduleRetry,
  skipRemainingPending,
  skipUrl,
  waitingCount
} from '../queue/sqliteQueue.js';
import { launchBrowser } from '../extractors/renderExtractor.js';
import { parseRobots } from '../utils/robots.js';
import { generateReport } from '../reports/reportGenerator.js';
import { nowIso } from '../utils/time.js';
import { enqueueUrlWithPolicy } from './crawlPolicy.js';
import { normalizeCrawlMode, normalizePlaywrightMode, parsePatternList } from './crawlConfig.js';
import { crawlerDefaults } from './defaults.js';
import { classifyError, nextRetryAt, shouldRetryError } from './retryPolicy.js';
import { HostRateLimiter } from './hostRateLimiter.js';
import { buildTemplateClusters } from '../analysis/templateClusterer.js';
import { runTemplateSampling } from '../sampling/templateSamplingRunner.js';
import { normalizeEnterpriseConfig } from '../storage/storageProfiles.js';
import { storeBenchmarkSummary } from '../analysis/benchmarkSummary.js';
import { normalizeSettlingConfig } from '../extractors/documentState.js';
import { normalizeMetricsMode, normalizeOptionalBudget, normalizeRenderPlanningVersion, RUNTIME_METRICS_VERSION } from '../rendering/renderPlanner.js';
import { createRuntimeMetricsTracker } from '../runtime/renderMetrics.js';
import { runDeterministicRenderPlan } from '../rendering/renderPlanRunner.js';

const activeRuns = new Map();

export function normalizeAuditConfig(input) {
  const fullAuditMode = input.auditMode === 'full' || input.mode === 'full';
  const usePlaywright = input.usePlaywright === true || input.usePlaywright === 'true' || (fullAuditMode && input.usePlaywright !== false && input.usePlaywright !== 'false');
  const lighthouseDevice = input.lighthouseDevice === 'desktop' ? 'desktop' : 'mobile';
  const settling = normalizeSettlingConfig({
    maxDurationMs: input.renderSettlingMaxMs,
    intervalMs: input.renderSettlingIntervalMs,
    maxSnapshots: input.renderSettlingMaxSnapshots,
    stableSnapshots: input.renderSettlingStableSnapshots,
    minimumObservationMs: input.renderSettlingMinimumObservationMs
  });
  const base = {
    domain: String(input.domain || '').trim(),
    brandName: input.brandName ? String(input.brandName).trim() : null,
    auditType: ['tech', 'geo', 'both'].includes(input.auditType || input.type) ? (input.auditType || input.type) : 'both',
    maxUrls: Math.max(1, Number(input.maxUrls || crawlerDefaults.maxUrls)),
    maxDepth: Math.max(0, Number(input.maxDepth ?? 4)),
    concurrency: Math.max(1, Math.min(50, Number(input.concurrency || crawlerDefaults.concurrency))),
    userAgent: normalizeHeaderValue(input.userAgent, crawlerDefaults.userAgent),
    robotsUserAgent: normalizeHeaderValue(input.robotsUserAgent, crawlerDefaults.robotsUserAgent),
    targetPagesPerSecond: Math.max(0, Number(input.targetPagesPerSecond || crawlerDefaults.targetPagesPerSecond)),
    respectRobotsTxt: input.respectRobotsTxt === false || input.respectRobotsTxt === 'false' ? false : true,
    crawlMode: normalizeCrawlMode(input.crawlMode || 'hybrid'),
    includePatterns: parsePatternList(input.includePatterns),
    excludePatterns: parsePatternList(input.excludePatterns),
    crawlDelayMs: Math.max(0, Number(input.crawlDelayMs ?? crawlerDefaults.crawlDelayMs)),
    requestTimeoutMs: Math.max(1000, Number(input.requestTimeoutMs || crawlerDefaults.requestTimeoutMs)),
    usePlaywright,
    playwrightMode: normalizePlaywrightMode(input.playwrightMode || (usePlaywright ? 'all' : 'off'), usePlaywright),
    playwrightSampleLimit: Math.max(0, Number(input.playwrightSampleLimit || 50)),
    metricsMode: normalizeMetricsMode(input.metricsMode),
    renderPlanningVersion: normalizeRenderPlanningVersion(input.renderPlanningVersion),
    runtimeMetricsVersion: RUNTIME_METRICS_VERSION,
    maxRenderedUrls: normalizeOptionalBudget(input.maxRenderedUrls),
    maxTotalRenderTimeMs: normalizeOptionalBudget(input.maxTotalRenderTimeMs),
    maxSettlingTimeMsPerUrl: normalizeOptionalBudget(input.maxSettlingTimeMsPerUrl ?? settling.maxDurationMs, { minimum: 250 }),
    maxBrowserFailures: normalizeOptionalBudget(input.maxBrowserFailures),
    maxPersistedRenderBytes: normalizeOptionalBudget(input.maxPersistedRenderBytes),
    maxAttempts: Math.max(1, Number(input.maxAttempts || crawlerDefaults.maxAttempts)),
    maxConcurrentPerHost: Math.max(1, Number(input.maxConcurrentPerHost || crawlerDefaults.maxConcurrentPerHost)),
    retryBaseDelayMs: Math.max(0, Number(input.retryBaseDelayMs || crawlerDefaults.retryBaseDelayMs)),
    retryMaxDelayMs: Math.max(0, Number(input.retryMaxDelayMs || crawlerDefaults.retryMaxDelayMs)),
    maxSitemapUrls: input.maxSitemapUrls === null || input.maxSitemapUrls === undefined || input.maxSitemapUrls === ''
      ? crawlerDefaults.maxSitemapUrls
      : Math.max(0, Number(input.maxSitemapUrls)),
    maxSitemaps: Math.max(1, Number(input.maxSitemaps || crawlerDefaults.maxSitemaps)),
    sitemapBatchSize: Math.max(1, Number(input.sitemapBatchSize || crawlerDefaults.sitemapBatchSize)),
    enableTemplateSampling: input.enableTemplateSampling === false || input.enableTemplateSampling === 'false' ? false : (fullAuditMode || crawlerDefaults.enableTemplateSampling),
    enablePlaywrightSampling: input.enablePlaywrightSampling === true || input.enablePlaywrightSampling === 'true' || (fullAuditMode && input.enablePlaywrightSampling !== false && input.enablePlaywrightSampling !== 'false'),
    enableLighthouseSampling: input.enableLighthouseSampling === true || input.enableLighthouseSampling === 'true' || (fullAuditMode && input.enableLighthouseSampling !== false && input.enableLighthouseSampling !== 'false'),
    sampleUrlsPerTemplate: Math.max(1, Number(input.sampleUrlsPerTemplate || crawlerDefaults.sampleUrlsPerTemplate)),
    maxTemplateSamplesTotal: Math.max(1, Number(input.maxTemplateSamplesTotal || crawlerDefaults.maxTemplateSamplesTotal)),
    lighthouseDevice,
    lighthouseCategories: normalizeLighthouseCategories(input.lighthouseCategories),
    lighthouseTimeoutMs: Math.max(1000, Number(input.lighthouseTimeoutMs || crawlerDefaults.lighthouseTimeoutMs)),
    playwrightTimeoutMs: Math.max(1000, Number(input.playwrightTimeoutMs || crawlerDefaults.playwrightTimeoutMs)),
    renderSettlingMaxMs: settling.maxDurationMs,
    renderSettlingIntervalMs: settling.intervalMs,
    renderSettlingMaxSnapshots: settling.maxSnapshots,
    renderSettlingStableSnapshots: settling.stableSnapshots,
    renderSettlingMinimumObservationMs: settling.minimumObservationMs,
    // Browser concurrency stays at one until profiling demonstrates a safe higher value.
    maxConcurrentRenderedPages: 1,
    collectScreenshots: input.collectScreenshots === true || input.collectScreenshots === 'true',
    sampleOnlyIndexable: input.sampleOnlyIndexable === false || input.sampleOnlyIndexable === 'false' ? false : crawlerDefaults.sampleOnlyIndexable,
    sourceType: normalizeSourceType(input.sourceType),
    enableLlmChecks: input.enableLlmChecks === true || input.enableLlmChecks === 'true',
    llmProvider: normalizeLlmProvider(input.llmProvider),
    llmModel: normalizeOptionalText(input.llmModel),
    llmMaxSampleUrls: Math.max(1, Math.min(100, Number(input.llmMaxSampleUrls || 5))),
    llmMaxChecks: Math.max(1, Math.min(20, Number(input.llmMaxChecks || 2))),
    llmMaxTokens: Math.max(1000, Math.min(200000, Number(input.llmMaxTokens || 8000))),
    llmDryRun: input.llmDryRun === false || input.llmDryRun === 'false' ? false : true
  };
  const enterprise = normalizeEnterpriseConfig({ ...input, ...base });
  return {
    ...base,
    ...enterprise,
    llmWarnings: llmWarningsFor(base)
  };
}

export async function startAudit(configInput, options = {}) {
  const db = getDb();
  const config = {
    ...normalizeAuditConfig(configInput),
    scheduledRunId: options.scheduledRunId || configInput.scheduledRunId || null,
    triggerType: options.triggerType || configInput.triggerType || 'manual',
    baselineRunId: options.baselineRunId || configInput.baselineRunId || null
  };
  if (!config.domain) throw new Error('domain is required');

  const projectId = createProject(db, {
    inputDomain: config.domain,
    brandName: config.brandName
  });
  const runId = createRun(db, projectId, config);
  logRun(db, runId, 'info', 'Audit run created', config);

  const promise = scheduleRun(runId);
  if (options.wait) {
    await promise;
  }

  return { runId, projectId, promise };
}

export function scheduleRun(runId) {
  if (activeRuns.has(Number(runId))) {
    return activeRuns.get(Number(runId)).promise;
  }

  const promise = executeAudit(Number(runId))
    .catch((error) => {
      const db = getDb();
      logRun(db, Number(runId), 'error', 'Audit run failed', { error: error.message });
      updateRun(db, Number(runId), {
        status: 'failed',
        currentPhase: 'failed',
        currentUrl: null,
        errorMessage: error.message,
        finishedAt: nowIso()
      });
    })
    .finally(() => {
      activeRuns.delete(Number(runId));
    });

  activeRuns.set(Number(runId), { promise });
  return promise;
}

export function pauseAudit(runId) {
  const db = getDb();
  const run = getRunWithProject(db, Number(runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!['running', 'pending'].includes(run.status)) return run;
  syncRunCounters(db, Number(runId));
  updateRun(db, Number(runId), { status: 'paused', currentUrl: null });
  logRun(db, Number(runId), 'info', 'Pause requested');
  return getRunWithProject(db, Number(runId));
}

export function resumeAudit(runId) {
  const db = getDb();
  const run = getRunWithProject(db, Number(runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!['paused', 'failed'].includes(run.status)) return run;
  resetProcessingForRun(db, Number(runId));
  recoverRun(db, Number(runId), { processingTimeoutMs: crawlerDefaults.processingTimeoutMs });
  syncRunCounters(db, Number(runId));
  updateRun(db, Number(runId), {
    status: 'running',
    currentPhase: run.finalDomain ? 'crawling' : 'init',
    currentUrl: null,
    finishedAt: null,
    errorMessage: null
  });
  logRun(db, Number(runId), 'info', 'Resume requested');
  scheduleRun(Number(runId));
  return getRunWithProject(db, Number(runId));
}

export function cancelAudit(runId) {
  const db = getDb();
  const run = getRunWithProject(db, Number(runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  syncRunCounters(db, Number(runId));
  updateRun(db, Number(runId), {
    status: 'cancelled',
    currentUrl: null,
    finishedAt: nowIso()
  });
  logRun(db, Number(runId), 'warning', 'Cancel requested');
  return getRunWithProject(db, Number(runId));
}

export function recoverAudit(runId) {
  const db = getDb();
  const run = getRunWithProject(db, Number(runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  const result = recoverRun(db, Number(runId), { processingTimeoutMs: crawlerDefaults.processingTimeoutMs });
  syncRunCounters(db, Number(runId));
  logRun(db, Number(runId), 'warning', 'Recovery executed', result);
  return getRunWithProject(db, Number(runId));
}

export function isRunActive(runId) {
  return activeRuns.has(Number(runId));
}

async function executeAudit(runId) {
  const db = getDb();
  const lockToken = crypto.randomUUID();
  resetProcessingForRun(db, runId);
  syncRunCounters(db, runId);

  let run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const lock = acquireRunLock(db, runId, lockToken, { staleHeartbeatMs: crawlerDefaults.staleHeartbeatMs });
  if (!lock.acquired) {
    logRun(db, runId, 'warning', 'Run lock not acquired', { reason: lock.reason });
    return;
  }
  logRun(db, runId, 'info', 'Run lock acquired', { lockToken });

  const heartbeatTimer = setInterval(() => {
    heartbeatRun(db, runId, lockToken);
  }, crawlerDefaults.heartbeatIntervalMs);
  heartbeatRun(db, runId, lockToken, 0);
  let runtimeMetrics = null;
  let metricsFinished = false;

  try {
    updateRun(db, runId, {
    status: 'running',
    startedAt: run.startedAt || nowIso(),
    currentPhase: run.finalDomain ? 'crawling' : 'init',
    currentUrl: null,
    finishedAt: null
    });

    run = getRunWithProject(db, runId);
    runtimeMetrics = createRuntimeMetricsTracker(db, run);
    let robots = null;

    if (!run.finalDomain) {
      await initializeRun(db, run);
    } else {
      logRun(db, runId, 'info', 'Continuing existing run', { finalDomain: run.finalDomain });
    }

    run = getRunWithProject(db, runId);
    robots = loadRobotsParser(db, run);

    updateRun(db, runId, { currentPhase: 'crawling' });
    const shouldUsePlaywrightDuringCrawl = Boolean(run.usePlaywright) && ['all', 'sample'].includes(run.playwrightMode);
    if (shouldUsePlaywrightDuringCrawl) runtimeMetrics.startPhase('browser_launch');
    const browser = shouldUsePlaywrightDuringCrawl
      ? await launchBrowser((level, message, data) => logRun(db, runId, level, message, data))
      : null;
    if (shouldUsePlaywrightDuringCrawl) {
      runtimeMetrics.endPhase('browser_launch');
      runtimeMetrics.recordBrowserLaunch({ success: Boolean(browser) });
    }
    const hostLimiter = new HostRateLimiter({
      maxConcurrentPerHost: run.maxConcurrentPerHost || crawlerDefaults.maxConcurrentPerHost,
      crawlDelayMs: run.crawlDelayMs || crawlerDefaults.crawlDelayMs,
      targetPagesPerSecond: run.targetPagesPerSecond || crawlerDefaults.targetPagesPerSecond,
      onCooldown: (data) => logRun(db, runId, 'warning', 'Host cooldown', data)
    });

    try {
      const workers = Array.from({ length: run.concurrency }, (_, index) => workerLoop(db, runId, index + 1, lockToken, browser, robots, hostLimiter, runtimeMetrics));
      heartbeatRun(db, runId, lockToken, workers.length);
      await Promise.all(workers);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    syncRunCounters(db, runId);
    run = getRunWithProject(db, runId);
    if (run.status === 'paused' || run.status === 'cancelled') {
      updateRun(db, runId, { currentUrl: null, workerCount: 0 });
      logRun(db, runId, 'info', `Run ${run.status}`);
      return;
    }

    if (processedCount(db, runId) >= run.maxUrls && pendingCount(db, runId) > 0) {
      skipRemainingPending(db, runId, 'Skipped because maxUrls limit was reached');
      syncRunCounters(db, runId);
    }

    updateRun(db, runId, { currentPhase: 'clustering' });
    const clusterSummary = buildTemplateClusters(db, runId, {
      sampleUrlsPerTemplate: run.sampleUrlsPerTemplate || crawlerDefaults.sampleUrlsPerTemplate,
      maxTemplateSamplesTotal: run.maxTemplateSamplesTotal || crawlerDefaults.maxTemplateSamplesTotal
    });
    logRun(db, runId, 'info', 'Template clusters built', clusterSummary);

    if (run.usePlaywright && run.playwrightMode === 'gate') {
      updateRun(db, runId, { currentPhase: 'render_planning' });
      const renderPlanSummary = await runDeterministicRenderPlan(db, run, runtimeMetrics);
      logRun(db, runId, 'info', 'Deterministic render plan completed', {
        plannedRenderedUrls: renderPlanSummary.plannedRenderedUrls || 0,
        renderedUrls: renderPlanSummary.renderedUrls || 0,
        budgetExcludedUrls: renderPlanSummary.budgetExcludedUrls || 0,
        unavailableUrls: renderPlanSummary.unavailableUrls || 0
      });
    }

    await runTemplateSampling(db, runId, runtimeMetrics);

    updateRun(db, runId, { currentPhase: 'checking', currentUrl: null, currentSampleUrl: null, workerCount: 0 });
    runtimeMetrics.startPhase('checks');
    await runChecks(db, runId);
    runtimeMetrics.endPhase('checks');

    syncRunCounters(db, runId);
    updateRun(db, runId, {
      status: 'completed',
      currentPhase: 'completed',
      currentUrl: null,
      currentSampleUrl: null,
      workerCount: 0,
      finishedAt: nowIso()
    });
    storeBenchmarkSummary(db, runId);
    runtimeMetrics.startPhase('report');
    let reportPath = generateReport(db, runId);
    runtimeMetrics.endPhase('report');
    runtimeMetrics.finish({ status: 'completed' });
    metricsFinished = true;
    // Regenerate once so the report includes final runtime totals. This second write is
    // intentionally outside the measured report phase and is documented as such.
    reportPath = generateReport(db, runId);
    logRun(db, runId, 'info', 'Report generated', { reportPath });
    logRun(db, runId, 'info', 'Run completed');
  } finally {
    if (runtimeMetrics && !metricsFinished) {
      const current = getRunWithProject(db, runId);
      runtimeMetrics.finish({ status: current?.status || 'aborted' });
    }
    clearInterval(heartbeatTimer);
    releaseRunLock(db, runId, lockToken);
    logRun(db, runId, 'info', 'Run lock released', { lockToken });
  }
}

async function initializeRun(db, run) {
  const runId = run.id;
  updateRun(db, runId, { currentPhase: 'domain_detection' });
  logRun(db, runId, 'info', 'Detecting canonical domain variants');
  const detection = await detectDomain(run.inputDomain, { userAgent: run.userAgent });

  updateProject(db, run.projectId, {
    finalDomain: detection.finalDomain,
    protocolBehaviorJson: JSON.stringify(detection.protocolBehavior),
    wwwBehaviorJson: JSON.stringify(detection.wwwBehavior),
    redirectChainJson: JSON.stringify(detection.redirectChain)
  });

  logRun(db, runId, 'info', 'Domain detected', {
    finalDomain: detection.finalDomain,
    finalStartUrl: detection.finalStartUrl
  });

  const runWithDomain = getRunWithProject(db, runId);
  if (runWithDomain.crawlMode !== 'sitemap_only') {
    enqueueUrlWithPolicy(db, runWithDomain, {
      url: detection.finalStartUrl,
      depth: 0,
      sourceUrl: null,
      sourceType: 'seed',
      priority: 100
    });
  } else {
    logRun(db, runId, 'info', 'Seed URL not queued because crawlMode=sitemap_only', { url: detection.finalStartUrl });
  }
  syncRunCounters(db, runId);

  const updatedRun = getRunWithProject(db, runId);
  updateRun(db, runId, { currentPhase: 'robots' });
  const robotsUrl = `${detection.finalDomain}/robots.txt`;
  const robotsResponse = await fetchTextAsset(db, runId, 'robots', robotsUrl, updatedRun.requestTimeoutMs, { userAgent: updatedRun.userAgent });
  const robotsContent = robotsResponse?.body || '';
  logRun(db, runId, 'info', 'robots.txt fetched', {
    url: robotsUrl,
    statusCode: robotsResponse?.statusCode ?? null
  });

  updateRun(db, runId, { currentPhase: 'sitemap' });
  await discoverDomainAssets(db, updatedRun, detection.finalStartUrl, robotsContent);
  syncRunCounters(db, runId);
}

function normalizeHeaderValue(value, fallback) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return text ? text.slice(0, 240) : fallback;
}

function normalizeOptionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeSourceType(value) {
  return ['crawl', 'screaming_frog_import', 'hybrid'].includes(value) ? value : 'crawl';
}

function normalizeLlmProvider(value) {
  const text = String(value || 'none').trim().toLowerCase();
  return ['none', 'openai', 'anthropic', 'mock'].includes(text) ? text : 'none';
}

function llmWarningsFor(config) {
  const warnings = [];
  if (!config.enableLlmChecks) return warnings;
  if (config.llmProvider === 'none') warnings.push('LLM checks enabled, but provider is none.');
  if (config.llmProvider === 'openai' && !process.env.OPENAI_API_KEY) warnings.push('OPENAI_API_KEY is not configured.');
  if (config.llmProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) warnings.push('ANTHROPIC_API_KEY is not configured.');
  if (!config.llmDryRun) warnings.push('LLM checks may send page facts/content excerpts to an external provider.');
  return warnings;
}

async function workerLoop(db, runId, workerId, lockToken, browser, robots, hostLimiter, runtimeMetrics = null) {
  logRun(db, runId, 'info', 'Worker started', { workerId });
  while (true) {
    const run = getRunWithProject(db, runId);
    if (!run || run.lockToken !== lockToken || run.status === 'paused' || run.status === 'cancelled') {
      logRun(db, runId, 'info', 'Worker stopped', { workerId, reason: run?.status || 'lock_lost' });
      return;
    }

    if (processedCount(db, runId) >= run.maxUrls) {
      logRun(db, runId, 'info', 'maxUrls reached', { maxUrls: run.maxUrls, workerId });
      return;
    }

    const item = claimNextUrlForLock(db, runId, lockToken);
    if (!item) {
      if (waitingCount(db, runId) > 0) {
        await sleep(Math.min(1000, nextWaitingDelayMs(db, runId) ?? 1000));
        continue;
      }
      logRun(db, runId, 'info', 'Queue exhausted', { workerId });
      return;
    }

    const releaseHost = await hostLimiter.acquire(item.normalizedUrl);

    updateRun(db, runId, { currentPhase: 'extracting', currentUrl: item.normalizedUrl });

    const urlStartedAt = performance.now();
    try {
      const outcome = await processQueueItem(db, run, run, item, browser, robots, runtimeMetrics);
      if (outcome.httpAttempt) appendHttpAttempt(db, item.id, outcome.httpAttempt);
      if (outcome.status === 'skipped') {
        skipUrl(db, item.id, outcome.reason);
      } else {
        completeUrl(db, item.id);
      }
      syncRunCounters(db, runId);
      updateRun(db, runId, { currentPhase: 'crawling', currentUrl: null });
    } catch (error) {
      const classification = classifyError(error);
      if (error.httpAttempt || classification.retryable) {
        appendHttpAttempt(db, item.id, error.httpAttempt || {
          attempt: item.attempts,
          method: 'GET',
          requestedUrl: item.url || item.normalizedUrl,
          technicalErrorType: classification.errorType,
          technicalError: error.message
        });
      }
      runtimeMetrics?.recordUrl({
        url: item.url || item.normalizedUrl,
        pageType: 'other',
        renderStrategy: !run.usePlaywright || run.playwrightMode === 'off' ? 'raw_only' : run.playwrightMode === 'gate' ? 'deterministic_gate' : run.playwrightMode === 'all' ? 'browser_all' : 'browser_sample',
        totalUrlDurationMs: performance.now() - urlStartedAt,
        renderStatus: 'technical_error',
        measurementError: error.message
      });
      if (shouldRetryError(item, run, error)) {
        const nextAttemptAt = nextRetryAt(item, run);
        scheduleRetry(db, item.id, {
          errorMessage: error.message,
          nextAttemptAt,
          statusCode: classification.statusCode,
          errorType: classification.errorType,
          failedReason: classification.failedReason
        });
        if ([429, 503].includes(Number(classification.statusCode))) {
          hostLimiter.cooldown(item.normalizedUrl, run.retryBaseDelayMs || crawlerDefaults.retryBaseDelayMs, classification.failedReason);
        }
        logRun(db, runId, 'warning', 'URL retry scheduled', {
          url: item.normalizedUrl,
          workerId,
          attempts: item.attempts,
          nextAttemptAt,
          error: error.message
        });
      } else {
        failUrlPermanent(db, item.id, {
          errorMessage: error.message,
          statusCode: classification.statusCode,
          errorType: classification.errorType,
          failedReason: classification.failedReason
        });
        logRun(db, runId, 'error', 'URL permanently failed', {
          url: item.normalizedUrl,
          workerId,
          attempts: item.attempts,
          error: error.message
        });
      }
      syncRunCounters(db, runId);
      updateRun(db, runId, { currentPhase: 'crawling', currentUrl: null });
    } finally {
      releaseHost();
    }
  }
}

function loadRobotsParser(db, run) {
  if (!run.respectRobotsTxt) return null;
  const asset = db.prepare(`
    SELECT *
    FROM domain_assets
    WHERE runId = ? AND type = 'robots'
    ORDER BY id DESC
    LIMIT 1
  `).get(run.id);

  if (!asset?.content || !asset.url || !asset.statusCode || asset.statusCode >= 400) return null;
  return parseRobots(asset.url, asset.content);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLighthouseCategories(value) {
  const allowed = new Set(['performance', 'accessibility', 'best-practices', 'seo']);
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const categories = raw.map((item) => String(item).trim()).filter((item) => allowed.has(item));
  return categories.length ? [...new Set(categories)] : crawlerDefaults.lighthouseCategories;
}
