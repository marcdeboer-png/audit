import { normalizeHeader } from './parseScreamingFrogCsv.js';

const EXPORT_DEFINITIONS = [
  {
    type: 'internal_html',
    label: 'Internal HTML',
    required: ['address'],
    signals: ['content_type', 'indexability', 'title_1', 'meta_description_1', 'h1_1', 'canonical_link_element_1'],
    filenameSignals: ['internal_html', 'internal all', 'internal_all', 'all_internal']
  },
  {
    type: 'response_codes',
    label: 'Response Codes',
    required: ['address', 'status_code'],
    signals: ['status', 'indexability'],
    filenameSignals: ['response_codes', 'response codes']
  },
  {
    type: 'page_titles',
    label: 'Page Titles',
    required: ['address'],
    signals: ['title_1', 'title_1_length', 'title_1_pixel_width'],
    filenameSignals: ['page_titles', 'page titles']
  },
  {
    type: 'meta_descriptions',
    label: 'Meta Description',
    required: ['address'],
    signals: ['meta_description_1', 'meta_description_1_length', 'meta_description_1_pixel_width'],
    filenameSignals: ['meta_descriptions', 'meta description']
  },
  {
    type: 'h1',
    label: 'H1',
    required: ['address'],
    signals: ['h1_1', 'h1_1_length', 'h1_1_occurrences'],
    filenameSignals: ['h1']
  },
  {
    type: 'h2',
    label: 'H2',
    required: ['address'],
    signals: ['h2_1', 'h2_1_length', 'h2_1_occurrences'],
    filenameSignals: ['h2']
  },
  {
    type: 'canonicals',
    label: 'Canonicals',
    required: ['address'],
    signals: ['canonical_link_element_1', 'canonicalised', 'canonical_link_element_1_status_code'],
    filenameSignals: ['canonicals', 'canonical']
  },
  {
    type: 'directives',
    label: 'Directives',
    required: ['address'],
    signals: ['meta_robots_1', 'x_robots_tag_1', 'indexability_status'],
    filenameSignals: ['directives']
  },
  {
    type: 'inlinks',
    label: 'Inlinks',
    required: ['source', 'destination'],
    signals: ['anchor_text', 'type', 'follow'],
    filenameSignals: ['inlinks', 'in links']
  },
  {
    type: 'outlinks',
    label: 'Outlinks',
    required: ['source', 'destination'],
    signals: ['anchor_text', 'type', 'follow'],
    filenameSignals: ['outlinks', 'out links']
  },
  {
    type: 'images',
    label: 'Images',
    required: [],
    signals: ['image', 'alt_text', 'source', 'size_bytes', 'missing_alt_text'],
    filenameSignals: ['images']
  },
  {
    type: 'structured_data',
    label: 'Structured Data',
    required: ['address'],
    signals: ['type', 'validation_status', 'schema_type'],
    filenameSignals: ['structured_data', 'structured data']
  },
  {
    type: 'psi_crux',
    label: 'PSI/CrUX',
    required: ['address'],
    signals: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift', 'performance_score'],
    filenameSignals: ['psi', 'crux', 'pagespeed', 'page speed']
  },
  {
    type: 'hreflang',
    label: 'Hreflang',
    required: ['address'],
    signals: ['hreflang', 'language', 'language_region', 'x_default', 'return_links', 'alternate_url'],
    filenameSignals: ['hreflang']
  },
  {
    type: 'opengraph',
    label: 'Open Graph',
    required: ['address'],
    signals: ['og_title', 'og_description', 'og_image', 'og_url', 'og_type'],
    filenameSignals: ['open_graph', 'opengraph', 'open graph']
  },
  {
    type: 'security_headers',
    label: 'Security/Header Data',
    required: ['address'],
    signals: ['cache_control', 'x_cache', 'cf_cache_status', 'via', 'server', 'http_version', 'content_encoding'],
    filenameSignals: ['security', 'headers', 'response headers']
  },
  {
    type: 'javascript',
    label: 'JavaScript/Rendered Data',
    required: ['address'],
    signals: ['rendered', 'javascript', 'js_count', 'css_count', 'total_js_size', 'total_css_size'],
    filenameSignals: ['javascript', 'rendered', 'js']
  },
  {
    type: 'resource_hints',
    label: 'Resource Hints',
    required: ['address'],
    signals: ['preconnect', 'dns_prefetch', 'preload', 'prefetch'],
    filenameSignals: ['resource hints', 'preconnect', 'preload']
  }
];

export function detectScreamingFrogExport(headers = [], filename = '') {
  const normalizedHeaders = headers.map(normalizeHeader);
  const headerSet = new Set(normalizedHeaders);
  const filenameHint = String(filename || '').toLowerCase();
  const candidates = EXPORT_DEFINITIONS.map((definition) => {
    const requiredMatches = definition.required.filter((header) => headerSet.has(header)).length;
    const signalMatches = definition.signals.filter((header) => headerSet.has(header)).length;
    const filenameNeedles = [
      definition.type,
      definition.type.replace(/_/g, ' '),
      definition.label.toLowerCase(),
      ...(definition.filenameSignals || [])
    ].map((value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    const normalizedFilename = filenameHint.replace(/[^a-z0-9]+/g, ' ').trim();
    const fileBonus = filenameNeedles.some((needle) => needle && normalizedFilename.includes(needle))
      ? 2
      : 0;
    const score = requiredMatches * 4 + signalMatches + fileBonus;
    return { ...definition, score, requiredMatches, signalMatches };
  }).sort((a, b) => b.score - a.score || b.signalMatches - a.signalMatches);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    return {
      type: 'unknown',
      label: 'Unknown Screaming Frog Export',
      confidence: 'low',
      normalizedHeaders,
      matchedSignals: []
    };
  }
  return {
    type: best.type,
    label: best.label,
    confidence: best.required.length && best.requiredMatches < best.required.length ? 'medium' : 'high',
    normalizedHeaders,
    matchedSignals: best.signals.filter((header) => headerSet.has(header))
  };
}

export function expectedScreamingFrogExportTypes() {
  return EXPORT_DEFINITIONS
    .filter((definition) => ['internal_html', 'response_codes', 'page_titles', 'meta_descriptions', 'h1', 'canonicals', 'directives', 'inlinks', 'outlinks', 'images', 'structured_data', 'hreflang'].includes(definition.type))
    .map((definition) => definition.type);
}
