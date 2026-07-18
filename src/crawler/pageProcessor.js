import { extractHtml } from '../extractors/htmlExtractor.js';
import { renderPage } from '../extractors/renderExtractor.js';
import { insertPage, logRun, replacePageArtifacts, upsertPageSnapshot } from '../db/repositories.js';
import { totalCount } from '../queue/sqliteQueue.js';
import { fetchWithTimeout, selectedHeaders } from '../utils/http.js';
import { isInternalUrl, isLikelyHtmlPage, normalizeUrl } from '../utils/url.js';
import { enqueueBatchWithPolicy } from './crawlPolicy.js';
import { createHttpStatusError } from './retryPolicy.js';
import { crawlerDefaults } from './defaults.js';
import { filterArtifactsForStorage, snapshotHtml } from '../storage/retention.js';

const RETRY_STATUS_CODES = new Set(crawlerDefaults.retryStatusCodes);

export async function processQueueItem(db, run, project, queueItem, browser, robots) {
  const url = queueItem.normalizedUrl;
  const finalDomain = project.finalDomain;

  if (run.respectRobotsTxt && robots && robots.isAllowed(url, run.robotsUserAgent || crawlerDefaults.robotsUserAgent) === false) {
    return { status: 'skipped', reason: 'Blocked by robots.txt' };
  }

  const response = await fetchWithTimeout(url, { timeoutMs: run.requestTimeoutMs || 15000, maxBytes: 5 * 1024 * 1024, userAgent: run.userAgent });
  if (RETRY_STATUS_CODES.has(Number(response.statusCode))) {
    throw createHttpStatusError(response.statusCode, url);
  }
  const normalizedFinalUrl = normalizeUrl(response.url) || url;
  const responseHeadersJson = run.storeResponseHeaders ? JSON.stringify(selectedHeaders(response.headers)).slice(0, 20000) : null;
  const contentType = response.contentType || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);

  if (!isHtml) {
    insertPage(db, emptyPageRecord({
      runId: run.id,
      queueItem,
      finalUrl: normalizedFinalUrl,
      statusCode: response.statusCode,
      initialStatusCode: response.initialStatusCode,
      redirectChainJson: JSON.stringify(response.redirectChain || []),
      contentType,
      responseHeadersJson,
      rawHtmlSize: response.sizeBytes,
      loadTimeMs: response.loadTimeMs,
      ttfbMs: response.ttfbMs
    }));
    return { status: 'done', reason: 'Non-HTML response recorded' };
  }

  const extracted = extractHtml(response.body, normalizedFinalUrl, finalDomain, response.headers);
  const shouldRender = shouldRenderPage(db, run, browser);
  const render = shouldRender
    ? await renderPage(browser, normalizedFinalUrl, finalDomain, run.requestTimeoutMs || 15000, run.userAgent, {
        captureHtml: Boolean(run.storeRenderedHtml)
      })
    : emptyRenderResult();
  const resources = dedupeResources([...extracted.resources, ...render.resources]);

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
    renderStatus: render.renderStatus
  };

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
        url: link.normalizedTargetUrl,
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

  return { status: 'done', reason: 'HTML page crawled' };
}

export function shouldRetry(queueItem) {
  return queueItem.attempts < crawlerDefaults.maxAttempts;
}

function emptyPageRecord(values) {
  return {
    runId: values.runId,
    url: values.queueItem.normalizedUrl,
    normalizedUrl: values.queueItem.normalizedUrl,
    finalUrl: values.finalUrl,
    depth: values.queueItem.depth,
    sourceUrl: values.queueItem.sourceUrl,
    statusCode: values.statusCode,
    initialStatusCode: values.initialStatusCode ?? values.statusCode,
    redirectChainJson: values.redirectChainJson || JSON.stringify([]),
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

function shouldRenderPage(db, run, browser) {
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

function emptyRenderResult() {
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
    resources: [],
    renderedHtml: null
  };
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
