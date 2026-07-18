import * as cheerio from 'cheerio';
import {
  absoluteUrl,
  getExtension,
  getHost,
  isInternalUrl,
  normalizeUrl,
  resourceTypeFromUrl
} from '../utils/url.js';
import { selectedHeaders } from '../utils/http.js';
import { detectPageType } from './pageType.js';
import { countVisibleWords, extractTextKinds, normalizeVisibleText, VISIBLE_TEXT_NORMALIZATION_VERSION } from './visibleText.js';

export function extractHtml(rawHtml, pageUrl, finalDomain, responseHeaders = {}) {
  const $ = cheerio.load(rawHtml || '');
  const textKinds = extractTextKinds(rawHtml || '');
  const bodyText = textKinds.visibleText;
  const rawTextLength = textKinds.rawTextLength;
  const wordCountRaw = countVisibleWords(bodyText);
  const title = cleanText($('head > title').first().text()) || null;
  const metaDescription = attrContent($, 'meta[name="description"]') || null;
  const metaRobots = attrContent($, 'meta[name="robots"]') || null;
  const canonical = absoluteUrl($('link[rel~="canonical"]').first().attr('href'), pageUrl);
  const htmlLang = $('html').attr('lang')?.trim() || null;
  const viewport = attrContent($, 'meta[name="viewport"]') || null;
  const charsetSignals = detectCharsetSignals($, responseHeaders);
  const favicon = absoluteUrl(
    $('link[rel~="icon"], link[rel="shortcut icon"]').first().attr('href'),
    pageUrl
  );
  const manifest = absoluteUrl($('link[rel="manifest"]').first().attr('href'), pageUrl);
  const og = extractOpenGraph($);
  const h1 = headings($, 'h1');
  const h2 = headings($, 'h2');
  const links = extractLinks($, pageUrl, finalDomain);
  const images = extractImages($, pageUrl);
  const resources = extractVisibleResources($, pageUrl, finalDomain);
  const schemas = extractSchemas($);
  const schemaTypes = [...new Set(schemas.filter((item) => item.schemaType).map((item) => item.schemaType))].sort();
  const xRobotsTag = responseHeaders['x-robots-tag'] || null;
  const allRobots = `${metaRobots || ''} ${xRobotsTag || ''}`.toLowerCase();
  const noindex = allRobots.includes('noindex');
  const nofollow = allRobots.includes('nofollow');
  const indexable = !noindex;
  const semanticSignals = extractSemanticSignals($);
  const pageType = detectPageType({ url: pageUrl, schemaTypes, title, h1, h2, bodyText, rawHtml, semanticSignals });
  const featureFlags = extractFeatureFlags($, bodyText, links, h2.length, pageUrl, pageType, semanticSignals);

  return {
    page: {
      title,
      titleLength: title ? title.length : 0,
      metaDescription,
      metaDescriptionLength: metaDescription ? metaDescription.length : 0,
      h1Json: JSON.stringify(h1),
      h1Count: h1.length,
      h2Json: JSON.stringify(h2),
      canonical,
      htmlLang,
      viewport,
      metaCharset: charsetSignals.metaCharset,
      hasHeaderUtf8: charsetSignals.hasHeaderUtf8 ? 1 : 0,
      hasMetaCharsetUtf8: charsetSignals.hasMetaCharsetUtf8 ? 1 : 0,
      metaRobots,
      xRobotsTag,
      indexable: indexable ? 1 : 0,
      noindex: noindex ? 1 : 0,
      nofollow: nofollow ? 1 : 0,
      wordCountRaw,
      rawTextLength,
      visibleTextLength: textKinds.visibleTextLength,
      textFactsJson: JSON.stringify({
        normalization_version: VISIBLE_TEXT_NORMALIZATION_VERSION,
        raw_text: { length: textKinds.rawTextLength, hash: textKinds.rawTextHash },
        visible_text: { length: textKinds.visibleTextLength, hash: textKinds.visibleTextHash },
        rendered_visible_text: null,
        structured_data_text: { length: textKinds.structuredDataTextLength, hash: textKinds.structuredDataTextHash },
        metadata_text: { length: textKinds.metadataTextLength, hash: textKinds.metadataTextHash }
      }),
      internalLinksCount: links.filter((link) => link.linkType === 'internal').length,
      externalLinksCount: links.filter((link) => link.linkType === 'external').length,
      schemaTypesJson: JSON.stringify(schemaTypes),
      imagesCount: images.length,
      imagesWithoutAltCount: images.filter((image) => !image.altAttributePresent).length,
      responseHeadersJson: JSON.stringify(selectedHeaders(responseHeaders)),
      ogJson: JSON.stringify(og),
      favicon,
      manifest,
      featureFlagsJson: JSON.stringify(featureFlags),
      pageType,
      hasTables: featureFlags.hasTables ? 1 : 0,
      hasLists: featureFlags.hasLists ? 1 : 0,
      hasFaqPattern: featureFlags.hasFaqPattern ? 1 : 0,
      hasVisibleDate: featureFlags.hasVisibleDate ? 1 : 0,
      hasAuthorPattern: featureFlags.hasAuthorPattern ? 1 : 0,
      externalSourceLinksCount: featureFlags.externalSourceLinksCount,
      hasVideoEmbed: featureFlags.hasVideoEmbed ? 1 : 0
    },
    links,
    images,
    resources,
    schemas,
    featureFlags
  };
}

function attrContent($, selector) {
  return $(selector).first().attr('content')?.trim() || null;
}

function detectCharsetSignals($, responseHeaders = {}) {
  const headerContentType = `${responseHeaders['content-type'] || ''} ${responseHeaders.charset || ''}`;
  const directMetaCharset = $('meta[charset]').first().attr('charset')?.trim() || null;
  let httpEquivContentType = null;
  $('meta').each((_, element) => {
    if (httpEquivContentType) return;
    const equiv = ($(element).attr('http-equiv') || '').trim().toLowerCase();
    if (equiv === 'content-type') httpEquivContentType = $(element).attr('content')?.trim() || null;
  });
  const metaCharset = directMetaCharset || charsetFromContentType(httpEquivContentType);
  return {
    metaCharset,
    hasHeaderUtf8: /utf-?8/i.test(headerContentType),
    hasMetaCharsetUtf8: /utf-?8/i.test(`${directMetaCharset || ''} ${httpEquivContentType || ''}`)
  };
}

function charsetFromContentType(value) {
  const match = String(value || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1].trim() : null;
}

function headings($, selector) {
  return $(selector)
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, 50);
}

function extractOpenGraph($) {
  const wanted = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
  const output = {};
  for (const property of wanted) {
    output[property] = $(`meta[property="${property}"]`).first().attr('content')?.trim() || null;
  }
  return output;
}

function extractLinks($, pageUrl, finalDomain) {
  const rows = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const linkedUrl = resolveAuthoredUrl(href, pageUrl);
    const normalizedTargetUrl = normalizeUrl(href, pageUrl);
    if (!normalizedTargetUrl) return;
    const linkType = isInternalUrl(normalizedTargetUrl, finalDomain) ? 'internal' : 'external';
    rows.push({
      sourceUrl: pageUrl,
      targetUrl: linkedUrl || normalizedTargetUrl,
      linkedUrl: linkedUrl || normalizedTargetUrl,
      normalizedTargetUrl,
      linkType,
      anchorText: cleanText($(element).text()).slice(0, 500),
      rel: ($(element).attr('rel') || '').trim()
    });
  });
  return rows;
}

function resolveAuthoredUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ''), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function extractImages($, pageUrl) {
  const rows = [];
  $('img').each((_, element) => {
    const src = $(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-lazy-src');
    const imageUrl = absoluteUrl(src, pageUrl);
    if (!imageUrl) return;
    const hasAltAttribute = $(element).attr('alt') !== undefined;
    const alt = hasAltAttribute ? String($(element).attr('alt') || '') : null;
    const classification = classifyImage($, element, imageUrl);
    rows.push({
      pageUrl,
      imageUrl,
      alt,
      hasAlt: alt !== null && alt.trim().length > 0 ? 1 : 0,
      altAttributePresent: hasAltAttribute ? 1 : 0,
      altValue: alt,
      altValueTrimmed: alt === null ? null : alt.trim(),
      isDecorativeCandidate: classification.likelyDecorativeImage ? 1 : 0,
      loading: $(element).attr('loading') || null,
      width: $(element).attr('width') || null,
      height: $(element).attr('height') || null,
      extension: getExtension(imageUrl),
      sizeBytes: null,
      ...classification
    });
  });
  return rows;
}

function classifyImage($, element, imageUrl) {
  const src = imageUrl.toLowerCase();
  const width = numericAttr($(element).attr('width'));
  const height = numericAttr($(element).attr('height'));
  const classAndRole = `${$(element).attr('class') || ''} ${$(element).attr('id') || ''} ${$(element).attr('role') || ''}`.toLowerCase();
  const tiny = (width && width <= 24 || !width) && (height && height <= 24 || !height) && (width || height);
  const likelyTrackingPixel = tiny || /tracking|pixel|beacon|analytics|counter|spacer|1x1|clear\.gif/.test(src);
  const likelyBadgeImage = /badge|seal|trustpilot|trustedshops|ekomi|rating|review|certificate|zertifikat|award/.test(`${src} ${classAndRole}`);
  const likelyIcon = /icon|favicon|sprite|logo|social|facebook|instagram|linkedin|twitter|x-logo|youtube/.test(`${src} ${classAndRole}`) ||
    ((width && width <= 64) || (height && height <= 64)) && /svg|png|ico/.test(src);
  const likelyHeroImage = /hero|lcp|above[-_ ]?fold|banner|masthead/.test(`${src} ${classAndRole}`);
  const likelyDecorativeImage = likelyTrackingPixel || likelyBadgeImage || likelyIcon ||
    /decorative|presentation|spacer/.test(classAndRole) ||
    $(element).attr('role') === 'presentation' ||
    $(element).attr('aria-hidden') === 'true';
  const imageRole = likelyTrackingPixel ? 'tracking_pixel'
    : likelyBadgeImage ? 'badge'
      : likelyIcon ? 'icon'
        : likelyDecorativeImage ? 'decorative'
          : likelyHeroImage ? 'hero'
          : 'content';
  return {
    likelyDecorativeImage: likelyDecorativeImage ? 1 : 0,
    likelyBadgeImage: likelyBadgeImage ? 1 : 0,
    likelyTrackingPixel: likelyTrackingPixel ? 1 : 0,
    likelyIcon: likelyIcon ? 1 : 0,
    imageRole
  };
}

function numericAttr(value) {
  const number = Number(String(value || '').replace(/px$/i, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function extractVisibleResources($, pageUrl, finalDomain) {
  const rows = [];
  const add = (resourceUrl, resourceType) => {
    const normalized = absoluteUrl(resourceUrl, pageUrl);
    if (!normalized) return;
    rows.push({
      pageUrl,
      resourceUrl: normalized,
      resourceType,
      statusCode: null,
      sizeBytes: null,
      contentType: null,
      isThirdParty: isInternalUrl(normalized, finalDomain) ? 0 : 1,
      responseHeadersJson: null
    });
  };

  $('script[src]').each((_, element) => add($(element).attr('src'), 'script'));
  $('link[rel~="stylesheet"][href]').each((_, element) => add($(element).attr('href'), 'stylesheet'));
  $('img[src], img[data-src], img[data-lazy-src]').each((_, element) => {
    add($(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-lazy-src'), 'image');
  });
  $('link[rel~="preload"], link[rel~="preconnect"], link[rel~="dns-prefetch"]').each((_, element) => {
    const href = $(element).attr('href');
    const as = ($(element).attr('as') || '').toLowerCase();
    add(href, as === 'font' ? 'font' : resourceTypeFromUrl(href || ''));
  });

  return rows;
}

function extractSchemas($) {
  const rows = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const types = collectSchemaTypes(parsed);
      if (!types.length) {
        rows.push({
          schemaType: null,
          rawJson: raw.slice(0, 50000),
          parseStatus: 'ok',
          parseError: null
        });
      }
      for (const schemaType of types) {
        rows.push({
          schemaType,
          rawJson: raw.slice(0, 50000),
          parseStatus: 'ok',
          parseError: null
        });
      }
    } catch (error) {
      rows.push({
        schemaType: null,
        rawJson: raw.slice(0, 50000),
        parseStatus: 'error',
        parseError: error.message
      });
    }
  });
  return rows;
}

export function collectSchemaTypes(value, output = new Set()) {
  if (!value) return [...output];
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTypes(item, output);
    return [...output];
  }
  if (typeof value !== 'object') return [...output];

  const type = value['@type'];
  if (Array.isArray(type)) {
    for (const item of type) output.add(String(item));
  } else if (type) {
    output.add(String(type));
  }

  if (Array.isArray(value['@graph'])) {
    for (const item of value['@graph']) collectSchemaTypes(item, output);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === '@graph' || key === '@type') continue;
    if (nestedValue && typeof nestedValue === 'object') collectSchemaTypes(nestedValue, output);
  }

  return [...output];
}

function extractFeatureFlags($, bodyText, links, h2Count, pageUrl, pageType, semanticSignals = extractSemanticSignals($)) {
  const externalLinks = links.filter((link) => link.linkType === 'external');
  const sourceLinks = externalLinks.filter((link) => {
    const haystack = `${link.anchorText || ''} ${link.targetUrl || ''}`.toLowerCase();
    return /source|quelle|reference|citation|study|studie|report|doi\.org|pubmed|research|whitepaper|paper/.test(haystack);
  });
  const headingQuestions = $('h1,h2,h3,h4,summary')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.includes('?'));
  const faqContainers = $('[class*="faq"], [id*="faq"], [class*="FAQ"], [id*="FAQ"]');
  const faqContainerQuestionCount = faqContainers.find('h2,h3,h4,summary,button')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.includes('?')).length;
  const detailsQuestionCount = $('details summary')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.includes('?')).length;
  const faqKeyword = /(^|\s)(faq|fragen und antworten|frequently asked questions)(\s|$)/i.test(bodyText);
  const faqStrongItemCount = Math.max(headingQuestions.length, faqContainerQuestionCount, detailsQuestionCount);
  const hasFaqPattern = faqStrongItemCount >= 2 && (faqKeyword || faqContainers.length > 0 || detailsQuestionCount >= 2);
  const hasWeakFaqPattern = !hasFaqPattern && (faqKeyword || headingQuestions.length === 1 || faqContainers.length > 0 || detailsQuestionCount === 1);
  const visibleTimeSamples = visibleSelectorTexts($, 'time, article [class*="date"], article [class*="publish"], main [class*="date"], main [class*="publish"]');
  const hasVisibleDate = visibleTimeSamples.some((text) => hasDatePattern(text));
  const visibleAuthorSamples = visibleSelectorTexts($, '[rel="author"], article .author, article .byline, article [class*="author"], article [class*="byline"], main [rel="author"], main .byline');
  const hasAuthorPattern = visibleAuthorSamples.some((text) => text.length > 0);
  const videosCount = $('video, iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"], iframe[src*="wistia"], iframe[src*="loom"]').length;
  const articleLike = pageType === 'article';
  const hasTables = $('table').length > 0;
  const hasLists = $('ul,ol').length > 0;
  const htmlSample = $.html().slice(0, 500000);
  const scriptSources = $('script[src]')
    .map((_, element) => $(element).attr('src') || '')
    .get()
    .join(' ');
  const consentSignals = detectConsentSignals(`${htmlSample} ${bodyText} ${scriptSources}`);
  const hreflangLinks = $('link[rel~="alternate"][hreflang]')
    .map((_, element) => ({
      hreflang: String($(element).attr('hreflang') || '').trim(),
      href: String($(element).attr('href') || '').trim()
    }))
    .get()
    .filter((item) => item.hreflang);
  const resourceHintCounts = {
    preload: $('link[rel~="preload"]').length,
    modulepreload: $('link[rel~="modulepreload"]').length,
    preconnect: $('link[rel~="preconnect"]').length,
    dnsPrefetch: $('link[rel~="dns-prefetch"]').length,
    prefetch: $('link[rel~="prefetch"]').length
  };
  const searchSignals = extractSearchSignals($, bodyText, htmlSample);

  return {
    tablesCount: $('table').length,
    listsCount: $('ul,ol').length,
    hasTables,
    hasLists,
    hasFaqHtml: hasFaqPattern,
    hasFaqPattern,
    hasWeakFaqPattern,
    faqStrongItemCount,
    faqQuestionHeadingCount: headingQuestions.length,
    externalSourceLinksCount: sourceLinks.length,
    externalLinksCount: externalLinks.length,
    hasVisibleDate,
    visibleDateSamples: visibleTimeSamples.slice(0, 5),
    hasAuthorHint: hasAuthorPattern,
    hasAuthorPattern,
    visibleAuthorSamples: visibleAuthorSamples.slice(0, 5),
    hasPreload: resourceHintCounts.preload > 0 || resourceHintCounts.modulepreload > 0,
    hasPreconnect: resourceHintCounts.preconnect > 0 || resourceHintCounts.dnsPrefetch > 0,
    resourceHintCounts,
    ...searchSignals,
    ...semanticSignals,
    hreflangCount: hreflangLinks.length,
    hreflangLanguages: [...new Set(hreflangLinks.map((item) => item.hreflang.toLowerCase()))].slice(0, 50),
    hasHreflangXDefault: hreflangLinks.some((item) => item.hreflang.toLowerCase() === 'x-default'),
    appleTouchIconCount: $('link[rel~="apple-touch-icon"]').length,
    iconLinkCount: $('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"]').length,
    manifestIconHint: $('link[rel="manifest"]').length > 0,
    ...consentSignals,
    videosCount,
    hasVideoEmbed: videosCount > 0,
    h2Count,
    h3Count: $('h3').length,
    articleLike,
    productLike: pageType === 'product',
    lowStructuredSections: countWords(bodyText) > 250 && h2Count < 2 && !hasLists && !hasTables
  };
}

function extractSearchSignals($, bodyText, htmlSample) {
  const forms = [];
  $('form').each((_, element) => {
    const form = $(element);
    const action = String(form.attr('action') || '').trim();
    const role = String(form.attr('role') || '').toLowerCase();
    const inputs = form.find('input').map((__, input) => ({
      type: String($(input).attr('type') || '').toLowerCase(),
      name: String($(input).attr('name') || '').toLowerCase(),
      role: String($(input).attr('role') || '').toLowerCase()
    })).get();
    const hasSearchInput = inputs.some((input) => input.type === 'search' || input.role === 'searchbox' || ['s', 'q', 'query', 'search'].includes(input.name));
    const actionLooksSearch = /\/(search|suche|site-search)(?:\/|$)|[?&](s|q|query|search)=/i.test(action);
    if (role !== 'search' && !hasSearchInput && !actionLooksSearch) return;
    const inGlobalChrome = form.closest('header,nav,footer').length > 0;
    const inMain = form.closest('main,[role="main"],article').length > 0 && !inGlobalChrome;
    forms.push({
      action: action.slice(0, 500) || null,
      inputNames: [...new Set(inputs.map((input) => input.name).filter(Boolean))].slice(0, 10),
      inGlobalChrome,
      inMain
    });
  });
  const explicitResultsText = /\b(search results?|suchergebnisse|ergebnisse\s+f(?:u|ü)r|results?\s+for)\b/i.test(bodyText.slice(0, 5000));
  const searchResultListCount = $('[class*="search-results"], [id*="search-results"], [class*="search-result-list"], [data-search-results]').length;
  return {
    searchFormCount: forms.length,
    mainSearchFormCount: forms.filter((form) => form.inMain).length,
    globalSearchFormCount: forms.filter((form) => form.inGlobalChrome).length,
    searchFormSamples: forms.slice(0, 5),
    hasExplicitSearchResultsText: explicitResultsText,
    searchResultListCount,
    hasSearchAction: /["']@type["']\s*:\s*["']SearchAction["']/i.test(htmlSample)
  };
}

function detectConsentSignals(text) {
  const value = String(text || '').toLowerCase();
  const vendors = [
    ['onetrust', /onetrust|optanonconsent|optanonalertbox/i],
    ['usercentrics', /usercentrics|uc_settings|uc_ui/i],
    ['cookiebot', /cookiebot|cookieconsent/i],
    ['didomi', /didomi/i],
    ['consentmanager', /consentmanager/i],
    ['cookiefirst', /cookiefirst/i],
    ['borlabs', /borlabs/i]
  ];
  const matchedVendors = vendors.filter(([, pattern]) => pattern.test(value)).map(([vendor]) => vendor);
  const hasGoogleConsentMode = /gtag\(['"]consent|google consent mode|ad_storage|analytics_storage|denied['"]\s*,\s*['"]granted|default_consent/i.test(text);
  const hasGoogleTagManager = /googletagmanager\.com\/gtm\.js|gtm-[a-z0-9]+|google tag manager/i.test(text);
  const hasGtag = /gtag\(/i.test(text) || /googletagmanager\.com\/gtag\/js/i.test(text);
  const hasDataLayer = /datalayer/i.test(text);
  const hasMetaPixel = /connect\.facebook\.net|fbq\(/i.test(text);
  return {
    consentVendorSignals: matchedVendors,
    hasConsentSignal: matchedVendors.length > 0 || hasGoogleConsentMode,
    hasGoogleConsentMode,
    hasGoogleTagManager,
    hasGtag,
    hasDataLayer,
    hasMetaPixel,
    thirdPartyMarketingSignals: [hasGoogleTagManager && 'google_tag_manager', hasGtag && 'gtag', hasMetaPixel && 'meta_pixel'].filter(Boolean)
  };
}

function extractSemanticSignals($) {
  const headingLevels = $('h1,h2,h3,h4,h5,h6')
    .map((_, element) => Number(element.tagName?.replace(/^h/i, '') || 0))
    .get()
    .filter(Boolean);
  let headingHierarchySkips = 0;
  for (let index = 1; index < headingLevels.length; index += 1) {
    if (headingLevels[index] - headingLevels[index - 1] > 1) headingHierarchySkips += 1;
  }
  const emptyH1Count = $('h1').filter((_, element) => !cleanText($(element).text())).length;
  const emptyH2Count = $('h2').filter((_, element) => !cleanText($(element).text())).length;
  const ariaLandmarkCount = $('[role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]').length;
  return {
    mainRegionCount: $('main, [role="main"]').length,
    headerRegionCount: $('header, [role="banner"]').length,
    navRegionCount: $('nav, [role="navigation"]').length,
    footerRegionCount: $('footer, [role="contentinfo"]').length,
    articleElementCount: $('article').length,
    ariaLandmarkCount,
    emptyH1Count,
    emptyH2Count,
    headingLevels: headingLevels.slice(0, 80),
    headingHierarchySkips,
    firstHeadingLevel: headingLevels[0] || null
  };
}

function URLSafePath($, pageUrl = '') {
  const canonical = $('link[rel~="canonical"]').first().attr('href') || '';
  try {
    return canonical ? new URL(canonical, pageUrl).pathname : new URL(pageUrl).pathname;
  } catch {
    return '';
  }
}

export function cleanText(text) {
  return normalizeVisibleText(text);
}

export function countWords(text) {
  return countVisibleWords(text);
}

function visibleSelectorTexts($, selector) {
  return $(selector)
    .filter((_, element) => isStaticallyVisible($, element))
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
}

function isStaticallyVisible($, element) {
  const node = $(element);
  if (node.is('[hidden], [aria-hidden="true"]')) return false;
  if (node.closest('[hidden], [aria-hidden="true"], script, style, noscript, template, head, svg').length) return false;
  const style = String(node.attr('style') || '').toLowerCase().replace(/\s+/g, '');
  return !style.includes('display:none') && !style.includes('visibility:hidden') && !style.includes('content-visibility:hidden');
}

function hasDatePattern(text) {
  return /\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/.test(text) ||
    /\b(0?[1-9]|[12]\d|3[01])\.\s?(0?[1-9]|1[0-2])\.\s?(20\d{2}|19\d{2})\b/.test(text) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|maerz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{1,2},?\s+(20\d{2}|19\d{2})\b/i.test(text);
}

export function domainFromUrl(url) {
  return getHost(url);
}
