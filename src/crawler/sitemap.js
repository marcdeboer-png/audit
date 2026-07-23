import { urlPatternForPage } from '../analysis/templateClusterer.js';
import { insertDomainAsset, logRun, updateRun } from '../db/repositories.js';
import { detectPageType } from '../extractors/pageType.js';
import { totalCount } from '../queue/sqliteQueue.js';
import { fetchWithTimeout } from '../utils/http.js';
import {
  analyzeRobotsAsset,
  extractSitemapDirectives,
  extractValidSitemapUrls,
  parseSitemapDocument,
  ROBOTS_SITEMAP_VALIDATION_VERSION
} from '../utils/discoverySemantics.js';
import {
  analyzeLlmsTxtContent,
  classifyMeasurementAttempts,
  LLMS_TXT_VALIDATION_VERSION
} from '../utils/llmsTxt.js';
import { isInternalUrl, isLikelyHtmlPage, normalizeUrl } from '../utils/url.js';
import { enqueueBatchWithPolicy, enqueueUrlWithPolicy } from './crawlPolicy.js';
import { crawlerDefaults } from './defaults.js';

export async function discoverDomainAssets(db, run, finalStartUrl, robotsContent = '') {
  const origin = new URL(finalStartUrl).origin;
  const defaultSitemaps = new Set([`${origin}/sitemap.xml`]);
  const robotsUrl = `${origin}/robots.txt`;
  const robotsDirectives = extractSitemapDirectives(robotsContent, robotsUrl);
  const robotsSitemaps = new Set(extractValidSitemapUrls(robotsContent, robotsUrl));

  const fetchOptions = { userAgent: run.userAgent };
  await fetchTextAsset(db, run.id, 'llms', `${origin}/llms.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'llms_full', `${origin}/llms-full.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/index.md`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/index.md.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/README.md`, run.requestTimeoutMs, fetchOptions);

  const state = {
    seenSitemaps: new Set(),
    seenListedUrls: new Set(),
    filesAttempted: 0,
    filesProcessed: 0,
    validFiles: 0,
    invalidFiles: 0,
    invalidRequiredFiles: 0,
    failedFiles: 0,
    defaultCandidateFailures: 0,
    childReferences: 0,
    duplicateSitemapReferences: 0,
    cyclesDetected: 0,
    totalListedUrls: 0,
    uniqueListedUrls: 0,
    duplicateListedUrls: 0,
    externalListedUrls: 0,
    invalidListedUrls: 0,
    limitReasons: new Set(),
    urlsDiscovered: 0,
    urlsQueued: 0,
    maxSitemaps: Number(run.maxSitemaps || crawlerDefaults.maxSitemaps),
    maxSitemapUrls: run.maxSitemapUrls === null || run.maxSitemapUrls === undefined ? null : Number(run.maxSitemapUrls),
    sitemapBatchSize: Number(run.sitemapBatchSize || crawlerDefaults.sitemapBatchSize),
    templateSampleGroups: new Map(),
    templateSampleUrlsPerPattern: Number(run.sampleUrlsPerTemplate || crawlerDefaults.sampleUrlsPerTemplate)
  };

  for (const sitemapUrl of robotsSitemaps) {
    await processSitemap(db, run, sitemapUrl, finalStartUrl, state, 0, 'robots_sitemap', new Set());
  }
  for (const sitemapUrl of defaultSitemaps) {
    await processSitemap(db, run, sitemapUrl, finalStartUrl, state, 0, 'sitemap', new Set());
  }
  const discovery = sitemapDiscoverySummary(state, robotsDirectives);
  updateRun(db, run.id, {
    currentSitemapUrl: null,
    sitemapUrlsDiscovered: state.urlsDiscovered,
    sitemapUrlsQueued: state.urlsQueued,
    sitemapFilesProcessed: state.filesProcessed,
    sitemapDiscoveryJson: JSON.stringify(discovery)
  });
  return discovery;
}

export async function fetchTextAsset(db, runId, type, url, timeoutMs = 10000, options = {}) {
  const maximumAttempts = ['llms', 'robots'].includes(type) ? 2 : 1;
  const measurementAttempts = [];
  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const started = Date.now();
    try {
      response = await fetchWithTimeout(url, {
        timeoutMs: timeoutMs || 10000,
        maxBytes: 1024 * 1024,
        userAgent: options.userAgent
      });
      measurementAttempts.push(compactAssetAttempt(response, attempt, Date.now() - started));
      lastError = null;
    } catch (error) {
      lastError = error;
      measurementAttempts.push({
        attempt,
        method: 'GET',
        initialStatusCode: null,
        finalStatusCode: null,
        finalUrl: url,
        redirectChain: [],
        contentType: '',
        responseBytes: 0,
        truncated: false,
        durationMs: Date.now() - started,
        networkError: error.message
      });
    }
    if (!shouldRetryAsset(type, response, lastError, attempt, maximumAttempts)) break;
    await wait(options.retryDelayMs ?? 200);
  }

  if (response) {
    const measurementState = ['llms', 'robots'].includes(type)
      ? classifyMeasurementAttempts(measurementAttempts)
      : 'confirmed';
    const utf8Valid = validUtf8(response.buffer);
    const llmsTxt = type === 'llms'
      ? analyzeLlmsTxtContent({
          url,
          body: response.body,
          contentType: response.contentType,
          utf8Valid,
          bodyBytes: response.sizeBytes
        })
      : undefined;
    insertDomainAsset(db, {
      runId,
      type,
      url,
      statusCode: response.statusCode,
      content: type === 'llms' ? null : response.body.slice(0, 1024 * 1024),
      responseHeadersJson: JSON.stringify(response.headers).slice(0, 20000),
      metadataJson: JSON.stringify({
        logicVersion: type === 'llms' ? LLMS_TXT_VALIDATION_VERSION : ROBOTS_SITEMAP_VALIDATION_VERSION,
        initialStatusCode: response.initialStatusCode,
        finalStatusCode: response.statusCode,
        finalUrl: response.url,
        redirectChain: response.redirectChain,
        contentType: response.contentType,
        sizeBytes: response.sizeBytes,
        truncated: response.truncated,
        utf8Valid,
        measurementState,
        measurementAttempts,
        llmsTxt,
        robots: type === 'robots' ? analyzeRobotsAsset({
          url,
          statusCode: response.statusCode,
          content: response.body,
          responseHeadersJson: JSON.stringify(response.headers),
          metadataJson: JSON.stringify({
            initialStatusCode: response.initialStatusCode,
            finalStatusCode: response.statusCode,
            finalUrl: response.url,
            redirectChain: response.redirectChain,
            contentType: response.contentType,
            truncated: response.truncated,
            measurementState,
            measurementAttempts
          })
        }) : undefined
      })
    });
    return response;
  }

  insertDomainAsset(db, {
    runId,
    type,
    url,
    statusCode: null,
    content: null,
    responseHeadersJson: JSON.stringify({ error: lastError?.message || 'request_failed' }),
    metadataJson: JSON.stringify({
      logicVersion: type === 'llms' ? LLMS_TXT_VALIDATION_VERSION : ROBOTS_SITEMAP_VALIDATION_VERSION,
      fetchError: lastError?.message || 'request_failed',
      measurementState: 'technical_error',
      measurementAttempts
    })
  });
  return null;
}

function compactAssetAttempt(response, attempt, durationMs) {
  return {
    attempt,
    method: 'GET',
    initialStatusCode: response.initialStatusCode,
    finalStatusCode: response.statusCode,
    finalUrl: response.url,
    redirectChain: (response.redirectChain || []).slice(0, 10),
    contentType: response.contentType || '',
    responseBytes: response.sizeBytes,
    truncated: Boolean(response.truncated),
    durationMs
  };
}

function shouldRetryAsset(type, response, error, attempt, maximumAttempts) {
  if (!['llms', 'robots'].includes(type) || attempt >= maximumAttempts) return false;
  if (error || !response) return true;
  return response.statusCode === 429 || (response.statusCode >= 500 && response.statusCode <= 599);
}

function validUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

async function processSitemap(db, run, sitemapUrl, finalStartUrl, state, depth, queueSourceType, ancestors) {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl) {
    state.invalidFiles += 1;
    if (queueSourceType === 'robots_sitemap' || depth > 0) state.invalidRequiredFiles += 1;
    return;
  }
  if (ancestors.has(normalizedSitemapUrl)) {
    state.cyclesDetected += 1;
    state.limitReasons.add('sitemap_index_cycle');
    return;
  }
  if (state.seenSitemaps.has(normalizedSitemapUrl)) {
    state.duplicateSitemapReferences += 1;
    return;
  }
  if (depth > 4) {
    state.limitReasons.add('maximum_recursion_depth');
    return;
  }
  if (state.filesAttempted >= state.maxSitemaps) {
    state.limitReasons.add('maximum_sitemap_files');
    logRun(db, run.id, 'warning', 'Sitemap file limit reached', {
      maxSitemaps: state.maxSitemaps,
      skippedUrl: normalizedSitemapUrl
    });
    return;
  }
  state.seenSitemaps.add(normalizedSitemapUrl);
  state.filesAttempted += 1;
  updateRun(db, run.id, { currentSitemapUrl: normalizedSitemapUrl });

  let response;
  try {
    response = await fetchWithTimeout(normalizedSitemapUrl, { timeoutMs: run.requestTimeoutMs || 15000, maxBytes: 50 * 1024 * 1024, abortOnMaxBytes: true, userAgent: run.userAgent });
  } catch (error) {
    state.failedFiles += 1;
    if (queueSourceType === 'sitemap' && depth === 0) state.defaultCandidateFailures += 1;
    insertDomainAsset(db, {
      runId: run.id,
      type: 'sitemap',
      url: normalizedSitemapUrl,
      statusCode: null,
      content: '',
      responseHeadersJson: JSON.stringify({ error: error.message }),
      metadataJson: JSON.stringify({
        logicVersion: ROBOTS_SITEMAP_VALIDATION_VERSION,
        sourceType: queueSourceType,
        depth,
        fetchError: error.message,
        sitemap: { valid: false, documentType: 'unavailable', parseError: 'fetch_failed' }
      })
    });
    logRun(db, run.id, 'warning', 'Sitemap fetch failed', { url: normalizedSitemapUrl, error: error.message });
    return;
  }
  state.filesProcessed += 1;
  updateRun(db, run.id, {
    sitemapFilesProcessed: state.filesProcessed,
    currentSitemapUrl: normalizedSitemapUrl
  });

  const parsed = response.truncated
    ? { valid: false, documentType: 'invalid', parseError: 'download_size_limit_exceeded', locationCount: 0, uniqueLocationCount: 0, duplicateLocationCount: 0, compressedBytes: response.sizeBytes, uncompressedBytes: null, protocolLimitExceeded: false }
    : parseSitemapDocument(response.buffer || response.body || '', { url: normalizedSitemapUrl });
  const requiredSource = queueSourceType === 'robots_sitemap' || depth > 0;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (requiredSource) state.failedFiles += 1;
    else state.defaultCandidateFailures += 1;
  } else if (!parsed.valid) {
    state.invalidFiles += 1;
    if (requiredSource) state.invalidRequiredFiles += 1;
  } else {
    state.validFiles += 1;
  }

  insertDomainAsset(db, {
    runId: run.id,
    type: 'sitemap',
    url: normalizedSitemapUrl,
    statusCode: response.statusCode,
    content: response.body.slice(0, 1024 * 1024),
    responseHeadersJson: JSON.stringify(response.headers).slice(0, 20000),
    metadataJson: JSON.stringify({
      logicVersion: ROBOTS_SITEMAP_VALIDATION_VERSION,
      sourceType: queueSourceType,
      depth,
      initialStatusCode: response.initialStatusCode,
      finalStatusCode: response.statusCode,
      finalUrl: response.url,
      redirectChain: response.redirectChain,
      contentType: response.contentType,
      sizeBytes: response.sizeBytes,
      truncated: response.truncated,
      sitemap: {
        valid: parsed.valid,
        documentType: parsed.documentType,
        parseError: parsed.parseError,
        locationCount: parsed.locationCount || 0,
        uniqueLocationCount: parsed.uniqueLocationCount || 0,
        duplicateLocationCount: parsed.duplicateLocationCount || 0,
        compressedBytes: parsed.compressedBytes,
        uncompressedBytes: parsed.uncompressedBytes,
        protocolLimitExceeded: Boolean(parsed.protocolLimitExceeded)
      }
    })
  });

  if (response.statusCode < 200 || response.statusCode >= 300 || !parsed.valid) return;
  if (parsed.protocolLimitExceeded) state.limitReasons.add('sitemap_protocol_url_limit_exceeded');

  if (parsed.documentType === 'sitemapindex') {
    state.duplicateSitemapReferences += parsed.duplicateLocationCount || 0;
    let childCount = 0;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(normalizedSitemapUrl);
    for (const childUrl of parsed.uniqueLocations) {
      if (state.filesAttempted >= state.maxSitemaps) {
        state.limitReasons.add('maximum_sitemap_files');
        break;
      }
      childCount += 1;
      state.childReferences += 1;
      await processSitemap(db, run, childUrl, finalStartUrl, state, depth + 1, queueSourceType, nextAncestors);
    }
    logRun(db, run.id, 'info', 'Sitemap index processed', {
      sitemapUrl: normalizedSitemapUrl,
      childSitemaps: childCount,
      filesProcessed: state.filesProcessed
    });
    return;
  }

  state.totalListedUrls += parsed.duplicateLocationCount || 0;
  state.duplicateListedUrls += parsed.duplicateLocationCount || 0;
  await processUrlSet(db, run, normalizedSitemapUrl, finalStartUrl, state, queueSourceType, parsed.uniqueLocations);
}

async function processUrlSet(db, run, normalizedSitemapUrl, finalStartUrl, state, queueSourceType, locations) {
  let discoveredInFile = 0;
  let queuedInFile = 0;
  let batch = [];

  const flush = () => {
    if (!batch.length || run.crawlMode === 'internal_links_only') {
      batch = [];
      return 0;
    }
    if (run.crawlMode === 'template_sample') {
      let inserted = 0;
      for (const url of batch) {
        inserted += queueTemplateSampleUrl(db, run, state, url, normalizedSitemapUrl, queueSourceType);
      }
      batch = [];
      queuedInFile += inserted;
      updateRun(db, run.id, {
        sitemapUrlsDiscovered: state.urlsDiscovered,
        sitemapUrlsQueued: state.urlsQueued
      });
      return inserted;
    }
    const remaining = Math.max(0, run.maxUrls - totalCount(db, run.id));
    if (!remaining) {
      batch = [];
      return 0;
    }
    const rows = batch.slice(0, remaining).map((url) => ({
      runId: run.id,
      url,
      depth: 0,
      sourceUrl: normalizedSitemapUrl,
      sourceType: queueSourceType,
      priority: 20
    }));
    batch = [];
    const result = enqueueBatchWithPolicy(db, run, rows);
    state.urlsQueued += result.inserted;
    queuedInFile += result.inserted;
    updateRun(db, run.id, {
      sitemapUrlsDiscovered: state.urlsDiscovered,
      sitemapUrlsQueued: state.urlsQueued
    });
    return result.inserted;
  };

  for (const url of locations) {
    state.totalListedUrls += 1;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch {
      state.invalidListedUrls += 1;
      continue;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      state.invalidListedUrls += 1;
      continue;
    }
    if (!isInternalUrl(url, finalStartUrl)) {
      state.externalListedUrls += 1;
      continue;
    }
    const normalizedListedUrl = normalizeUrl(url);
    if (!normalizedListedUrl) {
      state.invalidListedUrls += 1;
      continue;
    }
    if (state.seenListedUrls.has(normalizedListedUrl)) {
      state.duplicateListedUrls += 1;
      continue;
    }
    state.seenListedUrls.add(normalizedListedUrl);
    state.uniqueListedUrls += 1;
    if (state.maxSitemapUrls !== null && state.urlsDiscovered >= state.maxSitemapUrls) {
      state.limitReasons.add('maximum_sitemap_urls');
      continue;
    }
    state.urlsDiscovered += 1;
    discoveredInFile += 1;
    batch.push(normalizedListedUrl);

    if (batch.length >= state.sitemapBatchSize) flush();
  }
  flush();

  if (run.crawlMode === 'internal_links_only') {
    logRun(db, run.id, 'info', 'Sitemap URLs discovered but not queued because crawlMode=internal_links_only', {
      sitemapUrl: normalizedSitemapUrl,
      discovered: discoveredInFile
    });
    return;
  }

  if (run.crawlMode === 'template_sample') {
    logRun(db, run.id, 'info', 'Sitemap URLs template-sampled', {
      sitemapUrl: normalizedSitemapUrl,
      discovered: discoveredInFile,
      queued: queuedInFile,
      totalDiscovered: state.urlsDiscovered,
      totalQueued: state.urlsQueued,
      templatePatterns: state.templateSampleGroups.size,
      samplesPerPattern: state.templateSampleUrlsPerPattern
    });
    return;
  }

  logRun(db, run.id, 'info', 'Sitemap URLs processed', {
    sitemapUrl: normalizedSitemapUrl,
    discovered: discoveredInFile,
    queued: queuedInFile,
    totalDiscovered: state.urlsDiscovered,
    totalQueued: state.urlsQueued
  });
}

function queueTemplateSampleUrl(db, run, state, url, sourceUrl, sourceType) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl || !isLikelyHtmlPage(normalizedUrl)) return 0;
  if (totalCount(db, run.id) >= run.maxUrls) return 0;

  const pageType = detectPageType({ url: normalizedUrl });
  const urlPattern = urlPatternForPage({ url: normalizedUrl, finalUrl: normalizedUrl, pageType, schemaTypes: [] });
  const clusterKey = `${pageType || 'other'}:${urlPattern}`;
  const current = state.templateSampleGroups.get(clusterKey) || new Set();
  if (current.has(normalizedUrl) || current.size >= state.templateSampleUrlsPerPattern) return 0;

  const result = enqueueUrlWithPolicy(db, run, {
    url: normalizedUrl,
    depth: 0,
    sourceUrl,
    sourceType: `${sourceType}_template_sample`,
    priority: 30
  });
  if (!result.inserted) return 0;

  current.add(normalizedUrl);
  state.templateSampleGroups.set(clusterKey, current);
  state.urlsQueued += 1;
  return 1;
}

export function isSitemapIndex(xml) {
  return parseSitemapDocument(xml).documentType === 'sitemapindex';
}

export function extractLocValues(xml) {
  return parseSitemapDocument(xml).locations || [];
}

function sitemapDiscoverySummary(state, robotsDirectives) {
  const validRobotsDirectives = robotsDirectives.filter((item) => item.valid).length;
  const invalidRobotsDirectives = robotsDirectives.length - validRobotsDirectives;
  const limitReasons = [...state.limitReasons].sort();
  return {
    logicVersion: ROBOTS_SITEMAP_VALIDATION_VERSION,
    discoveryComplete: limitReasons.length === 0 && state.failedFiles === 0 && state.invalidRequiredFiles === 0 && state.cyclesDetected === 0,
    filesAttempted: state.filesAttempted,
    filesProcessed: state.filesProcessed,
    validFiles: state.validFiles,
    invalidFiles: state.invalidFiles,
    invalidRequiredFiles: state.invalidRequiredFiles,
    failedFiles: state.failedFiles,
    defaultCandidateFailures: state.defaultCandidateFailures,
    childReferences: state.childReferences,
    duplicateSitemapReferences: state.duplicateSitemapReferences,
    cyclesDetected: state.cyclesDetected,
    robotsSitemapDirectives: robotsDirectives.length,
    validRobotsSitemapDirectives: validRobotsDirectives,
    invalidRobotsSitemapDirectives: invalidRobotsDirectives,
    totalListedUrls: state.totalListedUrls,
    uniqueListedUrls: state.uniqueListedUrls,
    duplicateListedUrls: state.duplicateListedUrls,
    externalListedUrls: state.externalListedUrls,
    invalidListedUrls: state.invalidListedUrls,
    plannedSitemapUrls: state.urlsDiscovered,
    queuedSitemapUrls: state.urlsQueued,
    limitReasons,
    sampleStrategy: state.maxSitemapUrls === null ? 'all_internal_urls_subject_to_run_limits' : 'deterministic_document_order_limit',
    maxSitemaps: state.maxSitemaps,
    maxSitemapUrls: state.maxSitemapUrls
  };
}
