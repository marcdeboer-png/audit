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
