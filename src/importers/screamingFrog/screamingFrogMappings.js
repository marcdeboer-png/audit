import { normalizeUrl } from '../../utils/url.js';
import { normalizeHeader } from './parseScreamingFrogCsv.js';

const FIELD_HEADERS = {
  url: ['address', 'url'],
  finalUrl: ['final_url', 'final_address', 'redirect_url'],
  statusCode: ['status_code', 'http_status_code'],
  contentType: ['content_type'],
  indexability: ['indexability'],
  indexabilityStatus: ['indexability_status'],
  title: ['title_1', 'title'],
  titleLength: ['title_1_length', 'title_length'],
  metaDescription: ['meta_description_1', 'meta_description'],
  metaDescriptionLength: ['meta_description_1_length', 'meta_description_length'],
  h1Text: ['h1_1', 'h1'],
  h1Count: ['h1_1_occurrences', 'h1_occurrences', 'h1_count'],
  h2Text: ['h2_1', 'h2'],
  h2Count: ['h2_1_occurrences', 'h2_occurrences', 'h2_count'],
  canonical: ['canonical_link_element_1', 'canonical', 'canonical_url'],
  canonicalStatus: ['canonical_link_element_1_status_code', 'canonical_status_code', 'canonical_status'],
  metaRobots: ['meta_robots_1', 'meta_robots'],
  xRobotsTag: ['x_robots_tag_1', 'x_robots_tag'],
  wordCount: ['word_count'],
  depth: ['crawl_depth', 'depth'],
  inlinkCount: ['inlinks', 'unique_inlinks'],
  outlinkCount: ['outlinks', 'unique_outlinks'],
  imagesCount: ['no_of_images', 'images', 'image_count'],
  imagesMissingAltCount: ['images_missing_alt_text', 'missing_alt_text', 'images_missing_alt'],
  rawHtmlSize: ['size_bytes', 'size'],
  schemaTypes: ['schema_types', 'schema_type', 'type'],
  cruxLcp: ['crux_lcp', 'origin_lcp', 'largest_contentful_paint'],
  cruxInp: ['crux_inp', 'origin_inp', 'interaction_to_next_paint'],
  cruxCls: ['crux_cls', 'origin_cls', 'cumulative_layout_shift'],
  cruxFcp: ['crux_fcp', 'first_contentful_paint'],
  psiPerformanceScore: ['psi_performance_score', 'performance_score'],
  lighthousePerformanceScore: ['lighthouse_performance_score'],
  lighthouseSeoScore: ['lighthouse_seo_score', 'seo_score'],
  httpVersion: ['http_version', 'protocol'],
  cacheControl: ['cache_control', 'cache_control_header'],
  age: ['age'],
  via: ['via'],
  xCache: ['x_cache', 'x_cache_header'],
  xCacheHits: ['x_cache_hits'],
  cfCacheStatus: ['cf_cache_status'],
  xAzureRef: ['x_azure_ref'],
  server: ['server'],
  contentEncoding: ['content_encoding'],
  ogTitle: ['og_title', 'open_graph_title'],
  ogDescription: ['og_description', 'open_graph_description'],
  ogImage: ['og_image', 'open_graph_image'],
  ogUrl: ['og_url', 'open_graph_url'],
  ogType: ['og_type', 'open_graph_type'],
  favicon: ['favicon', 'favicon_url'],
  manifest: ['manifest', 'web_manifest', 'manifest_url'],
  appleTouchIcon: ['apple_touch_icon', 'apple_touch_icon_url'],
  hreflang: ['hreflang', 'language', 'language_region'],
  hreflangUrl: ['alternate_url', 'href', 'hreflang_url'],
  xDefault: ['x_default', 'x_default_url'],
  returnLinks: ['return_links', 'return_link_status'],
  preloadCount: ['preload', 'preload_count'],
  preconnectCount: ['preconnect', 'preconnect_count'],
  dnsPrefetchCount: ['dns_prefetch', 'dns_prefetch_count'],
  prefetchCount: ['prefetch', 'prefetch_count'],
  jsCount: ['js_count', 'javascript_count', 'scripts'],
  cssCount: ['css_count', 'stylesheets', 'stylesheet_count'],
  totalJsBytes: ['total_js_size', 'total_js_bytes', 'javascript_bytes'],
  totalCssBytes: ['total_css_size', 'total_css_bytes', 'css_bytes'],
  consentManager: ['consent_manager', 'cmp', 'cookie_banner', 'cookie_consent'],
  googleConsentMode: ['google_consent_mode', 'consent_mode'],
  googleTagManager: ['google_tag_manager', 'gtm'],
  gtag: ['gtag'],
  dataLayer: ['data_layer', 'datalayer'],
  metaPixel: ['meta_pixel', 'facebook_pixel'],
  source: ['source', 'from'],
  destination: ['destination', 'to'],
  anchorText: ['anchor_text', 'anchor'],
  linkType: ['type', 'link_type'],
  rel: ['rel'],
  imageUrl: ['image', 'image_url', 'address'],
  pageUrl: ['source', 'page_url'],
  alt: ['alt_text', 'alt']
};

const KNOWN_HEADERS = new Set(Object.values(FIELD_HEADERS).flat());

export function mapScreamingFrogRow(row, exportType) {
  const getter = createGetter(row);
  const url = normalizeUrl(getter('url'));
  if (!url && !['inlinks', 'outlinks', 'images'].includes(exportType)) return null;

  if (exportType === 'inlinks' || exportType === 'outlinks') {
    return {
      artifact: 'link',
      sourceUrl: normalizeUrl(getter('source')),
      targetUrl: normalizeUrl(getter('destination')),
      normalizedTargetUrl: normalizeUrl(getter('destination')),
      linkType: linkTypeFromValue(getter('linkType')),
      anchorText: getter('anchorText') || null,
      rel: getter('rel') || null
    };
  }

  if (exportType === 'images') {
    const pageUrl = normalizeUrl(getter('pageUrl')) || url;
    const imageUrl = normalizeUrl(getter('imageUrl'), pageUrl) || normalizeUrl(getter('url'), pageUrl);
    if (!pageUrl && !imageUrl) return null;
    const alt = getter('alt');
    return {
      artifact: 'image',
      fact: {
        url: pageUrl,
        imagesCount: 1,
        imagesMissingAltCount: alt ? 0 : 1,
        importedSourceTypes: [exportType]
      },
      image: {
        pageUrl,
        imageUrl,
        alt: alt || null,
        hasAlt: alt ? 1 : 0,
        loading: null,
        width: null,
        height: null,
        extension: null,
        sizeBytes: numberValue(getter('rawHtmlSize')),
        likelyDecorativeImage: 0,
        likelyBadgeImage: 0,
        likelyTrackingPixel: 0,
        likelyIcon: 0,
        imageRole: 'content'
      }
    };
  }

  const metaRobots = getter('metaRobots');
  const xRobotsTag = getter('xRobotsTag');
  const indexability = getter('indexability');
  const fact = {
    url,
    finalUrl: normalizeUrl(getter('finalUrl')) || url,
    statusCode: numberValue(getter('statusCode')),
    contentType: getter('contentType') || 'text/html',
    indexable: indexability ? /indexable/i.test(indexability) && !/non-indexable/i.test(indexability) : undefined,
    noindex: /noindex/i.test(`${metaRobots} ${xRobotsTag} ${getter('indexabilityStatus')}`),
    nofollow: /nofollow/i.test(`${metaRobots} ${xRobotsTag}`),
    title: getter('title'),
    titleLength: numberValue(getter('titleLength')),
    metaDescription: getter('metaDescription'),
    metaDescriptionLength: numberValue(getter('metaDescriptionLength')),
    h1Text: getter('h1Text'),
    h1Count: numberValue(getter('h1Count')),
    h2Text: getter('h2Text'),
    h2Count: numberValue(getter('h2Count')),
    canonical: normalizeUrl(getter('canonical'), url) || getter('canonical'),
    canonicalStatus: getter('canonicalStatus'),
    metaRobots,
    xRobotsTag,
    wordCount: numberValue(getter('wordCount')),
    depth: numberValue(getter('depth')),
    inlinkCount: numberValue(getter('inlinkCount')),
    outlinkCount: numberValue(getter('outlinkCount')),
    imagesCount: numberValue(getter('imagesCount')),
    imagesMissingAltCount: numberValue(getter('imagesMissingAltCount')),
    rawHtmlSize: numberValue(getter('rawHtmlSize')),
    schemaTypes: getter('schemaTypes'),
    cruxLcp: numberValue(getter('cruxLcp')),
    cruxInp: numberValue(getter('cruxInp')),
    cruxCls: numberValue(getter('cruxCls')),
    cruxFcp: numberValue(getter('cruxFcp')),
    psiPerformanceScore: normalizeScore(getter('psiPerformanceScore')),
    lighthousePerformanceScore: normalizeScore(getter('lighthousePerformanceScore')),
    lighthouseSeoScore: normalizeScore(getter('lighthouseSeoScore')),
    responseHeadersJson: responseHeadersJson(getter),
    og: openGraphFact(getter),
    favicon: normalizeUrl(getter('favicon'), url) || getter('favicon'),
    manifest: normalizeUrl(getter('manifest'), url) || getter('manifest'),
    featureFlags: featureFlagsFact(getter, exportType),
    importedSourceTypes: [exportType]
  };

  return { artifact: 'fact', fact };
}

export function ignoredColumns(headers = []) {
  return headers.filter((header) => !KNOWN_HEADERS.has(normalizeHeader(header)));
}

export function mappedFields(headers = []) {
  const normalized = new Set(headers.map(normalizeHeader));
  return Object.entries(FIELD_HEADERS)
    .filter(([, candidates]) => candidates.some((candidate) => normalized.has(candidate)))
    .map(([field]) => field);
}

function createGetter(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    normalized[normalizeHeader(key)] = value;
  }
  return (field) => {
    const candidates = FIELD_HEADERS[field] || [field];
    for (const candidate of candidates) {
      const value = normalized[candidate];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace('%', '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function normalizeScore(value) {
  const number = numberValue(value);
  if (number === null) return null;
  return number > 1 ? Number((number / 100).toFixed(3)) : number;
}

function linkTypeFromValue(value) {
  return /external/i.test(value || '') ? 'external' : 'internal';
}

function responseHeadersJson(getter) {
  const headers = {
    'cache-control': getter('cacheControl'),
    age: getter('age'),
    via: getter('via'),
    'x-cache': getter('xCache'),
    'x-cache-hits': getter('xCacheHits'),
    'cf-cache-status': getter('cfCacheStatus'),
    'x-azure-ref': getter('xAzureRef'),
    server: getter('server'),
    'content-encoding': getter('contentEncoding'),
    'x-http-version': getter('httpVersion')
  };
  const compact = Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
  return Object.keys(compact).length ? JSON.stringify(compact) : null;
}

function openGraphFact(getter) {
  const og = {
    'og:title': getter('ogTitle') || null,
    'og:description': getter('ogDescription') || null,
    'og:image': getter('ogImage') || null,
    'og:url': getter('ogUrl') || null,
    'og:type': getter('ogType') || null
  };
  return Object.fromEntries(Object.entries(og).filter(([, value]) => value));
}

function featureFlagsFact(getter, exportType) {
  const hreflang = getter('hreflang');
  const xDefault = getter('xDefault');
  const consentVendor = getter('consentManager');
  const flags = {
    httpVersion: getter('httpVersion') || null,
    hasHreflangXDefault: Boolean(xDefault || String(hreflang).toLowerCase() === 'x-default'),
    hreflangCount: hreflang ? 1 : 0,
    hreflangLanguages: hreflang ? [String(hreflang).toLowerCase()] : [],
    hreflangReturnLinks: getter('returnLinks') || null,
    resourceHintCounts: {
      preload: numberValue(getter('preloadCount')) || 0,
      preconnect: numberValue(getter('preconnectCount')) || 0,
      dnsPrefetch: numberValue(getter('dnsPrefetchCount')) || 0,
      prefetch: numberValue(getter('prefetchCount')) || 0
    },
    hasPreload: Boolean(numberValue(getter('preloadCount'))),
    hasPreconnect: Boolean(numberValue(getter('preconnectCount')) || numberValue(getter('dnsPrefetchCount'))),
    jsCount: numberValue(getter('jsCount')),
    cssCount: numberValue(getter('cssCount')),
    totalJsBytes: numberValue(getter('totalJsBytes')),
    totalCssBytes: numberValue(getter('totalCssBytes')),
    appleTouchIconCount: getter('appleTouchIcon') ? 1 : 0,
    hasConsentSignal: Boolean(consentVendor || truthyText(getter('googleConsentMode'))),
    consentVendorSignals: consentVendor ? [consentVendor] : [],
    hasGoogleConsentMode: truthyText(getter('googleConsentMode')),
    hasGoogleTagManager: truthyText(getter('googleTagManager')),
    hasGtag: truthyText(getter('gtag')),
    hasDataLayer: truthyText(getter('dataLayer')),
    hasMetaPixel: truthyText(getter('metaPixel')),
    importedSfExportType: exportType
  };
  return flags;
}

function truthyText(value) {
  if (!value) return false;
  return /^(1|true|yes|ja|present|detected|found)$/i.test(String(value).trim()) || !/^(0|false|no|nein|missing|not found)$/i.test(String(value).trim());
}
