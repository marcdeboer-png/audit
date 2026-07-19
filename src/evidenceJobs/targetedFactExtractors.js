import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { thresholds } from '../checks/config/thresholds.js';
import { normalizeUrl } from '../utils/url.js';
import { collectSchemaTypes } from '../extractors/structuredData.js';

const SUPPORTED_TARGETED_JOB_TYPES = new Set([
  'title_facts',
  'meta_description_facts',
  'h1_facts',
  'canonical_robots_facts',
  'schema_summary_facts',
  'hreflang_facts'
]);

const MAX_JSON_LD_EXCERPT_BYTES = 2048;
const MAX_PARSE_ERRORS = 20;
const MAX_HREFLANG_ENTRIES = 100;

export function isSupportedTargetedJobType(jobType) {
  return SUPPORTED_TARGETED_JOB_TYPES.has(jobType);
}

export function supportedTargetedJobTypes() {
  return [...SUPPORTED_TARGETED_JOB_TYPES];
}

export function extractTargetedFacts(jobType, html, context = {}) {
  if (!isSupportedTargetedJobType(jobType)) {
    throw new Error(`Evidence job type is not executable in Batch 10.8: ${jobType}`);
  }
  const $ = cheerio.load(html || '');
  const url = normalizeUrl(context.url) || context.url;
  const finalUrl = normalizeUrl(context.finalUrl || url) || url;
  const statusCode = Number(context.statusCode || 0) || null;
  const contentType = context.contentType || '';
  const metaRobots = cleanText($('meta[name="robots"], meta[name="googlebot"]').first().attr('content'));
  const xRobotsTag = cleanText(context.headers?.['x-robots-tag']);
  const robots = `${metaRobots || ''} ${xRobotsTag || ''}`.toLowerCase();
  const metaNoindex = hasDirective(metaRobots, 'noindex') || hasDirective(metaRobots, 'none');
  const metaNofollow = hasDirective(metaRobots, 'nofollow') || hasDirective(metaRobots, 'none');
  const xRobotsNoindex = hasDirective(xRobotsTag, 'noindex') || hasDirective(xRobotsTag, 'none');
  const xRobotsNofollow = hasDirective(xRobotsTag, 'nofollow') || hasDirective(xRobotsTag, 'none');
  const indexability = indexabilityFor({ statusCode, contentType, metaNoindex, xRobotsNoindex });
  const base = { url, finalUrl, statusCode, contentType, indexability };

  if (jobType === 'title_facts') return { ...base, ...titleFacts($) };
  if (jobType === 'meta_description_facts') return { ...base, ...metaDescriptionFacts($) };
  if (jobType === 'h1_facts') return { ...base, ...h1Facts($) };
  if (jobType === 'schema_summary_facts') return { ...base, ...schemaSummaryFacts($) };
  if (jobType === 'hreflang_facts') return { ...base, ...hreflangFacts($, finalUrl) };
  const output = {
    ...base,
    ...canonicalRobotsFacts($, finalUrl, {
      metaRobots,
      metaNoindex,
      metaNofollow,
      xRobotsTag,
      xRobotsNoindex,
      xRobotsNofollow,
      robots
    })
  };
  if (!output.indexability) output.indexability = indexability;
  return output;
}

export function factStorageEstimate(facts = {}) {
  return Buffer.byteLength(JSON.stringify(facts), 'utf8');
}

function titleFacts($) {
  const titleNode = $('head > title').first();
  const hasTitleTag = titleNode.length > 0;
  const title = capText(cleanText(titleNode.text()), 300);
  const titleLength = title ? title.length : 0;
  return {
    title,
    titleLength,
    titleMissing: !hasTitleTag,
    titleEmpty: hasTitleTag && titleLength === 0,
    titleTooShort: titleLength > 0 && titleLength < thresholds.titleTooShort,
    titleTooLong: titleLength > thresholds.titleTooLong,
    titleHash: hashText(title),
    titlePattern: patternForText(title)
  };
}

function metaDescriptionFacts($) {
  const metaNode = $('meta[name="description"]').first();
  const hasMetaTag = metaNode.length > 0;
  const metaDescription = capText(cleanText(metaNode.attr('content')), 500);
  const metaDescriptionLength = metaDescription ? metaDescription.length : 0;
  return {
    metaDescription,
    metaDescriptionLength,
    metaDescriptionMissing: !hasMetaTag,
    metaDescriptionEmpty: hasMetaTag && metaDescriptionLength === 0,
    metaDescriptionTooShort: metaDescriptionLength > 0 && metaDescriptionLength < thresholds.descriptionTooShort,
    metaDescriptionTooLong: metaDescriptionLength > thresholds.descriptionTooLong,
    metaDescriptionHash: hashText(metaDescription),
    metaDescriptionPattern: patternForText(metaDescription)
  };
}

function h1Facts($) {
  const h1Nodes = $('h1');
  const rawTexts = h1Nodes
    .map((_, element) => capText(cleanText($(element).text()), 300))
    .get()
    .slice(0, 20);
  const h1Texts = rawTexts.filter((text) => text !== null);
  const firstH1 = h1Texts[0] || null;
  return {
    h1Count: h1Texts.length,
    h1Texts,
    firstH1,
    h1Missing: h1Nodes.length === 0,
    h1Empty: h1Nodes.length > 0 && h1Texts.length === 0,
    h1Multiple: h1Nodes.length > 1,
    h1Hash: hashText(firstH1),
    h1Pattern: patternForText(firstH1)
  };
}

function canonicalRobotsFacts($, finalUrl, robotsFacts) {
  const canonicalRaw = cleanText($('link[rel~="canonical"]').first().attr('href'));
  const canonical = normalizeUrl(canonicalRaw, finalUrl) || canonicalRaw;
  const finalOrigin = originOf(finalUrl);
  const canonicalOrigin = originOf(canonical);
  const canonicalMissing = !canonical;
  const canonicalSelfReferencing = Boolean(canonical && normalizeUrl(canonical) === normalizeUrl(finalUrl));
  const canonicalExternal = Boolean(canonicalOrigin && finalOrigin && canonicalOrigin !== finalOrigin);
  const robotsConflict = Boolean(
    canonicalSelfReferencing && (robotsFacts.metaNoindex || robotsFacts.xRobotsNoindex)
  );
  return {
    canonical: canonical || null,
    canonicalMissing,
    canonicalSelfReferencing,
    canonicalExternal,
    metaRobots: robotsFacts.metaRobots,
    metaNoindex: robotsFacts.metaNoindex,
    metaNofollow: robotsFacts.metaNofollow,
    xRobotsTag: robotsFacts.xRobotsTag,
    xRobotsNoindex: robotsFacts.xRobotsNoindex,
    xRobotsNofollow: robotsFacts.xRobotsNofollow,
    indexability: (robotsFacts.metaNoindex || robotsFacts.xRobotsNoindex) ? 'blocked_by_robots' : null,
    robotsConflict
  };
}

function schemaSummaryFacts($) {
  const jsonLdNodes = $('script[type="application/ld+json"], script[type="application/json+ld"]');
  const parseErrors = [];
  const jsonLdHashes = [];
  const schemaTypes = new Set();
  let rawJsonBytes = 0;
  let cappedJsonLdExcerpt = '';

  jsonLdNodes.each((index, element) => {
    const raw = String($(element).contents().text() || $(element).text() || '').trim();
    if (!raw) return;
    rawJsonBytes += Buffer.byteLength(raw, 'utf8');
    jsonLdHashes.push(hashText(raw));
    cappedJsonLdExcerpt = appendCappedExcerpt(cappedJsonLdExcerpt, raw, MAX_JSON_LD_EXCERPT_BYTES);
    try {
      for (const schemaType of collectSchemaTypes(JSON.parse(raw))) schemaTypes.add(schemaType);
    } catch (error) {
      if (parseErrors.length < MAX_PARSE_ERRORS) {
        parseErrors.push({
          blockIndex: index,
          message: capText(error?.message || 'JSON-LD parse error', 180)
        });
      }
    }
  });

  $('[itemscope],[itemtype]').each((_, element) => {
    const itemType = cleanText($(element).attr('itemtype'));
    const type = schemaTypeName(itemType);
    if (type) schemaTypes.add(type);
  });
  $('[typeof]').each((_, element) => {
    for (const value of String($(element).attr('typeof') || '').split(/\s+/)) {
      const type = schemaTypeName(value);
      if (type) schemaTypes.add(type);
    }
  });

  const sortedTypes = [...schemaTypes].sort();
  return {
    schemaBlockCount: jsonLdNodes.length + $('[itemscope],[typeof]').length,
    jsonLdBlockCount: jsonLdNodes.length,
    microdataDetected: $('[itemscope],[itemtype]').length > 0,
    rdfaDetected: $('[typeof],[property][vocab],[vocab]').length > 0,
    schemaTypes: sortedTypes.slice(0, 100),
    schemaTypeCount: sortedTypes.length,
    hasBreadcrumbList: sortedTypes.includes('BreadcrumbList'),
    hasArticle: sortedTypes.some((type) => ['Article', 'NewsArticle', 'BlogPosting'].includes(type)),
    hasProduct: sortedTypes.includes('Product'),
    hasOrganization: sortedTypes.includes('Organization'),
    hasWebSite: sortedTypes.includes('WebSite'),
    hasLocalBusiness: sortedTypes.includes('LocalBusiness'),
    hasFAQPage: sortedTypes.includes('FAQPage'),
    hasHowTo: sortedTypes.includes('HowTo'),
    hasVideoObject: sortedTypes.includes('VideoObject'),
    jsonLdHashes: jsonLdHashes.filter(Boolean).slice(0, 50),
    cappedJsonLdExcerpt,
    rawJsonBytes,
    rawJsonCapped: rawJsonBytes > Buffer.byteLength(cappedJsonLdExcerpt || '', 'utf8'),
    parseErrors,
    schemaSummaryHash: hashText(JSON.stringify({
      types: sortedTypes,
      jsonLdHashes: jsonLdHashes.filter(Boolean).slice(0, 50),
      microdata: $('[itemscope],[itemtype]').length > 0,
      rdfa: $('[typeof],[property][vocab],[vocab]').length > 0,
      parseErrorCount: parseErrors.length
    }))
  };
}

function hreflangFacts($, finalUrl) {
  const canonicalRaw = cleanText($('link[rel~="canonical"]').first().attr('href'));
  const canonical = normalizeUrl(canonicalRaw, finalUrl) || canonicalRaw || null;
  const finalOrigin = originOf(finalUrl);
  const entries = [];
  $('link[rel~="alternate"][hreflang]').each((_, element) => {
    if (entries.length >= MAX_HREFLANG_ENTRIES) return;
    const hreflang = cleanText($(element).attr('hreflang'));
    const hrefRaw = cleanText($(element).attr('href'));
    const href = hrefRaw ? (normalizeUrl(hrefRaw, finalUrl) || hrefRaw) : null;
    const parsed = parseHreflangCode(hreflang);
    entries.push({
      hreflang,
      href,
      language: parsed.language,
      region: parsed.region,
      isXDefault: parsed.isXDefault,
      invalidLanguageCode: parsed.invalid,
      emptyHref: !href,
      externalTarget: Boolean(href && finalOrigin && originOf(href) && originOf(href) !== finalOrigin)
    });
  });
  const languages = unique(entries.map((entry) => entry.language).filter((value) => value && value !== 'x-default'));
  const regions = unique(entries.map((entry) => entry.region).filter(Boolean));
  const normalizedFinalUrl = normalizeUrl(finalUrl);
  const normalizedCanonical = normalizeUrl(canonical);
  const canonicalHreflangConflict = Boolean(
    normalizedCanonical &&
    normalizedFinalUrl &&
    normalizedCanonical !== normalizedFinalUrl &&
    entries.some((entry) => normalizeUrl(entry.href) === normalizedFinalUrl)
  );
  return {
    hreflangCount: entries.length,
    hreflangEntries: entries,
    languages,
    regions,
    hasXDefault: entries.some((entry) => entry.isXDefault),
    hasSelfLanguage: entries.some((entry) => !entry.isXDefault && normalizeUrl(entry.href) === normalizedFinalUrl),
    hasInvalidLanguageCodes: entries.some((entry) => entry.invalidLanguageCode),
    hasEmptyHref: entries.some((entry) => entry.emptyHref),
    hasExternalHreflangTargets: entries.some((entry) => entry.externalTarget),
    canonical,
    canonicalHreflangConflict,
    returnLinkValidationPerformed: false,
    hreflangSummaryHash: hashText(JSON.stringify(entries.map((entry) => ({
      hreflang: entry.hreflang,
      href: entry.href,
      invalid: entry.invalidLanguageCode,
      empty: entry.emptyHref
    }))))
  };
}

function indexabilityFor({ statusCode, contentType, metaNoindex, xRobotsNoindex }) {
  if (statusCode && statusCode >= 400) return 'http_error';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return 'non_html';
  if (metaNoindex || xRobotsNoindex) return 'blocked_by_robots';
  return 'indexable';
}

function hasDirective(value, directive) {
  return String(value || '').toLowerCase().split(/[,\s]+/).includes(directive);
}

function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function capText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function hashText(value) {
  const text = String(value || '').trim();
  return text ? crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) : null;
}

function patternForText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/\d+/g, '{num}')
    .replace(/[a-f0-9]{8,}/g, '{hash}')
    .replace(/[^\p{L}\p{N}{}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function originOf(value) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function schemaTypeName(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const last = text.split(/[\/#]/).filter(Boolean).pop() || text;
  return last.replace(/^schema:/i, '').replace(/[^\w-]/g, '').slice(0, 80) || null;
}

function appendCappedExcerpt(existing, raw, maxBytes) {
  if (Buffer.byteLength(existing || '', 'utf8') >= maxBytes) return existing;
  const prefix = existing ? `${existing}\n---\n` : '';
  const remaining = maxBytes - Buffer.byteLength(prefix, 'utf8');
  if (remaining <= 0) return existing;
  const next = capUtf8Bytes(raw, remaining);
  return `${prefix}${next}`;
}

function capUtf8Bytes(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let output = '';
  for (const char of text) {
    if (Buffer.byteLength(output + char, 'utf8') > maxBytes) break;
    output += char;
  }
  return output;
}

function parseHreflangCode(value) {
  const code = String(value || '').trim();
  if (!code) return { language: null, region: null, isXDefault: false, invalid: true };
  if (/^x-default$/i.test(code)) return { language: 'x-default', region: null, isXDefault: true, invalid: false };
  const match = code.match(/^([a-z]{2,3})(?:-([a-z]{2}|[0-9]{3}))?$/i);
  return {
    language: match ? match[1].toLowerCase() : null,
    region: match?.[2] ? match[2].toUpperCase() : null,
    isXDefault: false,
    invalid: !match
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}
