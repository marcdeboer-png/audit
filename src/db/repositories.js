import {
  CHECK_LOGIC_VERSION,
  COVERAGE_MODEL_VERSION,
  DEDUPLICATION_VERSION,
  SCORING_VERSION,
  scoreForStatus
} from '../utils/scoring.js';
import { AVAILABILITY_SEMANTICS_VERSION } from '../coverage/evidenceCoverage.js';
import { crawlerDefaults } from '../crawler/defaults.js';
import {
  normalizeAutomationCoverage,
  normalizeConfidence,
  dedupeUrlSamples,
  normalizeEvidenceLevel,
  normalizeFindingType,
  normalizePriority,
  normalizeStatus
} from '../checks/helpers.js';
import { applyEffectiveValues, normalizeReviewPayload } from '../reviews/reviewWorkflow.js';
import { buildDisplaySummary } from '../reviews/displaySemantics.js';
import { computeNextRunAt, normalizeScheduleTiming } from '../scheduler/scheduleTime.js';
import { boundedJson, normalizeDomainAssetForStorage, retentionPolicyFromRun, sanitizeCheckResultForStorage, truncateText } from '../storage/retention.js';
import { buildRuntimeProvenance } from '../runtime/provenance.js';
import { requireRunId } from '../scope/runScope.js';
import { normalizeRequestUrl } from '../utils/url.js';

export function createProject(db, { inputDomain, brandName = null }) {
  const result = db.prepare(`
    INSERT INTO projects (inputDomain, brandName)
    VALUES (?, ?)
  `).run(inputDomain, brandName || null);
  return result.lastInsertRowid;
}

export function createRun(db, projectId, config) {
  const runtime = buildRuntimeProvenance(config);
  const result = db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, startedAt, updatedAt,
      crawlMode, includePatternsJson, excludePatternsJson,
      userAgent, robotsUserAgent, targetPagesPerSecond, crawlDelayMs,
      requestTimeoutMs, usePlaywright, playwrightMode, playwrightSampleLimit,
      metricsMode, renderPlanningVersion, runtimeMetricsVersion,
      maxRenderedUrls, maxTotalRenderTimeMs, maxSettlingTimeMsPerUrl, maxBrowserFailures, maxPersistedRenderBytes,
      maxAttempts, maxConcurrentPerHost, retryBaseDelayMs, retryMaxDelayMs,
      maxSitemapUrls, maxSitemaps, sitemapBatchSize,
      enableTemplateSampling, enablePlaywrightSampling, enableLighthouseSampling,
      sampleUrlsPerTemplate, maxTemplateSamplesTotal,
      lighthouseDevice, lighthouseCategoriesJson, lighthouseTimeoutMs,
      playwrightTimeoutMs, renderSettlingMaxMs, renderSettlingIntervalMs, renderSettlingMaxSnapshots,
      renderSettlingStableSnapshots, renderSettlingMinimumObservationMs, maxConcurrentRenderedPages, collectScreenshots, sampleOnlyIndexable,
      scheduledRunId, triggerType, baselineRunId,
      sourceType, crawlScaleMode, storageProfile,
      storeRawHtml, storeRenderedHtml, storeResponseHeaders,
      storeAllLinks, storeAllImages, storeAllResources, storeAffectedOnlyDetails,
      maxEvidenceSamplesPerCheck, maxStoredDetailRowsPerCheck, maxRawHtmlBytesPerUrl,
      storageEstimateJson,
      enableLlmChecks, llmProvider, llmModel, llmMaxSampleUrls, llmMaxChecks,
      llmMaxTokens, llmDryRun, llmWarningsJson,
      primaryHost, runtimeGitCommit, runtimeBuildVersion, runtimeConfigHash, runtimeProvenanceJson,
      scoringVersion, deduplicationVersion, coverageModelVersion, availabilitySemanticsVersion, checkLogicVersion
    )
    VALUES (
      @projectId, 'pending', @auditType, @maxUrls, @maxDepth, @concurrency,
      @respectRobotsTxt, 'init', NULL, CURRENT_TIMESTAMP,
      @crawlMode, @includePatternsJson, @excludePatternsJson,
      @userAgent, @robotsUserAgent, @targetPagesPerSecond, @crawlDelayMs,
      @requestTimeoutMs, @usePlaywright, @playwrightMode, @playwrightSampleLimit,
      @metricsMode, @renderPlanningVersion, @runtimeMetricsVersion,
      @maxRenderedUrls, @maxTotalRenderTimeMs, @maxSettlingTimeMsPerUrl, @maxBrowserFailures, @maxPersistedRenderBytes,
      @maxAttempts, @maxConcurrentPerHost, @retryBaseDelayMs, @retryMaxDelayMs,
      @maxSitemapUrls, @maxSitemaps, @sitemapBatchSize,
      @enableTemplateSampling, @enablePlaywrightSampling, @enableLighthouseSampling,
      @sampleUrlsPerTemplate, @maxTemplateSamplesTotal,
      @lighthouseDevice, @lighthouseCategoriesJson, @lighthouseTimeoutMs,
      @playwrightTimeoutMs, @renderSettlingMaxMs, @renderSettlingIntervalMs, @renderSettlingMaxSnapshots,
      @renderSettlingStableSnapshots, @renderSettlingMinimumObservationMs, @maxConcurrentRenderedPages, @collectScreenshots, @sampleOnlyIndexable,
      @scheduledRunId, @triggerType, @baselineRunId,
      @sourceType, @crawlScaleMode, @storageProfile,
      @storeRawHtml, @storeRenderedHtml, @storeResponseHeaders,
      @storeAllLinks, @storeAllImages, @storeAllResources, @storeAffectedOnlyDetails,
      @maxEvidenceSamplesPerCheck, @maxStoredDetailRowsPerCheck, @maxRawHtmlBytesPerUrl,
      @storageEstimateJson,
      @enableLlmChecks, @llmProvider, @llmModel, @llmMaxSampleUrls, @llmMaxChecks,
      @llmMaxTokens, @llmDryRun, @llmWarningsJson,
      @primaryHost, @runtimeGitCommit, @runtimeBuildVersion, @runtimeConfigHash, @runtimeProvenanceJson,
      @scoringVersion, @deduplicationVersion, @coverageModelVersion, @availabilitySemanticsVersion, @checkLogicVersion
    )
  `).run({
    projectId,
    auditType: config.auditType,
    maxUrls: config.maxUrls,
    maxDepth: config.maxDepth,
    concurrency: config.concurrency,
    respectRobotsTxt: config.respectRobotsTxt ? 1 : 0,
    crawlMode: config.crawlMode,
    includePatternsJson: JSON.stringify(config.includePatterns || []),
    excludePatternsJson: JSON.stringify(config.excludePatterns || []),
    userAgent: config.userAgent || crawlerDefaults.userAgent,
    robotsUserAgent: config.robotsUserAgent || crawlerDefaults.robotsUserAgent,
    targetPagesPerSecond: config.targetPagesPerSecond || 0,
    crawlDelayMs: config.crawlDelayMs,
    requestTimeoutMs: config.requestTimeoutMs,
    usePlaywright: config.usePlaywright ? 1 : 0,
    playwrightMode: config.playwrightMode,
    playwrightSampleLimit: config.playwrightSampleLimit,
    metricsMode: config.metricsMode || crawlerDefaults.metricsMode,
    renderPlanningVersion: config.renderPlanningVersion || null,
    runtimeMetricsVersion: config.runtimeMetricsVersion || null,
    maxRenderedUrls: config.maxRenderedUrls ?? null,
    maxTotalRenderTimeMs: config.maxTotalRenderTimeMs ?? null,
    maxSettlingTimeMsPerUrl: config.maxSettlingTimeMsPerUrl ?? crawlerDefaults.maxSettlingTimeMsPerUrl,
    maxBrowserFailures: config.maxBrowserFailures ?? null,
    maxPersistedRenderBytes: config.maxPersistedRenderBytes ?? null,
    maxAttempts: config.maxAttempts,
    maxConcurrentPerHost: config.maxConcurrentPerHost,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
    maxSitemapUrls: config.maxSitemapUrls,
    maxSitemaps: config.maxSitemaps,
    sitemapBatchSize: config.sitemapBatchSize,
    enableTemplateSampling: config.enableTemplateSampling ? 1 : 0,
    enablePlaywrightSampling: config.enablePlaywrightSampling ? 1 : 0,
    enableLighthouseSampling: config.enableLighthouseSampling ? 1 : 0,
    sampleUrlsPerTemplate: config.sampleUrlsPerTemplate,
    maxTemplateSamplesTotal: config.maxTemplateSamplesTotal,
    lighthouseDevice: config.lighthouseDevice,
    lighthouseCategoriesJson: JSON.stringify(config.lighthouseCategories || []),
    lighthouseTimeoutMs: config.lighthouseTimeoutMs,
    playwrightTimeoutMs: config.playwrightTimeoutMs,
    renderSettlingMaxMs: config.renderSettlingMaxMs ?? crawlerDefaults.renderSettlingMaxMs,
    renderSettlingIntervalMs: config.renderSettlingIntervalMs ?? crawlerDefaults.renderSettlingIntervalMs,
    renderSettlingMaxSnapshots: config.renderSettlingMaxSnapshots ?? crawlerDefaults.renderSettlingMaxSnapshots,
    renderSettlingStableSnapshots: config.renderSettlingStableSnapshots ?? crawlerDefaults.renderSettlingStableSnapshots,
    renderSettlingMinimumObservationMs: config.renderSettlingMinimumObservationMs ?? crawlerDefaults.renderSettlingMinimumObservationMs,
    maxConcurrentRenderedPages: config.maxConcurrentRenderedPages ?? crawlerDefaults.maxConcurrentRenderedPages,
    collectScreenshots: config.collectScreenshots ? 1 : 0,
    sampleOnlyIndexable: config.sampleOnlyIndexable ? 1 : 0,
    scheduledRunId: config.scheduledRunId || null,
    triggerType: normalizeTriggerType(config.triggerType),
    baselineRunId: config.baselineRunId || null,
    sourceType: normalizeSourceType(config.sourceType),
    crawlScaleMode: normalizeCrawlScaleMode(config.crawlScaleMode),
    storageProfile: normalizeStorageProfileValue(config.storageProfile),
    storeRawHtml: config.storeRawHtml ? 1 : 0,
    storeRenderedHtml: config.storeRenderedHtml ? 1 : 0,
    storeResponseHeaders: config.storeResponseHeaders ? 1 : 0,
    storeAllLinks: config.storeAllLinks ? 1 : 0,
    storeAllImages: config.storeAllImages ? 1 : 0,
    storeAllResources: config.storeAllResources ? 1 : 0,
    storeAffectedOnlyDetails: config.storeAffectedOnlyDetails ? 1 : 0,
    maxEvidenceSamplesPerCheck: config.maxEvidenceSamplesPerCheck,
    maxStoredDetailRowsPerCheck: config.maxStoredDetailRowsPerCheck,
    maxRawHtmlBytesPerUrl: config.maxRawHtmlBytesPerUrl,
    storageEstimateJson: config.storageEstimateJson || JSON.stringify(config.storageEstimate || {}),
    enableLlmChecks: config.enableLlmChecks ? 1 : 0,
    llmProvider: normalizeLlmProvider(config.llmProvider),
    llmModel: config.llmModel || null,
    llmMaxSampleUrls: config.llmMaxSampleUrls,
    llmMaxChecks: config.llmMaxChecks,
    llmMaxTokens: config.llmMaxTokens,
    llmDryRun: config.llmDryRun ? 1 : 0,
    llmWarningsJson: JSON.stringify(config.llmWarnings || []),
    primaryHost: hostOf(config.domain),
    runtimeGitCommit: runtime.gitCommit,
    runtimeBuildVersion: runtime.buildVersion,
    runtimeConfigHash: runtime.configHash,
    runtimeProvenanceJson: JSON.stringify(runtime),
    scoringVersion: SCORING_VERSION,
    deduplicationVersion: DEDUPLICATION_VERSION,
    coverageModelVersion: COVERAGE_MODEL_VERSION,
    availabilitySemanticsVersion: AVAILABILITY_SEMANTICS_VERSION,
    checkLogicVersion: CHECK_LOGIC_VERSION
  });
  return result.lastInsertRowid;
}

export function getRunWithProject(db, runId) {
  requireRunId(runId, 'get run');
  return db.prepare(`
    SELECT
      r.*,
      p.inputDomain,
      p.finalDomain,
      p.brandName,
      p.protocolBehaviorJson,
      p.wwwBehaviorJson,
      p.redirectChainJson,
      sr.name AS scheduleName,
      sr.baselineMode AS scheduleBaselineMode,
      sr.autoCompare AS scheduleAutoCompare
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    LEFT JOIN scheduled_runs sr ON sr.id = r.scheduledRunId
    WHERE r.id = ?
  `).get(runId);
}

export function updateRun(db, runId, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`
    UPDATE runs
    SET ${assignments}, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...values, runId);
}

export function updateProject(db, projectId, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE projects SET ${assignments} WHERE id = ?`).run(...values, projectId);
}

export function acquireRunLock(db, runId, lockToken, { staleHeartbeatMs = crawlerDefaults.staleHeartbeatMs } = {}) {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - staleHeartbeatMs).toISOString();
  const tx = db.transaction(() => {
    const run = db.prepare('SELECT id, status, lockToken, heartbeatAt FROM runs WHERE id = ?').get(runId);
    if (!run) return { acquired: false, reason: 'not_found' };
    if (['completed', 'cancelled'].includes(run.status)) return { acquired: false, reason: run.status };
    const hasFreshLock = run.lockToken && run.lockToken !== lockToken && run.heartbeatAt && run.heartbeatAt > staleBefore;
    if (hasFreshLock) return { acquired: false, reason: 'locked' };

    db.prepare(`
      UPDATE runs
      SET lockToken = ?,
          lockedAt = ?,
          heartbeatAt = ?,
          workerCount = 0,
          updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(lockToken, now, now, runId);
    return { acquired: true, reason: 'acquired' };
  });
  return tx();
}

export function releaseRunLock(db, runId, lockToken) {
  db.prepare(`
    UPDATE runs
    SET lockToken = NULL,
        lockedAt = NULL,
        workerCount = 0,
        currentUrl = NULL,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ? AND lockToken = ?
  `).run(runId, lockToken);
}

export function heartbeatRun(db, runId, lockToken, workerCount = null) {
  const now = new Date().toISOString();
  const fields = workerCount === null
    ? 'heartbeatAt = ?, updatedAt = CURRENT_TIMESTAMP'
    : 'heartbeatAt = ?, workerCount = ?, updatedAt = CURRENT_TIMESTAMP';
  const params = workerCount === null
    ? [now, runId, lockToken]
    : [now, workerCount, runId, lockToken];
  return db.prepare(`
    UPDATE runs
    SET ${fields}
    WHERE id = ? AND lockToken = ?
  `).run(...params).changes > 0;
}

export function recoverRun(db, runId, options = {}) {
  const processingTimeoutMs = options.processingTimeoutMs || crawlerDefaults.processingTimeoutMs;
  const now = new Date().toISOString();
  const staleStartedBefore = new Date(Date.now() - processingTimeoutMs).toISOString();
  const tx = db.transaction(() => {
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    if (!run) return { resetProcessing: 0, promotedWaiting: 0, reason: 'not_found' };
    if (['completed', 'cancelled'].includes(run.status)) {
      return { resetProcessing: 0, promotedWaiting: 0, reason: 'terminal' };
    }

    const resetProcessing = db.prepare(`
      UPDATE crawl_queue
      SET status = 'pending',
          startedAt = NULL,
          lockToken = NULL,
          nextAttemptAt = NULL,
          lastError = COALESCE(lastError, 'Recovered stale processing URL')
      WHERE runId = ?
        AND status = 'processing'
        AND (startedAt IS NULL OR startedAt < ? OR lockToken IS NULL OR lockToken <> (SELECT lockToken FROM runs WHERE id = ?))
    `).run(runId, staleStartedBefore, runId).changes;

    const promotedWaiting = db.prepare(`
      UPDATE crawl_queue
      SET status = 'pending',
          nextAttemptAt = NULL
      WHERE runId = ? AND status = 'waiting' AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
    `).run(runId, now).changes;

    db.prepare(`
      UPDATE runs
      SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
          lockToken = NULL,
          workerCount = 0,
          currentUrl = NULL,
          lastRecoveryAt = ?,
          updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(now, runId);

    return { resetProcessing, promotedWaiting };
  });
  return tx();
}

export function getRunHealth(db, runId, options = {}) {
  const staleHeartbeatMs = options.staleHeartbeatMs || crawlerDefaults.staleHeartbeatMs;
  const nowMs = Date.now();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return null;
  const heartbeatMs = run.heartbeatAt ? new Date(run.heartbeatAt).getTime() : 0;
  let health = 'healthy';
  if (run.status === 'paused') health = 'paused';
  else if (run.status === 'completed') health = 'completed';
  else if (run.status === 'cancelled') health = 'cancelled';
  else if (run.status === 'failed') health = 'failed';
  else if (run.status === 'running' && (!heartbeatMs || nowMs - heartbeatMs > staleHeartbeatMs)) health = 'stale';

  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waitingUrls,
      SUM(CASE WHEN status = 'failed' AND lastErrorType = 'retryable' THEN 1 ELSE 0 END) AS retryableFailures,
      SUM(CASE WHEN status = 'failed' AND COALESCE(lastErrorType, '') <> 'retryable' THEN 1 ELSE 0 END) AS permanentFailures
    FROM crawl_queue
    WHERE runId = ?
  `).get(runId);
  const oldestProcessing = db.prepare(`
    SELECT MIN(startedAt) AS oldest
    FROM crawl_queue
    WHERE runId = ? AND status = 'processing'
  `).get(runId).oldest;
  const oldestPending = db.prepare(`
    SELECT MIN(discoveredAt) AS oldest
    FROM crawl_queue
    WHERE runId = ? AND status = 'pending'
  `).get(runId).oldest;

  return {
    health,
    heartbeatAt: run.heartbeatAt,
    lockedAt: run.lockedAt,
    workerCount: run.workerCount || 0,
    waitingUrls: counts.waitingUrls || 0,
    retryableFailures: counts.retryableFailures || 0,
    permanentFailures: counts.permanentFailures || 0,
    oldestProcessingAgeSeconds: ageSeconds(oldestProcessing),
    oldestPendingAgeSeconds: ageSeconds(oldestPending)
  };
}

export function logRun(db, runId, level, message, data = null) {
  db.prepare(`
    INSERT INTO run_logs (runId, level, message, dataJson)
    VALUES (?, ?, ?, ?)
  `).run(runId, level, message, data ? JSON.stringify(data).slice(0, 20000) : null);
}

export function syncRunCounters(db, runId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS discoveredUrls,
      SUM(CASE WHEN status IN ('done', 'failed', 'skipped') THEN 1 ELSE 0 END) AS processedUrls,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS successfulUrls,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedUrls,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedUrls
    FROM crawl_queue
    WHERE runId = ?
  `).get(runId);

  updateRun(db, runId, {
    discoveredUrls: counts.discoveredUrls || 0,
    processedUrls: counts.processedUrls || 0,
    successfulUrls: counts.successfulUrls || 0,
    failedUrls: counts.failedUrls || 0,
    skippedUrls: counts.skippedUrls || 0
  });
}

export function insertPage(db, page) {
  requireRunId(page?.runId, 'insert page');
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, sourceUrl, statusCode, initialStatusCode, redirectChainJson, httpAttemptHistoryJson, contentType,
      indexable, noindex, nofollow, title, titleLength, metaDescription, metaDescriptionLength,
      h1Json, h1Count, h2Json, canonical, canonicalStatus, htmlLang, viewport, metaRobots,
      metaCharset, hasHeaderUtf8, hasMetaCharsetUtf8, xRobotsTag, wordCountRaw, wordCountRendered, rawTextLength,
      renderedTextLength, visibleTextLength, renderedVisibleTextLength, textFactsJson, rawHtmlSize, internalLinksCount, externalLinksCount,
      uniqueInternalTargetsCount, uniqueExternalTargetsCount, nofollowLinksCount,
      imageLinksCount, storedLinkRowsCount, linkRowsTruncated, linkSamplesJson,
      inlinkCount, outlinkCount, schemaTypesJson, imagesCount, imagesWithoutAltCount, responseHeadersJson,
      loadTimeMs, ttfbMs, consoleErrorsJson, pageErrorsJson, requestFailuresJson, cspViolationsJson, navigationError, renderStatus, renderedH1Json, renderedH1Count,
      renderedLinksCount, ogJson, favicon, manifest, featureFlagsJson,
      pageType, hasTables, hasLists, hasFaqPattern, hasVisibleDate,
      hasAuthorPattern, externalSourceLinksCount, hasVideoEmbed,
      cruxLcp, cruxInp, cruxCls, cruxFcp, psiPerformanceScore,
      lighthousePerformanceScore, lighthouseSeoScore, importedSourceTypesJson,
      templateClusterId, templateClusterKey,
      settlingStatus, settlingDurationMs, renderSnapshotCount, renderFingerprint,
      rawDocumentStateJson, initialRenderedStateJson, settledRenderedStateJson,
      effectiveDocumentStateJson, renderProvenanceJson, browserEventsJson,
      renderProvenanceVersion, settlingPolicyVersion, metadataProvenanceComplete,
      effectiveTitle, effectiveMetaDescription, effectiveCanonical, effectiveHtmlLang,
      effectiveMetaRobots, effectiveH1Json, effectiveH1Count, effectiveWordCount,
      effectiveMainWordCount, effectiveInternalLinksCount, effectiveOgJson,
      effectiveTwitterJson, effectiveHreflangJson, effectiveSchemaTypesJson
    )
    VALUES (
      @runId, @url, @normalizedUrl, @finalUrl, @depth, @sourceUrl, @statusCode, @initialStatusCode, @redirectChainJson, @httpAttemptHistoryJson, @contentType,
      @indexable, @noindex, @nofollow, @title, @titleLength, @metaDescription, @metaDescriptionLength,
      @h1Json, @h1Count, @h2Json, @canonical, @canonicalStatus, @htmlLang, @viewport, @metaRobots,
      @metaCharset, @hasHeaderUtf8, @hasMetaCharsetUtf8, @xRobotsTag, @wordCountRaw, @wordCountRendered, @rawTextLength,
      @renderedTextLength, @visibleTextLength, @renderedVisibleTextLength, @textFactsJson, @rawHtmlSize, @internalLinksCount, @externalLinksCount,
      @uniqueInternalTargetsCount, @uniqueExternalTargetsCount, @nofollowLinksCount,
      @imageLinksCount, @storedLinkRowsCount, @linkRowsTruncated, @linkSamplesJson,
      @inlinkCount, @outlinkCount, @schemaTypesJson, @imagesCount, @imagesWithoutAltCount, @responseHeadersJson,
      @loadTimeMs, @ttfbMs, @consoleErrorsJson, @pageErrorsJson, @requestFailuresJson, @cspViolationsJson, @navigationError, @renderStatus, @renderedH1Json, @renderedH1Count,
      @renderedLinksCount, @ogJson, @favicon, @manifest, @featureFlagsJson,
      @pageType, @hasTables, @hasLists, @hasFaqPattern, @hasVisibleDate,
      @hasAuthorPattern, @externalSourceLinksCount, @hasVideoEmbed,
      @cruxLcp, @cruxInp, @cruxCls, @cruxFcp, @psiPerformanceScore,
      @lighthousePerformanceScore, @lighthouseSeoScore, @importedSourceTypesJson,
      @templateClusterId, @templateClusterKey,
      @settlingStatus, @settlingDurationMs, @renderSnapshotCount, @renderFingerprint,
      @rawDocumentStateJson, @initialRenderedStateJson, @settledRenderedStateJson,
      @effectiveDocumentStateJson, @renderProvenanceJson, @browserEventsJson,
      @renderProvenanceVersion, @settlingPolicyVersion, @metadataProvenanceComplete,
      @effectiveTitle, @effectiveMetaDescription, @effectiveCanonical, @effectiveHtmlLang,
      @effectiveMetaRobots, @effectiveH1Json, @effectiveH1Count, @effectiveWordCount,
      @effectiveMainWordCount, @effectiveInternalLinksCount, @effectiveOgJson,
      @effectiveTwitterJson, @effectiveHreflangJson, @effectiveSchemaTypesJson
    )
    ON CONFLICT(runId, normalizedUrl) DO UPDATE SET
      finalUrl = excluded.finalUrl,
      depth = excluded.depth,
      sourceUrl = excluded.sourceUrl,
      statusCode = excluded.statusCode,
      initialStatusCode = excluded.initialStatusCode,
      redirectChainJson = excluded.redirectChainJson,
      httpAttemptHistoryJson = excluded.httpAttemptHistoryJson,
      contentType = excluded.contentType,
      indexable = excluded.indexable,
      noindex = excluded.noindex,
      nofollow = excluded.nofollow,
      title = excluded.title,
      titleLength = excluded.titleLength,
      metaDescription = excluded.metaDescription,
      metaDescriptionLength = excluded.metaDescriptionLength,
      h1Json = excluded.h1Json,
      h1Count = excluded.h1Count,
      h2Json = excluded.h2Json,
      canonical = excluded.canonical,
      canonicalStatus = excluded.canonicalStatus,
      htmlLang = excluded.htmlLang,
      viewport = excluded.viewport,
      metaCharset = excluded.metaCharset,
      hasHeaderUtf8 = excluded.hasHeaderUtf8,
      hasMetaCharsetUtf8 = excluded.hasMetaCharsetUtf8,
      metaRobots = excluded.metaRobots,
      xRobotsTag = excluded.xRobotsTag,
      wordCountRaw = excluded.wordCountRaw,
      wordCountRendered = excluded.wordCountRendered,
      rawTextLength = excluded.rawTextLength,
      renderedTextLength = excluded.renderedTextLength,
      visibleTextLength = excluded.visibleTextLength,
      renderedVisibleTextLength = excluded.renderedVisibleTextLength,
      textFactsJson = excluded.textFactsJson,
      rawHtmlSize = excluded.rawHtmlSize,
      internalLinksCount = excluded.internalLinksCount,
      externalLinksCount = excluded.externalLinksCount,
      uniqueInternalTargetsCount = excluded.uniqueInternalTargetsCount,
      uniqueExternalTargetsCount = excluded.uniqueExternalTargetsCount,
      nofollowLinksCount = excluded.nofollowLinksCount,
      imageLinksCount = excluded.imageLinksCount,
      storedLinkRowsCount = excluded.storedLinkRowsCount,
      linkRowsTruncated = excluded.linkRowsTruncated,
      linkSamplesJson = excluded.linkSamplesJson,
      inlinkCount = excluded.inlinkCount,
      outlinkCount = excluded.outlinkCount,
      schemaTypesJson = excluded.schemaTypesJson,
      imagesCount = excluded.imagesCount,
      imagesWithoutAltCount = excluded.imagesWithoutAltCount,
      responseHeadersJson = excluded.responseHeadersJson,
      loadTimeMs = excluded.loadTimeMs,
      ttfbMs = excluded.ttfbMs,
      consoleErrorsJson = excluded.consoleErrorsJson,
      pageErrorsJson = excluded.pageErrorsJson,
      requestFailuresJson = excluded.requestFailuresJson,
      cspViolationsJson = excluded.cspViolationsJson,
      navigationError = excluded.navigationError,
      renderStatus = excluded.renderStatus,
      renderedH1Json = excluded.renderedH1Json,
      renderedH1Count = excluded.renderedH1Count,
      renderedLinksCount = excluded.renderedLinksCount,
      ogJson = excluded.ogJson,
      favicon = excluded.favicon,
      manifest = excluded.manifest,
      featureFlagsJson = excluded.featureFlagsJson,
      pageType = excluded.pageType,
      hasTables = excluded.hasTables,
      hasLists = excluded.hasLists,
      hasFaqPattern = excluded.hasFaqPattern,
      hasVisibleDate = excluded.hasVisibleDate,
      hasAuthorPattern = excluded.hasAuthorPattern,
      externalSourceLinksCount = excluded.externalSourceLinksCount,
      hasVideoEmbed = excluded.hasVideoEmbed,
      cruxLcp = excluded.cruxLcp,
      cruxInp = excluded.cruxInp,
      cruxCls = excluded.cruxCls,
      cruxFcp = excluded.cruxFcp,
      psiPerformanceScore = excluded.psiPerformanceScore,
      lighthousePerformanceScore = excluded.lighthousePerformanceScore,
      lighthouseSeoScore = excluded.lighthouseSeoScore,
      importedSourceTypesJson = excluded.importedSourceTypesJson,
      templateClusterId = excluded.templateClusterId,
      templateClusterKey = excluded.templateClusterKey,
      settlingStatus = excluded.settlingStatus,
      settlingDurationMs = excluded.settlingDurationMs,
      renderSnapshotCount = excluded.renderSnapshotCount,
      renderFingerprint = excluded.renderFingerprint,
      rawDocumentStateJson = excluded.rawDocumentStateJson,
      initialRenderedStateJson = excluded.initialRenderedStateJson,
      settledRenderedStateJson = excluded.settledRenderedStateJson,
      effectiveDocumentStateJson = excluded.effectiveDocumentStateJson,
      renderProvenanceJson = excluded.renderProvenanceJson,
      browserEventsJson = excluded.browserEventsJson,
      renderProvenanceVersion = excluded.renderProvenanceVersion,
      settlingPolicyVersion = excluded.settlingPolicyVersion,
      metadataProvenanceComplete = excluded.metadataProvenanceComplete,
      effectiveTitle = excluded.effectiveTitle,
      effectiveMetaDescription = excluded.effectiveMetaDescription,
      effectiveCanonical = excluded.effectiveCanonical,
      effectiveHtmlLang = excluded.effectiveHtmlLang,
      effectiveMetaRobots = excluded.effectiveMetaRobots,
      effectiveH1Json = excluded.effectiveH1Json,
      effectiveH1Count = excluded.effectiveH1Count,
      effectiveWordCount = excluded.effectiveWordCount,
      effectiveMainWordCount = excluded.effectiveMainWordCount,
      effectiveInternalLinksCount = excluded.effectiveInternalLinksCount,
      effectiveOgJson = excluded.effectiveOgJson,
      effectiveTwitterJson = excluded.effectiveTwitterJson,
      effectiveHreflangJson = excluded.effectiveHreflangJson,
      effectiveSchemaTypesJson = excluded.effectiveSchemaTypesJson
  `).run({
    noindex: 0,
    nofollow: 0,
    metaCharset: null,
    hasHeaderUtf8: 0,
    hasMetaCharsetUtf8: 0,
    canonicalStatus: null,
    inlinkCount: null,
    outlinkCount: null,
    uniqueInternalTargetsCount: 0,
    uniqueExternalTargetsCount: 0,
    nofollowLinksCount: 0,
    imageLinksCount: 0,
    storedLinkRowsCount: 0,
    linkRowsTruncated: 0,
    linkSamplesJson: JSON.stringify([]),
    cruxLcp: null,
    cruxInp: null,
    cruxCls: null,
    cruxFcp: null,
    psiPerformanceScore: null,
    lighthousePerformanceScore: null,
    lighthouseSeoScore: null,
    importedSourceTypesJson: JSON.stringify([]),
    templateClusterId: null,
    templateClusterKey: null,
    initialStatusCode: page?.statusCode ?? null,
    redirectChainJson: JSON.stringify([]),
    httpAttemptHistoryJson: JSON.stringify([]),
    visibleTextLength: page?.rawTextLength ?? null,
    renderedVisibleTextLength: page?.renderedTextLength ?? null,
    textFactsJson: null,
    pageErrorsJson: JSON.stringify([]),
    requestFailuresJson: JSON.stringify([]),
    cspViolationsJson: JSON.stringify([]),
    navigationError: null,
    renderStatus: null,
    settlingStatus: 'not_executed',
    settlingDurationMs: null,
    renderSnapshotCount: 0,
    renderFingerprint: null,
    rawDocumentStateJson: null,
    initialRenderedStateJson: null,
    settledRenderedStateJson: null,
    effectiveDocumentStateJson: null,
    renderProvenanceJson: null,
    browserEventsJson: JSON.stringify([]),
    renderProvenanceVersion: null,
    settlingPolicyVersion: null,
    metadataProvenanceComplete: 0,
    effectiveTitle: null,
    effectiveMetaDescription: null,
    effectiveCanonical: null,
    effectiveHtmlLang: null,
    effectiveMetaRobots: null,
    effectiveH1Json: null,
    effectiveH1Count: null,
    effectiveWordCount: null,
    effectiveMainWordCount: null,
    effectiveInternalLinksCount: null,
    effectiveOgJson: null,
    effectiveTwitterJson: null,
    effectiveHreflangJson: null,
    effectiveSchemaTypesJson: null,
    ...page
  });
}

export function replacePageArtifacts(db, runId, pageUrl, { links = [], images = [], resources = [], schemas = [], linkAggregates = null }) {
  requireRunId(runId, 'replace page artifacts');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM page_links WHERE runId = ? AND sourceUrl = ?').run(runId, pageUrl);
    db.prepare('DELETE FROM page_images WHERE runId = ? AND pageUrl = ?').run(runId, pageUrl);
    db.prepare('DELETE FROM resources WHERE runId = ? AND pageUrl = ?').run(runId, pageUrl);
    db.prepare('DELETE FROM schemas WHERE runId = ? AND pageUrl = ?').run(runId, pageUrl);

    const insertLink = db.prepare(`
      INSERT INTO page_links (
        runId, sourceUrl, targetUrl, linkedUrl, normalizedTargetUrl, linkType, anchorText, rel, statusCode,
        initialStatusCode, redirectChainJson, finalUrl, finalStatusCode
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const link of links) {
      insertLink.run(
        runId,
        link.sourceUrl,
        link.targetUrl,
        link.linkedUrl || link.targetUrl,
        link.normalizedTargetUrl,
        link.linkType,
        link.anchorText || null,
        link.rel || null,
        link.statusCode ?? null,
        link.initialStatusCode ?? null,
        link.redirectChainJson || null,
        link.finalUrl || null,
        link.finalStatusCode ?? null
      );
    }
    const aggregates = linkAggregates || buildLinkAggregates(links, links.length, false);
    db.prepare(`
      UPDATE pages
      SET internalLinksCount = ?,
          externalLinksCount = ?,
          uniqueInternalTargetsCount = ?,
          uniqueExternalTargetsCount = ?,
          nofollowLinksCount = ?,
          imageLinksCount = ?,
          storedLinkRowsCount = ?,
          linkRowsTruncated = ?,
          linkSamplesJson = ?
      WHERE runId = ? AND (finalUrl = ? OR normalizedUrl = ? OR url = ?)
    `).run(
      aggregates.internalLinkCount || 0,
      aggregates.externalLinkCount || 0,
      aggregates.uniqueInternalTargetsCount || 0,
      aggregates.uniqueExternalTargetsCount || 0,
      aggregates.nofollowCount || 0,
      aggregates.imageLinkCount || 0,
      links.length,
      aggregates.truncated ? 1 : 0,
      JSON.stringify(aggregates.samples || []),
      runId,
      pageUrl,
      pageUrl,
      pageUrl
    );

    const insertImage = db.prepare(`
      INSERT INTO page_images (
        runId, pageUrl, imageUrl, alt, hasAlt, loading, width, height, extension, sizeBytes,
        likelyDecorativeImage, likelyBadgeImage, likelyTrackingPixel, likelyIcon, imageRole,
        altAttributePresent, altValue, altValueTrimmed, isDecorativeCandidate
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const image of images) {
      insertImage.run(
        runId,
        image.pageUrl,
        image.imageUrl,
        image.alt,
        image.hasAlt,
        image.loading || null,
        image.width || null,
        image.height || null,
        image.extension || null,
        image.sizeBytes ?? null,
        image.likelyDecorativeImage ? 1 : 0,
        image.likelyBadgeImage ? 1 : 0,
        image.likelyTrackingPixel ? 1 : 0,
        image.likelyIcon ? 1 : 0,
        image.imageRole || null,
        image.altAttributePresent ?? (image.alt === null || image.alt === undefined ? 0 : 1),
        image.altValue ?? image.alt ?? null,
        image.altValueTrimmed ?? (image.alt === null || image.alt === undefined ? null : String(image.alt).trim()),
        image.isDecorativeCandidate ?? (image.likelyDecorativeImage ? 1 : 0)
      );
    }

    const insertResource = db.prepare(`
      INSERT INTO resources (
        runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes,
        contentType, isThirdParty, responseHeadersJson, sizeMeasurementKind, sizeMeasurementError
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const resource of resources) {
      insertResource.run(
        runId,
        resource.pageUrl,
        resource.resourceUrl,
        resource.resourceType,
        resource.statusCode ?? null,
        resource.sizeBytes ?? null,
        resource.contentType || null,
        resource.isThirdParty ? 1 : 0,
        resource.responseHeadersJson ? String(resource.responseHeadersJson).slice(0, 20000) : null,
        resource.sizeMeasurementKind || (resource.sizeBytes !== null && resource.sizeBytes !== undefined ? 'observed_bytes' : null),
        resource.sizeMeasurementError ? truncateText(resource.sizeMeasurementError, 1000) : null
      );
    }

    const insertSchema = db.prepare(`
      INSERT INTO schemas (
        runId, pageUrl, schemaType, rawJson, rawJsonHash, rawJsonBytes, parseStatus, parseError
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const schema of schemas) {
      insertSchema.run(
        runId,
        pageUrl,
        schema.schemaType || null,
        schema.rawJson ? String(schema.rawJson).slice(0, 50000) : null,
        schema.rawJsonHash || null,
        schema.rawJsonBytes || null,
        schema.parseStatus,
        schema.parseError ? truncateText(schema.parseError, 2000) : null
      );
    }
  });

  tx();
}

export function hydrateInternalLinkHttpFacts(db, runId) {
  requireRunId(runId, 'hydrate internal link HTTP facts');
  const candidates = db.prepare(`
    SELECT l.id, COALESCE(l.linkedUrl, l.targetUrl) AS linkedUrl,
           p.url AS requestedPageUrl, p.initialStatusCode, p.redirectChainJson,
           p.finalUrl, p.statusCode AS finalStatusCode
    FROM page_links l
    JOIN pages p ON p.runId = l.runId AND p.normalizedUrl = l.normalizedTargetUrl
    WHERE l.runId = ? AND l.linkType = 'internal'
    ORDER BY l.id
  `).all(runId).filter((row) => {
    if (!row.linkedUrl) return true;
    return normalizeRequestUrl(row.linkedUrl) === normalizeRequestUrl(row.requestedPageUrl);
  });
  const update = db.prepare(`
    UPDATE page_links
    SET initialStatusCode = ?, statusCode = ?, redirectChainJson = ?, finalUrl = ?, finalStatusCode = ?
    WHERE id = ? AND runId = ?
  `);
  const tx = db.transaction((rows) => {
    let changes = 0;
    for (const row of rows) {
      changes += update.run(row.initialStatusCode, row.initialStatusCode, row.redirectChainJson, row.finalUrl, row.finalStatusCode, row.id, runId).changes;
    }
    return changes;
  });
  return tx(candidates);
}

function buildLinkAggregates(links = [], totalLinks = links.length, truncated = false) {
  const internalTargets = new Set();
  const externalTargets = new Set();
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  let nofollowCount = 0;
  let imageLinkCount = 0;
  const samples = [];
  for (const link of links) {
    const target = link.normalizedTargetUrl || link.targetUrl || '';
    if (link.linkType === 'external') {
      externalLinkCount += 1;
      if (target) externalTargets.add(target);
    } else {
      internalLinkCount += 1;
      if (target) internalTargets.add(target);
    }
    if (/\bnofollow\b/i.test(link.rel || '')) nofollowCount += 1;
    if (/\.(png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(target)) imageLinkCount += 1;
    if (samples.length < 20 && target) {
      samples.push({
        targetUrl: target,
        linkType: link.linkType || 'internal',
        anchorText: link.anchorText || null,
        rel: link.rel || null
      });
    }
  }
  return {
    internalLinkCount,
    externalLinkCount,
    uniqueInternalTargetsCount: internalTargets.size,
    uniqueExternalTargetsCount: externalTargets.size,
    nofollowCount,
    imageLinkCount,
    storedRows: links.length,
    totalRows: totalLinks,
    truncated,
    samples
  };
}

export function insertDomainAsset(db, asset) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(asset.runId) || {};
  const payload = normalizeDomainAssetForStorage(run, asset);
  const existing = db.prepare(`
    SELECT id
    FROM domain_assets
    WHERE runId = ? AND type = ? AND url = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(payload.runId, payload.type, payload.url);
  if (existing) {
    db.prepare(`
      UPDATE domain_assets
      SET statusCode = @statusCode,
          content = @content,
          responseHeadersJson = @responseHeadersJson
      WHERE id = @id
    `).run({ ...payload, id: existing.id });
    return existing.id;
  }
  db.prepare(`
    INSERT INTO domain_assets (
      runId, type, url, statusCode, content, responseHeadersJson
    )
    VALUES (@runId, @type, @url, @statusCode, @content, @responseHeadersJson)
  `).run(payload);
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

export function upsertPageSnapshot(db, snapshot) {
  if (!snapshot?.runId || !snapshot.pageUrl) return null;
  const existing = db.prepare(`
    SELECT id
    FROM page_snapshots
    WHERE runId = ? AND normalizedUrl = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(snapshot.runId, snapshot.normalizedUrl || snapshot.pageUrl);

  const payload = {
    runId: snapshot.runId,
    pageUrl: snapshot.pageUrl,
    normalizedUrl: snapshot.normalizedUrl || snapshot.pageUrl,
    rawHtml: snapshot.rawHtml || null,
    renderedHtml: snapshot.renderedHtml || null,
    rawHtmlBytes: snapshot.rawHtmlBytes || 0,
    renderedHtmlBytes: snapshot.renderedHtmlBytes || 0,
    rawHtmlTruncated: snapshot.rawHtmlTruncated ? 1 : 0,
    renderedHtmlTruncated: snapshot.renderedHtmlTruncated ? 1 : 0
  };

  if (existing) {
    db.prepare(`
      UPDATE page_snapshots
      SET pageUrl = @pageUrl,
          rawHtml = @rawHtml,
          renderedHtml = @renderedHtml,
          rawHtmlBytes = @rawHtmlBytes,
          renderedHtmlBytes = @renderedHtmlBytes,
          rawHtmlTruncated = @rawHtmlTruncated,
          renderedHtmlTruncated = @renderedHtmlTruncated
      WHERE id = @id
    `).run({ ...payload, id: existing.id });
    return existing.id;
  }

  return db.prepare(`
    INSERT INTO page_snapshots (
      runId, pageUrl, normalizedUrl, rawHtml, renderedHtml, rawHtmlBytes,
      renderedHtmlBytes, rawHtmlTruncated, renderedHtmlTruncated
    )
    VALUES (
      @runId, @pageUrl, @normalizedUrl, @rawHtml, @renderedHtml, @rawHtmlBytes,
      @renderedHtmlBytes, @rawHtmlTruncated, @renderedHtmlTruncated
    )
  `).run(payload).lastInsertRowid;
}

export function insertImportFileSummary(db, runId, file) {
  return db.prepare(`
    INSERT INTO import_files (
      runId, importer, filename, exportType, rowCount, mappedFieldsJson,
      ignoredColumnsJson, warningsJson
    )
    VALUES (
      @runId, @importer, @filename, @exportType, @rowCount, @mappedFieldsJson,
      @ignoredColumnsJson, @warningsJson
    )
  `).run({
    runId,
    importer: file.importer || 'screaming_frog',
    filename: file.filename || null,
    exportType: file.exportType || null,
    rowCount: file.rowCount || 0,
    mappedFieldsJson: JSON.stringify(file.mappedFields || []),
    ignoredColumnsJson: JSON.stringify(file.ignoredColumns || []),
    warningsJson: JSON.stringify(file.warnings || [])
  }).lastInsertRowid;
}

export function insertLlmResult(db, result) {
  return db.prepare(`
    INSERT INTO llm_results (
      runId, checkId, sampledUrl, promptId, promptVersion, provider, model,
      inputHash, verdict, score, rationale, evidenceExcerpt, costEstimateJson,
      error, dryRun
    )
    VALUES (
      @runId, @checkId, @sampledUrl, @promptId, @promptVersion, @provider, @model,
      @inputHash, @verdict, @score, @rationale, @evidenceExcerpt, @costEstimateJson,
      @error, @dryRun
    )
  `).run({
    runId: result.runId,
    checkId: result.checkId,
    sampledUrl: result.sampledUrl || null,
    promptId: result.promptId,
    promptVersion: result.promptVersion,
    provider: result.provider,
    model: result.model || null,
    inputHash: result.inputHash || null,
    verdict: result.verdict || null,
    score: result.score ?? null,
    rationale: result.rationale ? truncateText(result.rationale, 4000) : null,
    evidenceExcerpt: result.evidenceExcerpt ? truncateText(result.evidenceExcerpt, 4000) : null,
    costEstimateJson: JSON.stringify(result.costEstimate || null),
    error: result.error ? truncateText(result.error, 2000) : null,
    dryRun: result.dryRun ? 1 : 0
  }).lastInsertRowid;
}

export function clearRunArtifacts(db, runId) {
  requireRunId(runId, 'clear run artifacts');
  db.prepare('DELETE FROM finding_reviews WHERE runId = ?').run(runId);
  db.prepare('DELETE FROM check_results WHERE runId = ?').run(runId);
  db.prepare('DELETE FROM llm_results WHERE runId = ?').run(runId);
  db.prepare(`
    UPDATE runs
    SET scoreStatus = NULL,
        overallScore = NULL,
        techScore = NULL,
        geoScore = NULL,
        scoreBreakdownJson = NULL,
        scoreComputedAt = NULL
    WHERE id = ?
  `).run(runId);
}

export function clearSamplingArtifacts(db, runId) {
  db.prepare('DELETE FROM template_sample_results WHERE runId = ?').run(runId);
  db.prepare('DELETE FROM playwright_results WHERE runId = ?').run(runId);
  db.prepare('DELETE FROM lighthouse_results WHERE runId = ?').run(runId);
  db.prepare('DELETE FROM template_performance_summary WHERE runId = ?').run(runId);
  updateRun(db, runId, {
    samplesTotal: 0,
    samplesProcessed: 0,
    currentSampleUrl: null
  });
}

export function insertCheckResults(db, runId, results) {
  requireRunId(runId, 'insert check results');
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) || {};
  const retentionPolicy = retentionPolicyFromRun(run);
  const insert = db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson,
      factsJson, assessmentJson, recommendationMetaJson, requirementsJson,
      evaluationState, scoreEligible, scoreExclusionReason, scoreDeduplicationKey,
      reportGroupingKey, findingType, confidence, reviewRecommended,
      maturityImpact, dataBasis, evidenceLevel, reviewReason, automationCoverage,
      interpretation, limitations, relatedCheckIdsJson, checkVersion, provenanceJson
      , rootCauseId, rootCauseKey, rootCauseFamily, scopeType,
      occurrenceCount, affectedUrlCount, displayedSampleCount, primaryCheckId,
      deduplicationConfidence, deduplicationReason, rootCauseMembershipsJson,
      evidenceClass, executionStatus, evidenceStatus, evaluationStatus,
      coverageStatus, coverageUnitKey, coverageWeight, coverageReason, availabilitySemanticsVersion
    )
    VALUES (
      @runId, @checkId, @category, @checkName, @status, @priority, @effort, @score,
      @finding, @details, @recommendation, @affectedCount, @sampleUrlsJson, @evidenceJson,
      @factsJson, @assessmentJson, @recommendationMetaJson, @requirementsJson,
      @evaluationState, @scoreEligible, @scoreExclusionReason, @scoreDeduplicationKey,
      @reportGroupingKey, @findingType, @confidence, @reviewRecommended,
      @maturityImpact, @dataBasis, @evidenceLevel, @reviewReason, @automationCoverage,
      @interpretation, @limitations, @relatedCheckIdsJson, @checkVersion, @provenanceJson
      , @rootCauseId, @rootCauseKey, @rootCauseFamily, @scopeType,
      @occurrenceCount, @affectedUrlCount, @displayedSampleCount, @primaryCheckId,
      @deduplicationConfidence, @deduplicationReason, @rootCauseMembershipsJson,
      @evidenceClass, @executionStatus, @evidenceStatus, @evaluationStatus,
      @coverageStatus, @coverageUnitKey, @coverageWeight, @coverageReason, @availabilitySemanticsVersion
    )
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      const storedItem = sanitizeCheckResultForStorage(item, retentionPolicy);
      const sampleUrls = dedupeUrlSamples(storedItem.sampleUrls || [], retentionPolicy.maxEvidenceSamplesPerCheck);
      const evidence = storedItem.evidence && typeof storedItem.evidence === 'object' && !Array.isArray(storedItem.evidence) ? storedItem.evidence : {};
      const requestedStatus = normalizeStatus(item.status);
      const status = ['Warning', 'Error'].includes(requestedStatus) && !Object.keys(evidence).length ? 'NA' : requestedStatus;
      const priority = normalizePriority(storedItem.priority);
      insert.run({
        runId,
        checkId: storedItem.id,
        category: storedItem.category,
        checkName: storedItem.name,
        status,
        priority,
        effort: storedItem.effort,
        score: storedItem.scoreEligible === false ? null : scoreForStatus(status),
        finding: storedItem.finding,
        details: storedItem.details || (['Warning', 'Error'].includes(status) ? `Based on evidence fields: ${Object.keys(evidence).join(', ')}.` : ''),
        recommendation: storedItem.recommendation,
        affectedCount: storedItem.affectedCount || 0,
        sampleUrlsJson: JSON.stringify(sampleUrls),
        evidenceJson: boundedJson(Object.keys(evidence).length ? evidence : { status }, retentionPolicy),
        factsJson: boundedJson(storedItem.facts || {}, retentionPolicy),
        assessmentJson: boundedJson(storedItem.assessment || {}, retentionPolicy),
        recommendationMetaJson: boundedJson(storedItem.recommendationMeta || {}, retentionPolicy),
        requirementsJson: boundedJson(storedItem.requirements || {}, retentionPolicy),
        evaluationState: storedItem.evaluationState || (status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(status) ? 'fail' : 'insufficient_evidence'),
        scoreEligible: storedItem.scoreEligible === false ? 0 : ['OK', 'Warning', 'Error'].includes(status) ? 1 : 0,
        scoreExclusionReason: truncateText(storedItem.scoreExclusionReason || null, 1000),
        scoreDeduplicationKey: truncateText(storedItem.scoreDeduplicationKey || null, 500),
        reportGroupingKey: storedItem.reportGroupingKey || null,
        findingType: normalizeFindingType(storedItem.findingType),
        confidence: normalizeConfidence(storedItem.confidence),
        reviewRecommended: storedItem.reviewRecommended ? 1 : 0,
        maturityImpact: truncateText(storedItem.maturityImpact || null, 200),
        dataBasis: truncateText(storedItem.dataBasis || null, 1000),
        evidenceLevel: normalizeEvidenceLevel(storedItem.evidenceLevel),
        reviewReason: truncateText(storedItem.reviewReason || null, 1000),
        automationCoverage: normalizeAutomationCoverage(storedItem.automationCoverage),
        interpretation: truncateText(storedItem.interpretation || null, 2000),
        limitations: truncateText(storedItem.limitations || null, 2000),
        relatedCheckIdsJson: JSON.stringify(Array.isArray(storedItem.relatedCheckIds) ? storedItem.relatedCheckIds.slice(0, 20) : []),
        checkVersion: String(storedItem.provenance?.checkVersion || storedItem.checkVersion || '1'),
        provenanceJson: boundedJson(storedItem.provenance || {}, retentionPolicy),
        rootCauseId: truncateText(storedItem.rootCauseId || null, 100),
        rootCauseKey: truncateText(storedItem.rootCauseKey || storedItem.scoreDeduplicationKey || null, 500),
        rootCauseFamily: truncateText(storedItem.rootCauseFamily || null, 300),
        scopeType: truncateText(storedItem.scopeType || null, 50),
        occurrenceCount: Math.max(0, Number(storedItem.occurrenceCount ?? storedItem.affectedCount ?? 0)),
        affectedUrlCount: Math.max(0, Number(storedItem.affectedUrlCount ?? storedItem.affectedCount ?? 0)),
        displayedSampleCount: Math.max(0, Number(storedItem.displayedSampleCount ?? sampleUrls.length)),
        primaryCheckId: truncateText(storedItem.primaryCheckId || null, 300),
        deduplicationConfidence: normalizeConfidence(storedItem.deduplicationConfidence || 'high'),
        deduplicationReason: truncateText(storedItem.deduplicationReason || null, 2000),
        rootCauseMembershipsJson: JSON.stringify(Array.isArray(storedItem.rootCauseMemberships) ? storedItem.rootCauseMemberships : []),
        evidenceClass: storedItem.evidenceClass || null,
        executionStatus: storedItem.executionStatus || null,
        evidenceStatus: storedItem.evidenceStatus || null,
        evaluationStatus: storedItem.evaluationStatus || storedItem.evaluationState || null,
        coverageStatus: storedItem.coverageStatus || null,
        coverageUnitKey: truncateText(storedItem.coverageUnitKey || null, 500),
        coverageWeight: storedItem.coverageWeight !== null
          && storedItem.coverageWeight !== undefined
          && Number.isFinite(Number(storedItem.coverageWeight))
          ? Number(storedItem.coverageWeight)
          : null,
        coverageReason: truncateText(storedItem.coverageReason || null, 2000),
        availabilitySemanticsVersion: storedItem.availabilitySemanticsVersion || null
      });
    }
  });

  tx(results);
}

export function persistRunScores(db, runId, scores) {
  requireRunId(runId, 'persist run scores');
  if (!scores?.breakdown || scores.scoringVersion !== SCORING_VERSION) {
    throw new Error(`Cannot persist unsupported scoring snapshot for run ${runId}.`);
  }
  const roots = Array.isArray(scores.breakdown.rootCauses) ? scores.breakdown.rootCauses : [];
  const memberships = new Map();
  for (const root of roots) {
    for (const checkId of root.relatedCheckIds || []) {
      const rows = memberships.get(checkId) || [];
      rows.push({
        rootCauseId: root.rootCauseId,
        rootCauseKey: root.rootCauseKey,
        rootCauseFamily: root.rootCauseFamily,
        scopeType: root.scopeType,
        occurrenceCount: root.occurrenceCount,
        affectedUrlCount: root.affectedUrlCount,
        displayedSampleCount: root.displayedSampleCount,
        primaryCheckId: root.primaryCheckId,
        deduplicationConfidence: root.deduplicationConfidence,
        deduplicationReason: root.deduplicationReason,
        rawPenalty: root.rawPenalty,
        appliedPenalty: root.appliedPenalty
      });
      memberships.set(checkId, rows);
    }
  }
  const updateFinding = db.prepare(`
    UPDATE check_results
    SET rootCauseId = @rootCauseId,
        rootCauseKey = @rootCauseKey,
        rootCauseFamily = @rootCauseFamily,
        scopeType = COALESCE(@scopeType, scopeType),
        occurrenceCount = @occurrenceCount,
        affectedUrlCount = @affectedUrlCount,
        displayedSampleCount = @displayedSampleCount,
        primaryCheckId = @primaryCheckId,
        deduplicationConfidence = @deduplicationConfidence,
        deduplicationReason = @deduplicationReason,
        rootCauseMembershipsJson = @rootCauseMembershipsJson
    WHERE runId = @runId AND checkId = @checkId
  `);
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE runs
      SET scoringVersion = @scoringVersion,
          deduplicationVersion = @deduplicationVersion,
          coverageModelVersion = @coverageModelVersion,
          availabilitySemanticsVersion = @availabilitySemanticsVersion,
          checkLogicVersion = @checkLogicVersion,
          scoreStatus = @scoreStatus,
          overallScore = @overallScore,
          techScore = @techScore,
          geoScore = @geoScore,
          scoreBreakdownJson = @scoreBreakdownJson,
          scoreComputedAt = @scoreComputedAt
      WHERE id = @runId
    `).run({
      runId,
      scoringVersion: scores.scoringVersion,
      deduplicationVersion: scores.deduplicationVersion,
      coverageModelVersion: scores.coverageModelVersion,
      availabilitySemanticsVersion: scores.availabilitySemanticsVersion,
      checkLogicVersion: scores.checkLogicVersion,
      scoreStatus: scores.scoreStatus,
      overallScore: scores.overallScore,
      techScore: scores.techScore,
      geoScore: scores.geoScore,
      scoreBreakdownJson: JSON.stringify(scores),
      scoreComputedAt: new Date().toISOString()
    });
    for (const [checkId, memberRoots] of memberships.entries()) {
      const sorted = [...memberRoots].sort((left, right) => right.appliedPenalty - left.appliedPenalty || left.rootCauseKey.localeCompare(right.rootCauseKey));
      const primary = sorted[0];
      updateFinding.run({
        runId,
        checkId,
        ...primary,
        rootCauseMembershipsJson: JSON.stringify(sorted)
      });
    }
  });
  transaction();
  return scores;
}

export function getLatestLogs(db, runId, limit = 100) {
  return db.prepare(`
    SELECT id, level, message, dataJson, createdAt
    FROM run_logs
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(runId, limit).reverse();
}

export function listTemplateClusters(db, runId) {
  return db.prepare(`
    SELECT *
    FROM template_clusters
    WHERE runId = ?
    ORDER BY urlCount DESC, clusterKey ASC
  `).all(runId).map((row) => ({
    ...row,
    statusCodeSummary: safeJson(row.statusCodeSummaryJson, {}),
    schemaTypesSummary: safeJson(row.schemaTypesSummaryJson, {}),
    sampleUrls: safeJson(row.sampleUrlsJson, [])
  }));
}

export function listTemplateClusterPages(db, runId, clusterId, { page = 1, limit = 50 } = {}) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(200, Math.max(1, Number(limit || 50)));
  const offset = (safePage - 1) * safeLimit;
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pages
    WHERE runId = ? AND templateClusterId = ?
  `).get(runId, clusterId).count;
  const pages = db.prepare(`
    SELECT id, url, finalUrl, statusCode, indexable, pageType, title,
      wordCountRaw, internalLinksCount, externalLinksCount, schemaTypesJson,
      templateClusterId, templateClusterKey
    FROM pages
    WHERE runId = ? AND templateClusterId = ?
    ORDER BY url ASC
    LIMIT ? OFFSET ?
  `).all(runId, clusterId, safeLimit, offset).map((row) => ({
    ...row,
    schemaTypes: safeJson(row.schemaTypesJson, [])
  }));
  return { page: safePage, limit: safeLimit, total, pages };
}

export function createScheduledRun(db, {
  projectId = null,
  name = null,
  domain,
  brandName = null,
  auditType = 'both',
  config = {},
  scheduleType = 'manual',
  intervalValue = 1,
  dayOfWeek = 1,
  dayOfMonth = 1,
  timeOfDay = '09:00',
  timezone = null,
  cronExpression = null,
  nextRunAt = null,
  isActive = true,
  enabled = undefined,
  baselineMode = 'none',
  baselineRunId = null,
  autoCompare = false,
  lastRunId = null,
  lastRunAt = null,
  lastError = null
}) {
  const payload = normalizeScheduledRunPayload({
    projectId,
    name,
    domain,
    brandName,
    auditType,
    config,
    scheduleType,
    intervalValue,
    dayOfWeek,
    dayOfMonth,
    timeOfDay,
    timezone,
    cronExpression,
    nextRunAt,
    isActive: enabled === undefined ? isActive : enabled,
    baselineMode,
    baselineRunId,
    autoCompare,
    lastRunId,
    lastRunAt,
    lastError
  });
  const result = db.prepare(`
    INSERT INTO scheduled_runs (
      projectId, name, domain, brandName, auditType, configJson, scheduleType,
      intervalValue, dayOfWeek, dayOfMonth, timeOfDay, timezone,
      cronExpression, nextRunAt, isActive, enabled, lastRunId, lastRunAt,
      baselineMode, baselineRunId, autoCompare, lastError
    )
    VALUES (
      @projectId, @name, @domain, @brandName, @auditType, @configJson, @scheduleType,
      @intervalValue, @dayOfWeek, @dayOfMonth, @timeOfDay, @timezone,
      @cronExpression, @nextRunAt, @isActive, @enabled, @lastRunId, @lastRunAt,
      @baselineMode, @baselineRunId, @autoCompare, @lastError
    )
  `).run(payload);
  return result.lastInsertRowid;
}

export function getScheduledRun(db, scheduleId) {
  const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(scheduleId);
  return row ? parseScheduledRunRow(row) : null;
}

export function listScheduledRuns(db, { includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE isActive = 1';
  return db.prepare(`
    SELECT *
    FROM scheduled_runs
    ${where}
    ORDER BY isActive DESC, nextRunAt IS NULL, nextRunAt ASC, id DESC
  `).all().map(parseScheduledRunRow);
}

export function updateScheduledRun(db, scheduleId, payload = {}) {
  const existing = getScheduledRun(db, scheduleId);
  if (!existing) return null;
  const normalized = normalizeScheduledRunPayload(payload, existing);
  db.prepare(`
    UPDATE scheduled_runs
    SET projectId = @projectId,
        name = @name,
        domain = @domain,
        brandName = @brandName,
        auditType = @auditType,
        configJson = @configJson,
        scheduleType = @scheduleType,
        intervalValue = @intervalValue,
        dayOfWeek = @dayOfWeek,
        dayOfMonth = @dayOfMonth,
        timeOfDay = @timeOfDay,
        timezone = @timezone,
        cronExpression = @cronExpression,
        nextRunAt = @nextRunAt,
        isActive = @isActive,
        enabled = @enabled,
        baselineMode = @baselineMode,
        baselineRunId = @baselineRunId,
        autoCompare = @autoCompare,
        lastError = @lastError,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    ...normalized,
    id: Number(scheduleId)
  });
  return getScheduledRun(db, scheduleId);
}

export function deleteScheduledRun(db, scheduleId) {
  const existing = getScheduledRun(db, scheduleId);
  if (!existing) return false;
  db.prepare('UPDATE runs SET scheduledRunId = NULL WHERE scheduledRunId = ?').run(scheduleId);
  db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(scheduleId);
  return true;
}

export function enableScheduledRun(db, scheduleId, { now = new Date() } = {}) {
  const existing = getScheduledRun(db, scheduleId);
  if (!existing) return null;
  const nextRunAt = computeNextRunAt({ ...existing, isActive: true }, now);
  db.prepare(`
    UPDATE scheduled_runs
    SET isActive = 1,
        enabled = 1,
        nextRunAt = ?,
        lastError = NULL,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextRunAt, scheduleId);
  return getScheduledRun(db, scheduleId);
}

export function disableScheduledRun(db, scheduleId) {
  const existing = getScheduledRun(db, scheduleId);
  if (!existing) return null;
  db.prepare(`
    UPDATE scheduled_runs
    SET isActive = 0,
        enabled = 0,
        nextRunAt = NULL,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(scheduleId);
  return getScheduledRun(db, scheduleId);
}

export function listDueScheduledRuns(db, nowIso) {
  return db.prepare(`
    SELECT *
    FROM scheduled_runs
    WHERE isActive = 1
      AND scheduleType <> 'manual'
      AND nextRunAt IS NOT NULL
      AND nextRunAt <= ?
    ORDER BY nextRunAt ASC, id ASC
  `).all(nowIso).map(parseScheduledRunRow);
}

export function hasActiveRunForSchedule(db, scheduleId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM runs
    WHERE scheduledRunId = ?
      AND status IN ('pending', 'running')
  `).get(scheduleId);
  return (row?.count || 0) > 0;
}

export function markScheduledRunStarted(db, scheduleId, runId, { nextRunAt = null, startedAt = new Date().toISOString() } = {}) {
  db.prepare(`
    UPDATE scheduled_runs
    SET lastRunId = ?,
        lastRunAt = ?,
        nextRunAt = ?,
        lastError = NULL,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(runId, startedAt, nextRunAt, scheduleId);
  return getScheduledRun(db, scheduleId);
}

export function markScheduledRunError(db, scheduleId, errorMessage, { nextRunAt = null } = {}) {
  db.prepare(`
    UPDATE scheduled_runs
    SET lastError = ?,
        nextRunAt = ?,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(errorMessage || 'Schedule run failed').slice(0, 2000), nextRunAt, scheduleId);
  return getScheduledRun(db, scheduleId);
}

export function listRunsForSchedule(db, scheduleId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT
      r.*,
      p.inputDomain,
      p.finalDomain,
      p.brandName,
      sr.name AS scheduleName,
      sr.baselineMode AS scheduleBaselineMode,
      sr.autoCompare AS scheduleAutoCompare
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    LEFT JOIN scheduled_runs sr ON sr.id = r.scheduledRunId
    WHERE r.scheduledRunId = ?
    ORDER BY r.id DESC
    LIMIT ?
  `).all(scheduleId, Math.min(200, Math.max(1, Number(limit || 50))));
}

export function listComparisonsForSchedule(db, scheduleId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT DISTINCT rc.*
    FROM run_comparisons rc
    JOIN runs baseRun ON baseRun.id = rc.baseRunId
    JOIN runs compareRun ON compareRun.id = rc.compareRunId
    WHERE baseRun.scheduledRunId = ? OR compareRun.scheduledRunId = ?
    ORDER BY rc.id DESC
    LIMIT ?
  `).all(scheduleId, scheduleId, Math.min(200, Math.max(1, Number(limit || 50)))).map(parseComparisonRow);
}

export function getPreviousSuccessfulScheduledRun(db, scheduleId, currentRunId = null) {
  const params = [scheduleId];
  let currentFilter = '';
  if (currentRunId) {
    currentFilter = 'AND r.id <> ?';
    params.push(currentRunId);
  }
  return db.prepare(`
    SELECT
      r.*,
      p.inputDomain,
      p.finalDomain,
      p.brandName,
      sr.name AS scheduleName,
      sr.baselineMode AS scheduleBaselineMode,
      sr.autoCompare AS scheduleAutoCompare
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    LEFT JOIN scheduled_runs sr ON sr.id = r.scheduledRunId
    WHERE r.scheduledRunId = ?
      AND r.status = 'completed'
      ${currentFilter}
    ORDER BY COALESCE(r.finishedAt, r.updatedAt) DESC, r.id DESC
    LIMIT 1
  `).get(...params) || null;
}

export function getScheduleSummary(db, scheduleId) {
  const schedule = getScheduledRun(db, scheduleId);
  if (!schedule) return null;
  const runCounts = db.prepare(`
    SELECT
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedRuns,
      SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS activeRuns,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns
    FROM runs
    WHERE scheduledRunId = ?
  `).get(scheduleId);
  const latestComparison = listComparisonsForSchedule(db, scheduleId, { limit: 1 })[0] || null;
  return {
    ...schedule,
    totalRuns: runCounts.totalRuns || 0,
    completedRuns: runCounts.completedRuns || 0,
    activeRuns: runCounts.activeRuns || 0,
    failedRuns: runCounts.failedRuns || 0,
    latestComparison
  };
}

export function getReviewForCheckResult(db, checkResultId) {
  return db.prepare(`
    SELECT *
    FROM finding_reviews
    WHERE checkResultId = ?
  `).get(checkResultId) || null;
}

export function upsertFindingReview(db, runId, checkResultId, payload = {}) {
  const checkResult = getCheckResultForRun(db, runId, checkResultId);
  if (!checkResult) return null;

  const existing = getReviewForCheckResult(db, checkResultId);
  const normalized = normalizeReviewPayload(payload, existing || {});
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE finding_reviews
      SET reviewStatus = @reviewStatus,
          reviewerName = @reviewerName,
          note = @note,
          manualStatus = @manualStatus,
          manualPriority = @manualPriority,
          manualEffort = @manualEffort,
          manualFinding = @manualFinding,
          manualRecommendation = @manualRecommendation,
          actionStatus = @actionStatus,
          updatedAt = @updatedAt
      WHERE checkResultId = @checkResultId
    `).run({
      ...normalized,
      updatedAt: now,
      checkResultId
    });
  } else {
    db.prepare(`
      INSERT INTO finding_reviews (
        runId, checkResultId, reviewStatus, reviewerName, note, manualStatus,
        manualPriority, manualEffort, manualFinding, manualRecommendation,
        actionStatus, createdAt, updatedAt
      )
      VALUES (
        @runId, @checkResultId, @reviewStatus, @reviewerName, @note, @manualStatus,
        @manualPriority, @manualEffort, @manualFinding, @manualRecommendation,
        @actionStatus, @createdAt, @updatedAt
      )
    `).run({
      ...normalized,
      runId,
      checkResultId,
      createdAt: now,
      updatedAt: now
    });
  }

  return getReviewForCheckResult(db, checkResultId);
}

export function listReviewsForRun(db, runId) {
  return db.prepare(`
    SELECT
      cr.id AS checkResultId,
      cr.runId,
      cr.checkId,
      cr.category,
      cr.checkName,
      cr.status,
      cr.priority,
      cr.effort,
      cr.score,
      cr.finding,
      cr.details,
      cr.recommendation,
      cr.affectedCount,
      cr.sampleUrlsJson,
      cr.evidenceJson,
      cr.reportGroupingKey,
      cr.findingType,
      cr.confidence,
      cr.reviewRecommended,
      fr.id AS reviewId,
      fr.reviewStatus,
      fr.reviewerName,
      fr.note AS reviewNote,
      fr.manualStatus,
      fr.manualPriority,
      fr.manualEffort,
      fr.manualFinding,
      fr.manualRecommendation,
      fr.actionStatus,
      fr.createdAt AS reviewCreatedAt,
      fr.updatedAt AS reviewUpdatedAt
    FROM check_results cr
    LEFT JOIN finding_reviews fr ON fr.runId = cr.runId AND fr.checkResultId = cr.id
    WHERE cr.runId = ?
    ORDER BY
      CASE cr.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      CASE cr.status WHEN 'Error' THEN 1 WHEN 'Warning' THEN 2 WHEN 'OK' THEN 3 ELSE 4 END,
      cr.checkId ASC
  `).all(runId).map(applyEffectiveValues);
}

export function deleteReview(db, runId, checkResultId) {
  const checkResult = getCheckResultForRun(db, runId, checkResultId);
  if (!checkResult) return false;
  db.prepare('DELETE FROM finding_reviews WHERE checkResultId = ?').run(checkResultId);
  return true;
}

export function bulkUpsertFindingReviews(db, runId, checkResultIds, payload = {}) {
  const ids = Array.isArray(checkResultIds)
    ? [...new Set(checkResultIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  if (!ids.length) {
    throw new Error('checkResultIds must contain at least one check result id');
  }

  const placeholders = ids.map(() => '?').join(', ');
  const found = db.prepare(`
    SELECT id
    FROM check_results
    WHERE runId = ? AND id IN (${placeholders})
  `).all(runId, ...ids).map((row) => row.id);

  if (found.length !== ids.length) return null;

  const tx = db.transaction(() => {
    for (const checkResultId of ids) {
      upsertFindingReview(db, runId, checkResultId, payload);
    }
  });
  tx();

  return listReviewsForRun(db, runId).filter((row) => ids.includes(row.checkResultId));
}

export function getReviewSummary(db, runId) {
  const rows = db.prepare(`
    SELECT
      cr.status,
      cr.priority,
      cr.checkId,
      cr.category,
      cr.findingType,
      cr.reviewRecommended,
      cr.confidence,
      fr.manualStatus,
      fr.manualPriority,
      COALESCE(fr.reviewStatus, 'unreviewed') AS reviewStatus,
      COALESCE(fr.actionStatus, 'open') AS actionStatus
    FROM check_results cr
    LEFT JOIN finding_reviews fr ON fr.runId = cr.runId AND fr.checkResultId = cr.id
    WHERE cr.runId = ?
  `).all(runId).map(applyEffectiveValues);

  const summary = {
    ...buildDisplaySummary(rows),
    unreviewed: 0,
    confirmed: 0,
    falsePositive: 0,
    acceptedRisk: 0,
    needsFix: 0,
    fixed: 0,
    ignored: 0,
    open: 0,
    planned: 0,
    inProgress: 0,
    done: 0,
    wontDo: 0
  };

  for (const row of rows) {
    switch (row.displayReviewStatus) {
      case 'confirmed':
        summary.confirmed += 1;
        break;
      case 'false_positive':
        summary.falsePositive += 1;
        break;
      case 'accepted_risk':
        summary.acceptedRisk += 1;
        break;
      case 'needs_fix':
        summary.needsFix += 1;
        break;
      case 'fixed':
        summary.fixed += 1;
        break;
      case 'ignored':
        summary.ignored += 1;
        break;
      case 'not_required':
        break;
      default:
        summary.unreviewed += 1;
        break;
    }

    switch (row.displayActionStatus) {
      case 'planned':
        summary.planned += 1;
        break;
      case 'in_progress':
        summary.inProgress += 1;
        break;
      case 'done':
        summary.done += 1;
        break;
      case 'wont_do':
        summary.wontDo += 1;
        break;
      case 'none':
        break;
      default:
        summary.open += 1;
        break;
    }
  }

  summary.reviewed = summary.reviewableFindings - summary.unreviewed;
  return summary;
}

export function listTemplateSampleResults(db, runId, { templateClusterKey = null, status = null, page = 1, limit = 500 } = {}) {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(1000, Math.max(1, Number(limit || 500)));
  const filters = ['runId = ?'];
  const params = [runId];
  if (templateClusterKey) {
    filters.push('templateClusterKey = ?');
    params.push(String(templateClusterKey));
  }
  if (status) {
    filters.push('(playwrightStatus = ? OR lighthouseStatus = ?)');
    params.push(String(status), String(status));
  }
  const where = filters.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM template_sample_results WHERE ${where}`).get(...params).count;
  const samples = db.prepare(`
    SELECT *
    FROM template_sample_results
    WHERE ${where}
    ORDER BY templateClusterKey ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, (safePage - 1) * safeLimit);
  return { page: safePage, limit: safeLimit, total, samples };
}

export function listPlaywrightResults(db, runId, { page = 1, limit = 500 } = {}) {
  return pagedRows(db, `
    SELECT *
    FROM playwright_results
    WHERE runId = ?
    ORDER BY templateClusterKey ASC, id ASC
  `, runId, page, limit, 'results');
}

export function listLighthouseResults(db, runId, { page = 1, limit = 500 } = {}) {
  return pagedRows(db, `
    SELECT *
    FROM lighthouse_results
    WHERE runId = ?
    ORDER BY templateClusterKey ASC, id ASC
  `, runId, page, limit, 'results');
}

export function listTemplatePerformanceSummary(db, runId, { page = 1, limit = 500 } = {}) {
  const payload = pagedRows(db, `
    SELECT *
    FROM template_performance_summary
    WHERE runId = ?
    ORDER BY
      CASE WHEN minPerformanceScore IS NULL THEN 1 ELSE 0 END,
      minPerformanceScore ASC,
      avgLcpMs DESC,
      templateClusterKey ASC
  `, runId, page, limit, 'templates');
  payload.templates = payload.templates.map((row) => ({
    ...row,
    worstSampleUrls: safeJson(row.worstSampleUrlsJson, [])
  }));
  return payload;
}

export function getSamplingSummary(db, runId) {
  const sample = db.prepare(`
    SELECT
      COUNT(*) AS sampleRows,
      SUM(CASE WHEN playwrightStatus = 'success' THEN 1 ELSE 0 END) AS playwrightSuccessCount,
      SUM(CASE WHEN playwrightStatus IN ('error', 'unavailable') THEN 1 ELSE 0 END) AS playwrightIssueCount,
      SUM(CASE WHEN playwrightStatus = 'unavailable' THEN 1 ELSE 0 END) AS playwrightUnavailableCount,
      SUM(CASE WHEN playwrightStatus = 'disabled' THEN 1 ELSE 0 END) AS playwrightDisabledCount,
      SUM(CASE WHEN lighthouseStatus = 'success' THEN 1 ELSE 0 END) AS lighthouseSuccessCount,
      SUM(CASE WHEN lighthouseStatus IN ('error', 'unavailable') THEN 1 ELSE 0 END) AS lighthouseIssueCount,
      SUM(CASE WHEN lighthouseStatus = 'unavailable' THEN 1 ELSE 0 END) AS lighthouseUnavailableCount,
      SUM(CASE WHEN lighthouseStatus = 'disabled' THEN 1 ELSE 0 END) AS lighthouseDisabledCount,
      SUM(CASE WHEN errorMessage IS NOT NULL AND errorMessage <> '' THEN 1 ELSE 0 END) AS sampleErrorCount,
      MIN(CASE WHEN playwrightStatus = 'unavailable' AND errorMessage IS NOT NULL AND errorMessage <> '' THEN errorMessage END) AS playwrightUnavailableError,
      MIN(CASE WHEN lighthouseStatus = 'unavailable' AND errorMessage IS NOT NULL AND errorMessage <> '' THEN errorMessage END) AS lighthouseUnavailableError
    FROM template_sample_results
    WHERE runId = ?
  `).get(runId);
  const run = db.prepare(`
    SELECT enableTemplateSampling, enablePlaywrightSampling, enableLighthouseSampling,
      samplesTotal, samplesProcessed, currentSampleUrl
    FROM runs
    WHERE id = ?
  `).get(runId) || {};
  const sampleRows = sample.sampleRows || 0;
  const playwrightSuccessCount = sample.playwrightSuccessCount || 0;
  const playwrightIssueCount = sample.playwrightIssueCount || 0;
  const playwrightUnavailableCount = sample.playwrightUnavailableCount || 0;
  const lighthouseSuccessCount = sample.lighthouseSuccessCount || 0;
  const lighthouseIssueCount = sample.lighthouseIssueCount || 0;
  const lighthouseUnavailableCount = sample.lighthouseUnavailableCount || 0;
  const renderingStatus = samplingToolStatus({
    enabled: Boolean(run.enablePlaywrightSampling),
    sampleRows,
    successCount: playwrightSuccessCount,
    issueCount: playwrightIssueCount,
    unavailableCount: playwrightUnavailableCount
  });
  const lighthouseStatus = samplingToolStatus({
    enabled: Boolean(run.enableLighthouseSampling),
    sampleRows,
    successCount: lighthouseSuccessCount,
    issueCount: lighthouseIssueCount,
    unavailableCount: lighthouseUnavailableCount
  });
  return {
    enableTemplateSampling: Boolean(run.enableTemplateSampling),
    enablePlaywrightSampling: Boolean(run.enablePlaywrightSampling),
    enableLighthouseSampling: Boolean(run.enableLighthouseSampling),
    samplesTotal: run.samplesTotal || sampleRows,
    samplesProcessed: run.samplesProcessed || 0,
    currentSampleUrl: run.currentSampleUrl || null,
    sampleRows,
    playwrightSuccessCount,
    playwrightIssueCount,
    playwrightUnavailableCount,
    playwrightDisabledCount: sample.playwrightDisabledCount || 0,
    lighthouseSuccessCount,
    lighthouseIssueCount,
    lighthouseUnavailableCount,
    lighthouseDisabledCount: sample.lighthouseDisabledCount || 0,
    sampleErrorCount: sample.sampleErrorCount || 0,
    renderingStatus,
    renderingStatusMessage: samplingStatusMessage('rendering', renderingStatus, sample.playwrightUnavailableError),
    lighthouseStatus,
    lighthouseStatusMessage: samplingStatusMessage('lighthouse', lighthouseStatus, sample.lighthouseUnavailableError)
  };
}

function samplingToolStatus({ enabled, sampleRows, successCount, issueCount, unavailableCount }) {
  if (!enabled) return 'disabled';
  if (!sampleRows) return 'unavailable';
  if (successCount >= sampleRows) return 'completed';
  if (successCount > 0) return 'partial';
  if (unavailableCount || issueCount) return 'unavailable';
  return 'partial';
}

function samplingStatusMessage(tool, status, errorMessage = '') {
  if (tool === 'rendering') {
    if (status === 'disabled') return 'Template rendering sampling disabled; raw HTML crawl data used.';
    if (status === 'unavailable') return conciseUnavailableMessage('rendering', errorMessage);
    if (status === 'partial') return 'Template rendering sampling partially completed; raw HTML fallback remains available.';
    return 'Template rendering sampling completed for selected template samples.';
  }
  if (status === 'disabled') return 'Template Lighthouse sampling disabled; no lab performance data requested.';
  if (status === 'unavailable') return conciseUnavailableMessage('lighthouse', errorMessage);
  if (status === 'partial') return 'Template Lighthouse sampling partially completed; no field data was collected.';
  return 'Template Lighthouse sampling completed for selected template samples.';
}

function conciseUnavailableMessage(tool, errorMessage = '') {
  const error = String(errorMessage || '').toLowerCase();
  if (tool === 'rendering') {
    if (/executable doesn't exist|browser.*not.*install|chromium.*not.*install|playwright.*install/.test(error)) {
      return 'Template rendering sampling unavailable. Reason: Playwright browser is not installed. Fix: npx playwright install chromium.';
    }
    return 'Template rendering sampling unavailable. Reason: local browser/runtime unavailable. Fix: npx playwright install chromium.';
  }
  if (/cannot find package|module not found|not installed|lighthouse/.test(error)) {
    return 'Template Lighthouse sampling unavailable. Reason: package lighthouse is not installed. Fix: npm install lighthouse chrome-launcher.';
  }
  return 'Template Lighthouse sampling unavailable. Reason: local Lighthouse run failed or was unavailable. Fix: npm install lighthouse chrome-launcher.';
}

function ageSeconds(value) {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 1000);
}

export function listComparisonCandidates(db, runId) {
  const run = getRunWithProject(db, runId);
  if (!run) return [];
  const domain = normalizedDomain(run.finalDomain || run.inputDomain);
  const rows = db.prepare(`
    SELECT
      r.id AS runId,
      r.startedAt,
      r.finishedAt,
      r.updatedAt,
      r.status,
      r.auditType,
      r.processedUrls,
      r.successfulUrls,
      r.failedUrls,
      p.finalDomain,
      p.inputDomain
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    WHERE r.id <> ?
      AND r.status = 'completed'
    ORDER BY r.id DESC
  `).all(runId);
  return rows.filter((row) => normalizedDomain(row.finalDomain || row.inputDomain) === domain);
}

export function saveRunComparison(db, comparison) {
  const result = db.prepare(`
    INSERT INTO run_comparisons (
      baseRunId, compareRunId, baseDomain, compareDomain, status,
      summaryJson, findingsDeltaJson, urlDeltaJson, templateDeltaJson,
      performanceDeltaJson, regressionFindingsJson, warningsJson, scheduleContextJson
    )
    VALUES (
      @baseRunId, @compareRunId, @baseDomain, @compareDomain, @status,
      @summaryJson, @findingsDeltaJson, @urlDeltaJson, @templateDeltaJson,
      @performanceDeltaJson, @regressionFindingsJson, @warningsJson, @scheduleContextJson
    )
  `).run(serializeComparison(comparison));
  return getRunComparison(db, result.lastInsertRowid);
}

export function getRunComparison(db, comparisonId) {
  const row = db.prepare('SELECT * FROM run_comparisons WHERE id = ?').get(comparisonId);
  return row ? parseComparisonRow(row) : null;
}

export function listRunComparisons(db, runId) {
  return db.prepare(`
    SELECT *
    FROM run_comparisons
    WHERE baseRunId = ? OR compareRunId = ?
    ORDER BY id DESC
  `).all(runId, runId).map(parseComparisonRow);
}

export function deleteRun(db, runId) {
  const run = getRunWithProject(db, runId);
  if (!run) return false;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM crawl_queue WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM template_clusters WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM pages WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM page_links WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM page_images WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM resources WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM schemas WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM domain_assets WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM page_snapshots WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM import_files WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM llm_results WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM finding_reviews WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM template_sample_results WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM playwright_results WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM lighthouse_results WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM template_performance_summary WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM targeted_evidence_facts WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM evidence_jobs WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM validation_reports WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM url_runtime_metrics WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM run_runtime_metrics WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM run_comparisons WHERE baseRunId = ? OR compareRunId = ?').run(runId, runId);
    db.prepare('DELETE FROM check_results WHERE runId = ?').run(runId);
    db.prepare('DELETE FROM run_logs WHERE runId = ?').run(runId);
    db.prepare('UPDATE scheduled_runs SET lastRunId = NULL WHERE lastRunId = ?').run(runId);
    db.prepare('UPDATE runs SET baselineRunId = NULL WHERE baselineRunId = ?').run(runId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);

    const remaining = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE projectId = ?').get(run.projectId).count;
    if (!remaining) {
      db.prepare('UPDATE scheduled_runs SET projectId = NULL WHERE projectId = ?').run(run.projectId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(run.projectId);
    }
  });

  tx();
  return true;
}

function serializeComparison(comparison) {
  return {
    baseRunId: comparison.baseRun?.id || comparison.baseRunId,
    compareRunId: comparison.compareRun?.id || comparison.compareRunId,
    baseDomain: comparison.baseRun?.finalDomain || comparison.baseRun?.inputDomain || comparison.baseDomain || null,
    compareDomain: comparison.compareRun?.finalDomain || comparison.compareRun?.inputDomain || comparison.compareDomain || null,
    status: comparison.status || 'completed',
    summaryJson: JSON.stringify(comparison.summary || {}),
    findingsDeltaJson: JSON.stringify(comparison.findingsDelta || []),
    urlDeltaJson: JSON.stringify(comparison.urlDelta || []),
    templateDeltaJson: JSON.stringify(comparison.templateDelta || []),
    performanceDeltaJson: JSON.stringify(comparison.performanceDelta || []),
    regressionFindingsJson: JSON.stringify(comparison.regressionFindings || []),
    warningsJson: JSON.stringify(comparison.warnings || []),
    scheduleContextJson: JSON.stringify(comparison.scheduleContext || scheduleContextFromComparison(comparison) || null)
  };
}

function parseComparisonRow(row) {
  return {
    ...row,
    summary: safeJson(row.summaryJson, {}),
    findingsDelta: safeJson(row.findingsDeltaJson, []),
    urlDelta: safeJson(row.urlDeltaJson, []),
    templateDelta: safeJson(row.templateDeltaJson, []),
    performanceDelta: safeJson(row.performanceDeltaJson, []),
    regressionFindings: safeJson(row.regressionFindingsJson, []),
    warnings: safeJson(row.warningsJson, []),
    scheduleContext: safeJson(row.scheduleContextJson, null)
  };
}

function parseScheduledRunRow(row) {
  return {
    ...row,
    config: safeJson(row.configJson, {}),
    isActive: Boolean(row.isActive),
    enabled: Boolean(row.enabled),
    autoCompare: Boolean(row.autoCompare)
  };
}

function normalizeScheduledRunPayload(payload = {}, existing = {}) {
  const timing = normalizeScheduleTiming({
    scheduleType: payload.scheduleType ?? existing.scheduleType,
    intervalValue: payload.intervalValue ?? existing.intervalValue,
    dayOfWeek: payload.dayOfWeek ?? existing.dayOfWeek,
    dayOfMonth: payload.dayOfMonth ?? existing.dayOfMonth,
    timeOfDay: payload.timeOfDay ?? existing.timeOfDay,
    timezone: payload.timezone ?? existing.timezone,
    isActive: payload.isActive ?? payload.enabled ?? existing.isActive ?? existing.enabled
  });
  const config = payload.config !== undefined
    ? normalizeConfigObject(payload.config)
    : normalizeConfigObject(existing.config ?? safeJson(existing.configJson, {}));
  const scheduleType = timing.scheduleType;
  const isActive = timing.isActive ? 1 : 0;
  const timingKeys = ['scheduleType', 'intervalValue', 'dayOfWeek', 'dayOfMonth', 'timeOfDay', 'timezone', 'isActive', 'enabled'];
  const shouldRecomputeNextRunAt = !existing.id || timingKeys.some((key) => payload[key] !== undefined);
  const nextRunAt = payload.nextRunAt !== undefined
    ? nullableText(payload.nextRunAt)
    : shouldRecomputeNextRunAt
      ? computeNextRunAt({ ...timing, scheduleType, isActive: Boolean(isActive) })
      : nullableText(existing.nextRunAt);
  const domain = String(payload.domain ?? existing.domain ?? '').trim();
  if (!domain) throw new Error('domain is required');

  return {
    projectId: nullableInteger(payload.projectId ?? existing.projectId),
    name: nullableText(payload.name ?? existing.name) || domain,
    domain,
    brandName: nullableText(payload.brandName ?? existing.brandName),
    auditType: normalizeAuditType(payload.auditType ?? existing.auditType),
    configJson: JSON.stringify(config),
    scheduleType,
    intervalValue: timing.intervalValue,
    dayOfWeek: timing.dayOfWeek,
    dayOfMonth: timing.dayOfMonth,
    timeOfDay: timing.timeOfDay,
    timezone: timing.timezone,
    cronExpression: nullableText(payload.cronExpression ?? existing.cronExpression),
    nextRunAt,
    isActive,
    enabled: isActive,
    lastRunId: nullableInteger(payload.lastRunId ?? existing.lastRunId),
    lastRunAt: nullableText(payload.lastRunAt ?? existing.lastRunAt),
    baselineMode: normalizeBaselineMode(payload.baselineMode ?? existing.baselineMode),
    baselineRunId: nullableInteger(payload.baselineRunId ?? existing.baselineRunId),
    autoCompare: truthy(payload.autoCompare ?? existing.autoCompare) ? 1 : 0,
    lastError: nullableText(payload.lastError ?? existing.lastError)
  };
}

function normalizeConfigObject(value) {
  if (!value) return {};
  if (typeof value === 'string') return safeJson(value, {});
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return {};
}

function normalizeAuditType(value) {
  return ['tech', 'geo', 'both'].includes(value) ? value : 'both';
}

function normalizeBaselineMode(value) {
  return ['previous_successful', 'fixed_run', 'none'].includes(value) ? value : 'none';
}

function normalizeTriggerType(value) {
  return ['manual', 'scheduled', 'schedule_run_now'].includes(value) ? value : 'manual';
}

function normalizeSourceType(value) {
  return ['crawl', 'screaming_frog_import', 'hybrid'].includes(value) ? value : 'crawl';
}

function normalizeCrawlScaleMode(value) {
  return ['small', 'medium', 'large', 'enterprise'].includes(value) ? value : 'medium';
}

function normalizeStorageProfileValue(value) {
  return ['lean', 'standard', 'debug'].includes(value) ? value : 'standard';
}

function normalizeLlmProvider(value) {
  return ['none', 'openai', 'anthropic', 'mock'].includes(value) ? value : 'none';
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function nullableText(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || null;
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function scheduleContextFromComparison(comparison) {
  const baseScheduleId = comparison.baseRun?.scheduledRunId || null;
  const compareScheduleId = comparison.compareRun?.scheduledRunId || null;
  if (!baseScheduleId || !compareScheduleId || baseScheduleId !== compareScheduleId) return null;
  return {
    scheduledRunId: baseScheduleId,
    scheduleName: comparison.compareRun?.scheduleName || comparison.baseRun?.scheduleName || null,
    triggerType: comparison.compareRun?.triggerType || null,
    baselineMode: comparison.compareRun?.scheduleBaselineMode || null
  };
}

function normalizedDomain(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return input.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

function hostOf(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function pagedRows(db, sql, runId, page = 1, limit = 500, key = 'rows') {
  const safePage = Math.max(1, Number(page || 1));
  const safeLimit = Math.min(1000, Math.max(1, Number(limit || 500)));
  const countSql = `SELECT COUNT(*) AS count FROM (${sql})`;
  const total = db.prepare(countSql).get(runId).count;
  const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(runId, safeLimit, (safePage - 1) * safeLimit);
  return {
    page: safePage,
    limit: safeLimit,
    total,
    [key]: rows
  };
}

function getCheckResultForRun(db, runId, checkResultId) {
  return db.prepare(`
    SELECT id, runId
    FROM check_results
    WHERE runId = ? AND id = ?
  `).get(runId, checkResultId) || null;
}
