import { normalizeUrl } from '../utils/url.js';
import { collectSchemaTypes } from '../extractors/structuredData.js';

export function pageRecordFromFact(runId, fact = {}) {
  const url = normalizeUrl(fact.url || fact.finalUrl) || String(fact.url || fact.finalUrl || '').trim();
  const finalUrl = normalizeUrl(fact.finalUrl || url) || url;
  const statusCode = nullableNumber(fact.statusCode);
  const contentType = fact.contentType || (statusCode && statusCode < 300 ? 'text/html' : null);
  const metaRobots = nullableText(fact.metaRobots || fact.robots);
  const xRobotsTag = nullableText(fact.xRobotsTag);
  const robotsText = `${metaRobots || ''} ${xRobotsTag || ''}`.toLowerCase();
  const noindex = fact.noindex !== undefined ? boolInt(fact.noindex) : robotsText.includes('noindex') ? 1 : 0;
  const nofollow = fact.nofollow !== undefined ? boolInt(fact.nofollow) : robotsText.includes('nofollow') ? 1 : 0;
  const indexable = fact.indexable !== undefined
    ? boolInt(fact.indexable)
    : noindex ? 0 : statusCode && statusCode >= 400 ? 0 : 1;
  const schemaTypes = normalizeSchemaTypes(fact.schemaTypes);
  const h1 = normalizeList(fact.h1 || fact.h1Text);
  const h2 = normalizeList(fact.h2 || fact.h2Text);
  const title = nullableText(fact.title);
  const metaDescription = nullableText(fact.metaDescription);

  return {
    runId,
    url,
    normalizedUrl: normalizeUrl(fact.normalizedUrl || finalUrl || url) || url,
    finalUrl,
    depth: Math.max(0, nullableNumber(fact.depth) ?? 0),
    sourceUrl: nullableText(fact.sourceUrl),
    statusCode,
    contentType,
    indexable,
    noindex,
    nofollow,
    title,
    titleLength: nullableNumber(fact.titleLength) ?? (title ? title.length : 0),
    metaDescription,
    metaDescriptionLength: nullableNumber(fact.metaDescriptionLength) ?? (metaDescription ? metaDescription.length : 0),
    h1Json: JSON.stringify(h1),
    h1Count: nullableNumber(fact.h1Count) ?? h1.length,
    h2Json: JSON.stringify(h2),
    canonical: normalizeUrl(fact.canonical || fact.canonicalUrl) || nullableText(fact.canonical),
    canonicalStatus: nullableText(fact.canonicalStatus),
    htmlLang: nullableText(fact.htmlLang),
    viewport: nullableText(fact.viewport),
    metaCharset: nullableText(fact.metaCharset),
    hasHeaderUtf8: boolInt(fact.hasHeaderUtf8),
    hasMetaCharsetUtf8: boolInt(fact.hasMetaCharsetUtf8),
    metaRobots,
    xRobotsTag,
    wordCountRaw: nullableNumber(fact.wordCount ?? fact.wordCountRaw) ?? 0,
    wordCountRendered: nullableNumber(fact.wordCountRendered),
    rawTextLength: nullableNumber(fact.rawTextLength) ?? 0,
    renderedTextLength: nullableNumber(fact.renderedTextLength),
    rawHtmlSize: nullableNumber(fact.rawHtmlSize ?? fact.sizeBytes),
    internalLinksCount: nullableNumber(fact.internalLinksCount ?? fact.outlinkCount) ?? 0,
    externalLinksCount: nullableNumber(fact.externalLinksCount) ?? 0,
    uniqueInternalTargetsCount: nullableNumber(fact.uniqueInternalTargetsCount) ?? nullableNumber(fact.internalLinksCount ?? fact.outlinkCount) ?? 0,
    uniqueExternalTargetsCount: nullableNumber(fact.uniqueExternalTargetsCount) ?? nullableNumber(fact.externalLinksCount) ?? 0,
    nofollowLinksCount: nullableNumber(fact.nofollowLinksCount) ?? 0,
    imageLinksCount: nullableNumber(fact.imageLinksCount) ?? 0,
    storedLinkRowsCount: nullableNumber(fact.storedLinkRowsCount) ?? 0,
    linkRowsTruncated: boolInt(fact.linkRowsTruncated),
    linkSamplesJson: JSON.stringify(normalizeList(fact.linkSamples)),
    inlinkCount: nullableNumber(fact.inlinkCount),
    outlinkCount: nullableNumber(fact.outlinkCount ?? fact.internalLinksCount),
    schemaTypesJson: JSON.stringify(schemaTypes),
    imagesCount: nullableNumber(fact.imageCount ?? fact.imagesCount) ?? 0,
    imagesWithoutAltCount: nullableNumber(fact.imagesMissingAltCount ?? fact.imagesWithoutAltCount) ?? 0,
    responseHeadersJson: fact.responseHeadersJson || null,
    loadTimeMs: nullableNumber(fact.loadTimeMs),
    ttfbMs: nullableNumber(fact.ttfbMs),
    consoleErrorsJson: JSON.stringify(normalizeList(fact.consoleErrors)),
    renderedH1Json: JSON.stringify(normalizeList(fact.renderedH1)),
    renderedH1Count: nullableNumber(fact.renderedH1Count) ?? 0,
    renderedLinksCount: nullableNumber(fact.renderedLinksCount),
    ogJson: JSON.stringify(fact.og || {}),
    favicon: nullableText(fact.favicon),
    manifest: nullableText(fact.manifest),
    featureFlagsJson: JSON.stringify(fact.featureFlags || {}),
    pageType: nullableText(fact.pageType) || inferPageType(url, schemaTypes),
    pageTypeConfidence: nullableText(fact.pageTypeConfidence),
    pageTypeSignalsJson: JSON.stringify(normalizeList(fact.pageTypeSignals)),
    hasTables: boolInt(fact.hasTables),
    hasLists: boolInt(fact.hasLists),
    hasFaqPattern: boolInt(fact.hasFaqPattern),
    hasVisibleDate: boolInt(fact.hasVisibleDate),
    hasAuthorPattern: boolInt(fact.hasAuthorPattern),
    externalSourceLinksCount: nullableNumber(fact.externalSourceLinksCount) ?? 0,
    hasVideoEmbed: boolInt(fact.hasVideoEmbed),
    cruxLcp: nullableNumber(fact.cruxLcp),
    cruxInp: nullableNumber(fact.cruxInp),
    cruxCls: nullableNumber(fact.cruxCls),
    cruxFcp: nullableNumber(fact.cruxFcp),
    psiPerformanceScore: nullableScore(fact.psiPerformanceScore),
    lighthousePerformanceScore: nullableScore(fact.lighthousePerformanceScore),
    lighthouseSeoScore: nullableScore(fact.lighthouseSeoScore),
    importedSourceTypesJson: JSON.stringify(normalizeList(fact.importedSourceTypes))
  };
}

export function mergeFacts(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      merged[key] = [...new Set([...(Array.isArray(merged[key]) ? merged[key] : []), ...value])];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeObjects(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeObjects(existing = {}, incoming = {}) {
  const output = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      output[key] = [...new Set([...(Array.isArray(output[key]) ? output[key] : []), ...value])];
    } else if (value && typeof value === 'object') {
      output[key] = mergeObjects(output[key], value);
    } else if (typeof value === 'boolean' && typeof output[key] === 'boolean') {
      output[key] = output[key] || value;
    } else if (typeof value === 'number' && typeof output[key] === 'number') {
      output[key] = Math.max(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeSchemaTypes(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => normalizeSchemaTypes(item)))].filter(Boolean).sort();
  }
  if (typeof value === 'object') return collectSchemaTypes(value).sort();
  return [...new Set(String(value)
    .split(/[|,;]/)
    .map((item) => item.trim())
    .filter(Boolean))].sort();
}

export function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function inferPageType(url, schemaTypes = []) {
  const schemaSet = new Set(schemaTypes);
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return String(url || '').toLowerCase();
    }
  })();
  if (schemaSet.has('Product') || /\/(product|produkt|p)\//.test(path)) return 'product';
  if (schemaSet.has('Article') || schemaSet.has('BlogPosting') || /\/(blog|news|article|magazin|ratgeber)\//.test(path)) return 'article';
  if (schemaSet.has('LocalBusiness') || /\/(location|standort|filiale|store)s?\//.test(path)) return 'location';
  if (/\/(category|kategorie|c)\//.test(path)) return 'category';
  if (path === '/' || path === '') return 'homepage';
  return 'other';
}

function nullableText(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || null;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = typeof value === 'string'
    ? value.replace('%', '').replace(',', '.').replace(/[^\d.-]/g, '')
    : value;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function nullableScore(value) {
  const number = nullableNumber(value);
  if (number === null) return null;
  return number > 1 ? Number((number / 100).toFixed(3)) : number;
}

function boolInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  const text = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'ja', 'indexable'].includes(text)) return 1;
  if (['0', 'false', 'no', 'n', 'nein', 'non-indexable', 'not indexable'].includes(text)) return 0;
  return 0;
}
