import zlib from 'node:zlib';
import { urlPatternForPage } from '../analysis/templateClusterer.js';
import { insertDomainAsset, logRun, updateRun } from '../db/repositories.js';
import { detectPageType } from '../extractors/pageType.js';
import { totalCount } from '../queue/sqliteQueue.js';
import { fetchWithTimeout } from '../utils/http.js';
import { extractSitemapUrls } from '../utils/robots.js';
import { isInternalUrl, isLikelyHtmlPage, normalizeUrl } from '../utils/url.js';
import { enqueueBatchWithPolicy, enqueueUrlWithPolicy } from './crawlPolicy.js';
import { crawlerDefaults } from './defaults.js';

export async function discoverDomainAssets(db, run, finalStartUrl, robotsContent = '') {
  const origin = new URL(finalStartUrl).origin;
  const defaultSitemaps = new Set([`${origin}/sitemap.xml`]);
  const robotsSitemaps = new Set(extractSitemapUrls(robotsContent));

  const fetchOptions = { userAgent: run.userAgent };
  await fetchTextAsset(db, run.id, 'llms', `${origin}/llms.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'llms_full', `${origin}/llms-full.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/index.md`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/index.md.txt`, run.requestTimeoutMs, fetchOptions);
  await fetchTextAsset(db, run.id, 'other', `${origin}/README.md`, run.requestTimeoutMs, fetchOptions);

  const state = {
    seenSitemaps: new Set(),
    filesProcessed: 0,
    urlsDiscovered: 0,
    urlsQueued: 0,
    maxSitemaps: Number(run.maxSitemaps || crawlerDefaults.maxSitemaps),
    maxSitemapUrls: run.maxSitemapUrls === null || run.maxSitemapUrls === undefined ? null : Number(run.maxSitemapUrls),
    sitemapBatchSize: Number(run.sitemapBatchSize || crawlerDefaults.sitemapBatchSize),
    templateSampleGroups: new Map(),
    templateSampleUrlsPerPattern: Number(run.sampleUrlsPerTemplate || crawlerDefaults.sampleUrlsPerTemplate)
  };

  for (const sitemapUrl of defaultSitemaps) {
    await processSitemap(db, run, sitemapUrl, finalStartUrl, state, 0, 'sitemap');
  }
  for (const sitemapUrl of robotsSitemaps) {
    await processSitemap(db, run, sitemapUrl, finalStartUrl, state, 0, 'robots_sitemap');
  }
  updateRun(db, run.id, {
    currentSitemapUrl: null,
    sitemapUrlsDiscovered: state.urlsDiscovered,
    sitemapUrlsQueued: state.urlsQueued,
    sitemapFilesProcessed: state.filesProcessed
  });
}

export async function fetchTextAsset(db, runId, type, url, timeoutMs = 10000, options = {}) {
  try {
    const response = await fetchWithTimeout(url, { timeoutMs: timeoutMs || 10000, maxBytes: 1024 * 1024, userAgent: options.userAgent });
    insertDomainAsset(db, {
      runId,
      type,
      url,
      statusCode: response.statusCode,
      content: response.body.slice(0, 1024 * 1024),
      responseHeadersJson: JSON.stringify(response.headers).slice(0, 20000)
    });
    return response;
  } catch (error) {
    insertDomainAsset(db, {
      runId,
      type,
      url,
      statusCode: null,
      content: '',
      responseHeadersJson: JSON.stringify({ error: error.message })
    });
    return null;
  }
}

async function processSitemap(db, run, sitemapUrl, finalStartUrl, state, depth, queueSourceType) {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl || state.seenSitemaps.has(normalizedSitemapUrl) || depth > 4) return;
  if (state.filesProcessed >= state.maxSitemaps) {
    logRun(db, run.id, 'warning', 'Sitemap file limit reached', {
      maxSitemaps: state.maxSitemaps,
      skippedUrl: normalizedSitemapUrl
    });
    return;
  }
  state.seenSitemaps.add(normalizedSitemapUrl);
  updateRun(db, run.id, { currentSitemapUrl: normalizedSitemapUrl });

  let response;
  try {
    response = await fetchWithTimeout(normalizedSitemapUrl, { timeoutMs: run.requestTimeoutMs || 15000, maxBytes: 50 * 1024 * 1024, userAgent: run.userAgent });
  } catch (error) {
    insertDomainAsset(db, {
      runId: run.id,
      type: 'sitemap',
      url: normalizedSitemapUrl,
      statusCode: null,
      content: '',
      responseHeadersJson: JSON.stringify({ error: error.message })
    });
    logRun(db, run.id, 'warning', 'Sitemap fetch failed', { url: normalizedSitemapUrl, error: error.message });
    return;
  }
  state.filesProcessed += 1;
  updateRun(db, run.id, {
    sitemapFilesProcessed: state.filesProcessed,
    currentSitemapUrl: normalizedSitemapUrl
  });

  const xml = sitemapBody(response, normalizedSitemapUrl);

  insertDomainAsset(db, {
    runId: run.id,
    type: 'sitemap',
    url: normalizedSitemapUrl,
    statusCode: response.statusCode,
    content: xml.slice(0, 1024 * 1024),
    responseHeadersJson: JSON.stringify(response.headers).slice(0, 20000)
  });

  if (response.statusCode < 200 || response.statusCode >= 300 || !xml) return;

  if (isSitemapIndex(xml)) {
    let childCount = 0;
    for (const childUrl of extractLocValues(xml)) {
      childCount += 1;
      await processSitemap(db, run, childUrl, finalStartUrl, state, depth + 1, queueSourceType);
      if (state.filesProcessed >= state.maxSitemaps) break;
    }
    logRun(db, run.id, 'info', 'Sitemap index processed', {
      sitemapUrl: normalizedSitemapUrl,
      childSitemaps: childCount,
      filesProcessed: state.filesProcessed
    });
    return;
  }

  await processUrlSet(db, run, normalizedSitemapUrl, finalStartUrl, state, queueSourceType, xml);
}

async function processUrlSet(db, run, normalizedSitemapUrl, finalStartUrl, state, queueSourceType, xml) {
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

  for (const url of extractLocValues(xml)) {
    if (!isInternalUrl(url, finalStartUrl)) continue;
    if (state.maxSitemapUrls !== null && state.urlsDiscovered >= state.maxSitemapUrls) break;

    state.urlsDiscovered += 1;
    discoveredInFile += 1;
    batch.push(url);

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
  return /<\s*(?:[\w.-]+:)?sitemapindex[\s>]/i.test(xml);
}

export function extractLocValues(xml) {
  const output = [];
  const pattern = /<\s*(?:[\w.-]+:)?loc\s*>\s*([\s\S]*?)\s*<\s*\/\s*(?:[\w.-]+:)?loc\s*>/gi;
  let match;
  while ((match = pattern.exec(xml))) {
    const value = decodeXmlText(match[1].trim());
    if (value) output.push(value);
  }
  return output;
}

function sitemapBody(response, url) {
  const headers = response.headers || {};
  const contentType = headers['content-type'] || response.contentType || '';
  const isGzip = /\.gz($|\?)/i.test(url) || /gzip|x-gzip/i.test(contentType);
  if (!isGzip) return response.body || '';

  try {
    return zlib.gunzipSync(response.buffer || Buffer.from(response.body || '', 'binary')).toString('utf8');
  } catch {
    return response.body || '';
  }
}

function decodeXmlText(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}
