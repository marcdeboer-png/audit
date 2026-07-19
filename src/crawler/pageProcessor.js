import { extractHtml } from '../extractors/htmlExtractor.js';
import { performance } from 'node:perf_hooks';
import { renderPage } from '../extractors/renderExtractor.js';
import { insertPage, logRun, replacePageArtifacts, upsertPageSnapshot } from '../db/repositories.js';
import { totalCount } from '../queue/sqliteQueue.js';
import { fetchWithTimeout, selectedHeaders } from '../utils/http.js';
import { isInternalUrl, isLikelyHtmlPage, normalizeUrl } from '../utils/url.js';
import { enqueueBatchWithPolicy } from './crawlPolicy.js';
import { createHttpStatusError } from './retryPolicy.js';
import { crawlerDefaults } from './defaults.js';
import { filterArtifactsForStorage, snapshotHtml } from '../storage/retention.js';
import { buildEffectiveDocumentState, RENDER_PROVENANCE_VERSION, SETTLING_POLICY_VERSION } from '../extractors/documentState.js';
import { activeRenderCheckIdsForAuditType, classifierForRenderPlanningVersion, RENDER_NEEDS } from '../rendering/renderPlanner.js';
import { serializedRenderProvenanceBytes } from '../runtime/renderMetrics.js';
import { appendHttpAttemptHistory, compactHttpAttempt } from '../utils/httpStatus.js';

const RETRY_STATUS_CODES = new Set(crawlerDefaults.retryStatusCodes);
const renderSlots = new Map();

export async function processQueueItem(db, run, project, queueItem, browser, robots, runtimeMetrics = null) {
  const totalStartedAt = performance.now();
  const url = queueItem.url || queueItem.normalizedUrl;
  const finalDomain = project.finalDomain;

  if (run.respectRobotsTxt && robots && robots.isAllowed(url, run.robotsUserAgent || crawlerDefaults.robotsUserAgent) === false) {
    return { status: 'skipped', reason: 'Blocked by robots.txt' };
  }

  const fetchStartedAt = performance.now();
  const response = await fetchWithTimeout(url, { timeoutMs: run.requestTimeoutMs || 15000, maxBytes: 5 * 1024 * 1024, userAgent: run.userAgent });
  const rawFetchDurationMs = performance.now() - fetchStartedAt;
  const normalizedFinalUrl = normalizeUrl(response.url) || url;
  const responseHeadersJson = run.storeResponseHeaders ? JSON.stringify(selectedHeaders(response.headers)).slice(0, 20000) : null;
  const contentType = response.contentType || '';
  const httpAttempt = compactHttpAttempt({
    attempt: queueItem.attempts,
    method: 'GET',
    requestedUrl: url,
    initialStatusCode: response.initialStatusCode,
    redirectChain: response.redirectChain,
    statusCode: response.statusCode,
    finalUrl: normalizedFinalUrl,
    contentType,
    loadTimeMs: response.loadTimeMs
  });
  const httpAttemptHistoryJson = appendHttpAttemptHistory(queueItem.httpAttemptHistoryJson, httpAttempt);
  if (RETRY_STATUS_CODES.has(Number(response.statusCode))) {
    insertPage(db, emptyPageRecord({
      runId: run.id,
      queueItem,
      finalUrl: normalizedFinalUrl,
      statusCode: response.statusCode,
      initialStatusCode: response.initialStatusCode,
      redirectChainJson: JSON.stringify(response.redirectChain || []),
      httpAttemptHistoryJson,
      contentType,
      responseHeadersJson,
      rawHtmlSize: response.sizeBytes,
      loadTimeMs: response.loadTimeMs,
      ttfbMs: response.ttfbMs
    }));
    const error = createHttpStatusError(response.statusCode, url);
    error.httpAttempt = httpAttempt;
    throw error;
  }
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);

  if (!isHtml) {
    const persistenceStartedAt = performance.now();
    insertPage(db, emptyPageRecord({
      runId: run.id,
      queueItem,
      finalUrl: normalizedFinalUrl,
      statusCode: response.statusCode,
      initialStatusCode: response.initialStatusCode,
      redirectChainJson: JSON.stringify(response.redirectChain || []),
      httpAttemptHistoryJson,
      contentType,
      responseHeadersJson,
      rawHtmlSize: response.sizeBytes,
      loadTimeMs: response.loadTimeMs,
      ttfbMs: response.ttfbMs
    }));
    runtimeMetrics?.recordUrl({
      url,
      pageType: 'other',
      renderStrategy: renderStrategy(run),
      renderNeed: RENDER_NEEDS.notRequired,
      renderDecision: RENDER_NEEDS.notRequired,
      reason: { summary: 'Non-HTML resources are outside browser document rendering scope.' },
      renderConfidence: 'high',
      rawFetchDurationMs,
      persistenceDurationMs: performance.now() - persistenceStartedAt,
      totalUrlDurationMs: performance.now() - totalStartedAt,
      rawHtmlBytes: response.sizeBytes,
      renderStatus: 'not_applicable',
      finalSettlingStatus: 'not_applicable'
    });
    return { status: 'done', reason: 'Non-HTML response recorded', httpAttempt };
  }

  const extractionStartedAt = performance.now();
  const extracted = extractHtml(response.body, normalizedFinalUrl, finalDomain, response.headers);
  const extractionDurationMs = performance.now() - extractionStartedAt;
  const renderNeed = classifierForRenderPlanningVersion(run.renderPlanningVersion)({
    ...extracted.page,
    rawDocumentStateJson: extracted.page.rawDocumentStateJson,
    scriptCount: extracted.resources.filter((resource) => resource.resourceType === 'script').length,
    hydrationBytes: hydrationPayloadBytes(response.body)
  }, { activeCheckIds: activeRenderCheckIdsForAuditType(run.auditType) });
  const shouldRender = shouldRenderPage(db, run, browser);
  let budget = { allowed: false, reason: 'not_requested' };
  let renderDurationMs = 0;
  const render = shouldRender
    ? await withRenderSlot(run.id, run.maxConcurrentRenderedPages || crawlerDefaults.maxConcurrentRenderedPages, async () => {
        budget = currentRenderBudget(db, run);
        if (!budget.allowed) return emptyRenderResult({ settlingStatus: 'render_budget_exhausted', renderStatus: 'not_executed' });
        const renderStartedAt = performance.now();
        const result = await renderPage(browser, normalizedFinalUrl, finalDomain, run.requestTimeoutMs || 15000, run.userAgent, {
        captureHtml: Boolean(run.storeRenderedHtml),
        settling: {
          maxDurationMs: Math.min(run.renderSettlingMaxMs, run.maxSettlingTimeMsPerUrl || run.renderSettlingMaxMs),
          intervalMs: run.renderSettlingIntervalMs,
          maxSnapshots: run.renderSettlingMaxSnapshots,
          stableSnapshots: run.renderSettlingStableSnapshots,
          minimumObservationMs: run.renderSettlingMinimumObservationMs
        },
        shouldAbort: () => {
          const current = db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id);
          return !current || !['running', 'pending'].includes(current.status);
        }
        });
        renderDurationMs = performance.now() - renderStartedAt;
        return result;
      })
    : emptyRenderResult();
  if (shouldRender && budget.allowed) runtimeMetrics?.recordRenderUsage({ durationMs: renderDurationMs, failure: render.renderStatus === 'technical_error' });
  const resources = dedupeResources([...extracted.resources, ...render.resources]);

  const rawDocumentState = safeJson(extracted.page.rawDocumentStateJson);
  const initialRenderedState = safeJson(render.initialRenderedStateJson);
  const settledRenderedState = safeJson(render.settledRenderedStateJson);
  const effectiveDocumentState = buildEffectiveDocumentState(rawDocumentState, initialRenderedState, settledRenderedState, render);
  const effective = Object.fromEntries(Object.entries(effectiveDocumentState.fields || {}).map(([key, value]) => [key, value.effective]));
  const renderedMeasurementComplete = metadataProvenanceIsComplete(run, shouldRender && budget.allowed, render, renderNeed);
  const pageRecord = {
    runId: run.id,
    url,
    normalizedUrl: queueItem.normalizedUrl,
    finalUrl: normalizedFinalUrl,
    depth: queueItem.depth,
    sourceUrl: queueItem.sourceUrl,
    statusCode: response.statusCode,
    initialStatusCode: response.initialStatusCode,
    redirectChainJson: JSON.stringify(response.redirectChain || []),
    httpAttemptHistoryJson,
    contentType,
    rawHtmlSize: response.sizeBytes,
    loadTimeMs: response.loadTimeMs,
    ttfbMs: response.ttfbMs,
    ...extracted.page,
    responseHeadersJson,
    wordCountRendered: render.wordCountRendered,
    renderedTextLength: render.renderedTextLength,
    renderedVisibleTextLength: render.renderedVisibleTextLength,
    textFactsJson: mergeRenderedTextFacts(extracted.page.textFactsJson, render),
    renderedH1Json: render.renderedH1Json,
    renderedH1Count: render.renderedH1Count,
    renderedLinksCount: render.renderedLinksCount,
    consoleErrorsJson: render.consoleErrorsJson,
    pageErrorsJson: render.pageErrorsJson,
    requestFailuresJson: render.requestFailuresJson,
    cspViolationsJson: render.cspViolationsJson,
    navigationError: render.navigationError,
    renderStatus: render.renderStatus,
    settlingStatus: render.settlingStatus,
    settlingDurationMs: render.settlingDurationMs,
    renderSnapshotCount: render.renderSnapshotCount,
    renderFingerprint: render.renderFingerprint,
    initialRenderedStateJson: render.initialRenderedStateJson,
    settledRenderedStateJson: render.settledRenderedStateJson,
    effectiveDocumentStateJson: JSON.stringify(effectiveDocumentState),
    renderProvenanceJson: render.renderProvenanceJson,
    browserEventsJson: render.browserEventsJson,
    renderProvenanceVersion: RENDER_PROVENANCE_VERSION,
    settlingPolicyVersion: SETTLING_POLICY_VERSION,
    metadataProvenanceComplete: renderedMeasurementComplete ? 1 : 0,
    effectiveTitle: effective.title ?? null,
    effectiveMetaDescription: effective.metaDescription ?? null,
    effectiveCanonical: effective.canonical ?? null,
    effectiveHtmlLang: effective.htmlLang ?? null,
    effectiveMetaRobots: Array.isArray(effective.robots) ? effective.robots.join(', ') : null,
    effectiveH1Json: JSON.stringify(effective.h1 || []),
    effectiveH1Count: Array.isArray(effective.h1) ? effective.h1.length : null,
    effectiveWordCount: effective.visibleText?.wordCount ?? null,
    effectiveMainWordCount: effective.mainText?.wordCount ?? null,
    effectiveInternalLinksCount: Array.isArray(effective.internalLinks) ? effective.internalLinks.filter((link) => isInternalUrl(link, finalDomain)).length : null,
    effectiveOgJson: JSON.stringify(effective.openGraph || {}),
    effectiveTwitterJson: JSON.stringify(effective.twitter || {}),
    effectiveHreflangJson: JSON.stringify(effective.hreflang || []),
    effectiveSchemaTypesJson: JSON.stringify(effective.structuredData?.types || [])
  };

  const persistenceStartedAt = performance.now();
  insertPage(db, pageRecord);
  replacePageArtifacts(db, run.id, normalizedFinalUrl, filterArtifactsForStorage(run, {
    links: extracted.links.map((link) => ({ ...link, sourceUrl: normalizedFinalUrl })),
    images: extracted.images.map((image) => ({ ...image, pageUrl: normalizedFinalUrl })),
    resources,
    schemas: extracted.schemas
  }));

  if (run.storeRawHtml || run.storeRenderedHtml) {
    const rawSnapshot = snapshotHtml(run.storeRawHtml ? response.body : null, run.maxRawHtmlBytesPerUrl || 0);
    const renderedSnapshot = snapshotHtml(run.storeRenderedHtml ? render.renderedHtml : null, run.maxRawHtmlBytesPerUrl || 0);
    upsertPageSnapshot(db, {
      runId: run.id,
      pageUrl: normalizedFinalUrl,
      normalizedUrl: queueItem.normalizedUrl,
      rawHtml: rawSnapshot.html,
      renderedHtml: renderedSnapshot.html,
      rawHtmlBytes: rawSnapshot.bytes,
      renderedHtmlBytes: renderedSnapshot.bytes,
      rawHtmlTruncated: rawSnapshot.truncated,
      renderedHtmlTruncated: renderedSnapshot.truncated
    });
  }
  const persistenceDurationMs = performance.now() - persistenceStartedAt;
  const actualDecision = shouldRender && !budget.allowed ? 'render_budget_exhausted'
    : (!browser && run.usePlaywright && ['all', 'sample'].includes(run.playwrightMode) ? 'render_unavailable' : renderNeed.decision);
  runtimeMetrics?.recordUrl({
    url,
    pageType: extracted.page.pageType,
    rawContentClass: renderNeed.rawClass,
    renderStrategy: renderStrategy(run),
    renderNeed: renderNeed.decision,
    renderDecision: actualDecision,
    reason: { summary: renderNeed.reason },
    renderSignals: renderNeed.signals,
    renderNegativeSignals: renderNeed.negativeSignals,
    renderSignalContributions: renderNeed.signalContributions,
    renderRecommendationScore: renderNeed.recommendationScore,
    renderRecommendationThreshold: renderNeed.recommendationThreshold,
    renderCheckRequirements: renderNeed.checkRequirements,
    renderUnmetPrerequisites: renderNeed.unmetPrerequisites,
    renderConfidence: renderNeed.confidence,
    requestedCheckFamilies: renderNeed.requestedCheckFamilies,
    budgetStatus: budget,
    resultingBrowserRun: shouldRender && budget.allowed,
    rawFetchDurationMs,
    browserNavigationDurationMs: render.browserNavigationDurationMs,
    settlingDurationMs: shouldRender && budget.allowed ? render.settlingDurationMs : null,
    snapshotCount: shouldRender && budget.allowed ? render.renderSnapshotCount : null,
    extractionDurationMs,
    persistenceDurationMs,
    totalUrlDurationMs: performance.now() - totalStartedAt,
    rawHtmlBytes: response.sizeBytes,
    renderProvenanceBytes: shouldRender && budget.allowed ? serializedRenderProvenanceBytes(pageRecord) : null,
    networkRequestCount: render.networkRequestCount,
    failedRequestCount: render.failedRequestCount,
    finalSettlingStatus: render.settlingStatus,
    renderStatus: render.renderStatus,
    measurementError: render.navigationError
  });

  if (!['sitemap_only', 'template_sample'].includes(run.crawlMode) && queueItem.depth < run.maxDepth) {
    const currentTotal = totalCount(db, run.id);
    const remaining = Math.max(0, run.maxUrls - currentTotal);
    const internalPageLinks = extracted.links
      .filter((link) => link.linkType === 'internal')
      .filter((link) => isInternalUrl(link.normalizedTargetUrl, finalDomain))
      .filter((link) => isLikelyHtmlPage(link.normalizedTargetUrl))
      .slice(0, remaining)
      .map((link) => ({
        runId: run.id,
        url: link.linkedUrl || link.targetUrl || link.normalizedTargetUrl,
        depth: queueItem.depth + 1,
        sourceUrl: normalizedFinalUrl,
        sourceType: 'internal_link',
        priority: Math.max(0, 10 - queueItem.depth)
      }));

    const result = enqueueBatchWithPolicy(db, run, internalPageLinks);
    if (result.inserted > 0) {
      logRun(db, run.id, 'info', 'Internal URLs queued', {
        sourceUrl: normalizedFinalUrl,
        inserted: result.inserted
      });
    }
  }

  return { status: 'done', reason: 'HTML page crawled', httpAttempt };
}

export function shouldRetry(queueItem) {
  return queueItem.attempts < crawlerDefaults.maxAttempts;
}

export function metadataProvenanceIsComplete(run, renderingExecuted, render = {}, renderNeed = null) {
  const stableRenderedState = Boolean(renderingExecuted) && ['settled', 'content_remained_empty'].includes(render.settlingStatus);
  if (run?.usePlaywright && run?.playwrightMode === 'all') return stableRenderedState;
  if (run?.usePlaywright && run?.playwrightMode === 'gate') {
    if (renderingExecuted) return stableRenderedState;
    return renderNeed?.decision === RENDER_NEEDS.notRequired;
  }
  if (renderingExecuted) return stableRenderedState;
  return true;
}

function emptyPageRecord(values) {
  return {
    runId: values.runId,
    url: values.queueItem.url || values.queueItem.normalizedUrl,
    normalizedUrl: values.queueItem.normalizedUrl,
    finalUrl: values.finalUrl,
    depth: values.queueItem.depth,
    sourceUrl: values.queueItem.sourceUrl,
    statusCode: values.statusCode,
    initialStatusCode: values.initialStatusCode ?? values.statusCode,
    redirectChainJson: values.redirectChainJson || JSON.stringify([]),
    httpAttemptHistoryJson: values.httpAttemptHistoryJson || JSON.stringify([]),
    contentType: values.contentType,
    indexable: 0,
    noindex: 0,
    nofollow: 0,
    title: null,
    titleLength: 0,
    metaDescription: null,
    metaDescriptionLength: 0,
    h1Json: JSON.stringify([]),
    h1Count: 0,
    h2Json: JSON.stringify([]),
    canonical: null,
    canonicalStatus: null,
    htmlLang: null,
    viewport: null,
    metaCharset: null,
    hasHeaderUtf8: 0,
    hasMetaCharsetUtf8: 0,
    metaRobots: null,
    xRobotsTag: null,
    wordCountRaw: 0,
    wordCountRendered: null,
    rawTextLength: 0,
    renderedTextLength: null,
    visibleTextLength: 0,
    renderedVisibleTextLength: null,
    textFactsJson: JSON.stringify({ raw_text: null, visible_text: null, rendered_visible_text: null, structured_data_text: null, metadata_text: null }),
    rawHtmlSize: values.rawHtmlSize,
    internalLinksCount: 0,
    externalLinksCount: 0,
    uniqueInternalTargetsCount: 0,
    uniqueExternalTargetsCount: 0,
    nofollowLinksCount: 0,
    imageLinksCount: 0,
    storedLinkRowsCount: 0,
    linkRowsTruncated: 0,
    linkSamplesJson: JSON.stringify([]),
    inlinkCount: null,
    outlinkCount: null,
    schemaTypesJson: JSON.stringify([]),
    imagesCount: 0,
    imagesWithoutAltCount: 0,
    responseHeadersJson: values.responseHeadersJson,
    loadTimeMs: values.loadTimeMs,
    ttfbMs: values.ttfbMs,
    consoleErrorsJson: JSON.stringify([]),
    pageErrorsJson: JSON.stringify([]),
    requestFailuresJson: JSON.stringify([]),
    cspViolationsJson: JSON.stringify([]),
    navigationError: null,
    renderStatus: 'not_applicable',
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: 0,
    renderedLinksCount: null,
    ogJson: JSON.stringify({}),
    favicon: null,
    manifest: null,
    featureFlagsJson: JSON.stringify({}),
    pageType: 'other',
    hasTables: 0,
    hasLists: 0,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0,
    cruxLcp: null,
    cruxInp: null,
    cruxCls: null,
    cruxFcp: null,
    psiPerformanceScore: null,
    lighthousePerformanceScore: null,
    lighthouseSeoScore: null,
    importedSourceTypesJson: JSON.stringify([])
  };
}

function dedupeResources(resources) {
  const seen = new Set();
  const output = [];
  for (const resource of resources) {
    const key = `${resource.pageUrl}|${resource.resourceUrl}|${resource.resourceType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(resource);
  }
  return output;
}

export function shouldRenderPage(db, run, browser) {
  if (!browser || !run.usePlaywright || run.playwrightMode === 'off') return false;
  if (run.playwrightMode === 'all') return true;
  if (run.playwrightMode !== 'sample') return false;
  if (!run.playwrightSampleLimit || run.playwrightSampleLimit <= 0) return false;
  const result = db.prepare(`
    UPDATE runs
    SET renderedPagesCount = renderedPagesCount + 1
    WHERE id = ? AND renderedPagesCount < ?
  `).run(run.id, run.playwrightSampleLimit);
  return result.changes > 0;
}

export function emptyRenderResult(overrides = {}) {
  return {
    renderedTextLength: null,
    renderedVisibleTextLength: null,
    renderedVisibleTextHash: null,
    wordCountRendered: null,
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: 0,
    renderedLinksCount: null,
    consoleErrorsJson: JSON.stringify([]),
    pageErrorsJson: JSON.stringify([]),
    requestFailuresJson: JSON.stringify([]),
    cspViolationsJson: JSON.stringify([]),
    navigationError: null,
    renderStatus: 'not_executed',
    settlingStatus: 'not_executed',
    settlingDurationMs: null,
    renderSnapshotCount: 0,
    renderFingerprint: null,
    initialRenderedStateJson: null,
    settledRenderedStateJson: null,
    renderProvenanceJson: null,
    browserEventsJson: JSON.stringify([]),
    resources: [],
    renderedHtml: null,
    browserNavigationDurationMs: null,
    networkRequestCount: null,
    failedRequestCount: null,
    ...overrides
  };
}

function safeJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

export async function withRenderSlot(runId, limitInput, task) {
  const key = Number(runId);
  const limit = Math.max(1, Math.min(4, Number(limitInput || 1)));
  const state = renderSlots.get(key) || { active: 0, waiters: [] };
  renderSlots.set(key, state);
  if (state.active >= limit) await new Promise((resolve) => state.waiters.push(resolve));
  state.active += 1;
  try {
    return await task();
  } finally {
    state.active -= 1;
    const next = state.waiters.shift();
    if (next) next();
    else if (state.active === 0) renderSlots.delete(key);
  }
}

function mergeRenderedTextFacts(textFactsJson, render) {
  let facts = {};
  try {
    facts = textFactsJson ? JSON.parse(textFactsJson) : {};
  } catch {
    facts = {};
  }
  facts.rendered_visible_text = render.renderStatus === 'success'
    ? { length: render.renderedVisibleTextLength, hash: render.renderedVisibleTextHash }
    : null;
  return JSON.stringify(facts);
}

function renderStrategy(run) {
  if (!run?.usePlaywright || run.playwrightMode === 'off') return 'raw_only';
  if (run.playwrightMode === 'all') return 'browser_all';
  if (run.playwrightMode === 'gate') return 'deterministic_gate';
  return 'browser_sample';
}

function currentRenderBudget(db, run) {
  const usage = db.prepare(`
    SELECT
      COUNT(*) AS renderedUrls,
      COALESCE((SELECT renderDurationMs FROM run_runtime_metrics WHERE runId = ?),
        SUM(COALESCE(CASE WHEN json_valid(renderProvenanceJson) THEN json_extract(renderProvenanceJson, '$.navigationDurationMs') END, 0) + COALESCE(settlingDurationMs, 0)), 0) AS renderTimeMs,
      COALESCE(SUM(
        COALESCE(LENGTH(CAST(renderProvenanceJson AS BLOB)), 0)
        + COALESCE(LENGTH(CAST(initialRenderedStateJson AS BLOB)), 0)
        + COALESCE(LENGTH(CAST(settledRenderedStateJson AS BLOB)), 0)
        + COALESCE(LENGTH(CAST(effectiveDocumentStateJson AS BLOB)), 0)
        + COALESCE(LENGTH(CAST(browserEventsJson AS BLOB)), 0)
      ), 0) AS persistedBytes,
      COALESCE(SUM(CASE WHEN renderStatus = 'technical_error' THEN 1 ELSE 0 END), 0) AS browserFailures
    FROM pages WHERE runId = ? AND renderStatus IS NOT NULL AND renderStatus <> 'not_executed'
  `).get(run.id, run.id);
  const limits = [
    ['max_rendered_urls', run.maxRenderedUrls, usage.renderedUrls],
    ['max_total_render_time_ms', run.maxTotalRenderTimeMs, usage.renderTimeMs],
    ['max_persisted_render_bytes', run.maxPersistedRenderBytes, usage.persistedBytes],
    ['max_browser_failures', run.maxBrowserFailures, usage.browserFailures]
  ];
  const exhausted = limits.find(([name, limit, used]) => limit !== null && limit !== undefined
    && (name === 'max_browser_failures' ? Number(used) > 0 && Number(used) >= Number(limit) : Number(used) >= Number(limit)));
  return { allowed: !exhausted, reason: exhausted?.[0] || null, usage, limits: Object.fromEntries(limits.map(([name, limit]) => [name, limit ?? null])) };
}

function hydrationPayloadBytes(html) {
  const matches = String(html || '').match(/<script\b[^>]*(?:application\/json|application\/ld\+json|__NEXT_DATA__|__NUXT__|data-hydration)[^>]*>[\s\S]*?<\/script>/gi) || [];
  return matches.reduce((total, value) => total + Buffer.byteLength(value), 0);
}
