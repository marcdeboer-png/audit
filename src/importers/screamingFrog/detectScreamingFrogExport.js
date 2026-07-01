import { normalizeHeader } from './parseScreamingFrogCsv.js';

const EXPORT_DEFINITIONS = [
  {
    type: 'internal_html',
    label: 'Internal HTML',
    required: ['address'],
    signals: ['content_type', 'indexability', 'title_1', 'meta_description_1', 'h1_1', 'canonical_link_element_1']
  },
  {
    type: 'response_codes',
    label: 'Response Codes',
    required: ['address', 'status_code'],
    signals: ['status', 'indexability']
  },
  {
    type: 'page_titles',
    label: 'Page Titles',
    required: ['address'],
    signals: ['title_1', 'title_1_length', 'title_1_pixel_width']
  },
  {
    type: 'meta_descriptions',
    label: 'Meta Description',
    required: ['address'],
    signals: ['meta_description_1', 'meta_description_1_length', 'meta_description_1_pixel_width']
  },
  {
    type: 'h1',
    label: 'H1',
    required: ['address'],
    signals: ['h1_1', 'h1_1_length', 'h1_1_occurrences']
  },
  {
    type: 'h2',
    label: 'H2',
    required: ['address'],
    signals: ['h2_1', 'h2_1_length', 'h2_1_occurrences']
  },
  {
    type: 'canonicals',
    label: 'Canonicals',
    required: ['address'],
    signals: ['canonical_link_element_1', 'canonicalised', 'canonical_link_element_1_status_code']
  },
  {
    type: 'directives',
    label: 'Directives',
    required: ['address'],
    signals: ['meta_robots_1', 'x_robots_tag_1', 'indexability_status']
  },
  {
    type: 'inlinks',
    label: 'Inlinks',
    required: ['source', 'destination'],
    signals: ['anchor_text', 'type', 'follow']
  },
  {
    type: 'outlinks',
    label: 'Outlinks',
    required: ['source', 'destination'],
    signals: ['anchor_text', 'type', 'follow']
  },
  {
    type: 'images',
    label: 'Images',
    required: [],
    signals: ['image', 'alt_text', 'source', 'size_bytes', 'missing_alt_text']
  },
  {
    type: 'structured_data',
    label: 'Structured Data',
    required: ['address'],
    signals: ['type', 'validation_status', 'schema_type']
  },
  {
    type: 'psi_crux',
    label: 'PSI/CrUX',
    required: ['address'],
    signals: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift', 'performance_score']
  }
];

export function detectScreamingFrogExport(headers = [], filename = '') {
  const normalizedHeaders = headers.map(normalizeHeader);
  const headerSet = new Set(normalizedHeaders);
  const filenameHint = String(filename || '').toLowerCase();
  const candidates = EXPORT_DEFINITIONS.map((definition) => {
    const requiredMatches = definition.required.filter((header) => headerSet.has(header)).length;
    const signalMatches = definition.signals.filter((header) => headerSet.has(header)).length;
    const fileBonus = filenameHint.includes(definition.type.replace(/_/g, ' ')) || filenameHint.includes(definition.label.toLowerCase())
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
    .filter((definition) => ['internal_html', 'response_codes', 'page_titles', 'meta_descriptions', 'h1', 'canonicals'].includes(definition.type))
    .map((definition) => definition.type);
}
