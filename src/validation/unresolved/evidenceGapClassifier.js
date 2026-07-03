import { EVIDENCE_GAP_TYPES } from '../../evidenceJobs/evidenceJobTypes.js';

export function classifyEvidenceGaps(row = {}) {
  const manual = row.manualItem || {};
  const haystack = searchable([
    manual.title,
    manual.description,
    manual.category,
    manual.recommendation,
    row.partialReason,
    ...(row.missingReasons || []),
    ...(row.requiredData || []),
    ...(row.expectedCheckIds || [])
  ]);
  const gaps = new Set();

  if (row.coverageStatus === 'covered_in_sample' || row.sampleBased || row.partialReason === 'sample_too_small') {
    gaps.add('needs_more_urls');
    gaps.add('needs_larger_crawl');
  }
  if ((row.missingReasons || []).includes('missing_url_overlap')) gaps.add('needs_specific_url_set');
  if (row.requiresExternalData || (row.missingReasons || []).includes('missing_data_source')) gaps.add('needs_external_import');
  if (row.requiresHumanJudgment || row.requiresLlmJudgment || (row.missingReasons || []).includes('human_review_needed')) {
    gaps.add('needs_human_quality_review');
  }

  addByPattern(gaps, haystack, /(^|[^a-z])title(?!_match)|seitentitel|title_pattern|tech\.title|template\.title/, 'needs_title_facts');
  addByPattern(gaps, haystack, /meta.?description|beschreibung|meta_description|template\.meta/, 'needs_meta_description_facts');
  addByPattern(gaps, haystack, /\bh1\b|heading|ueberschrift|überschrift|html_semantics|multiple_h1|h1_missing/, 'needs_h1_facts');
  addByPattern(gaps, haystack, /canonical|kanonisch|canonical_pattern/, 'needs_canonical_facts');
  addByPattern(gaps, haystack, /x-?robots|x_robots|meta robots|noindex|indexability|robots tag/, 'needs_xrobots_facts');
  addByPattern(gaps, haystack, /hreflang|x-default|international|language|region|at\/ch|maxizoo/, 'needs_hreflang_facts');
  addByPattern(gaps, haystack, /lcp|fcp|inp|cls|performance|web fonts|resource|preload|preconnect|css|js|script|third.?party|image implementation|file types|resource_facts/, 'needs_resource_facts');
  addByPattern(gaps, haystack, /internal link|linking|navigation|silo|orphan|crawl budget|faceted|facet|filter|pagination|sitemap|link_aggregate/, 'needs_link_aggregates');
  addByPattern(gaps, haystack, /schema|structured data|json.?ld|breadcrumb|product schema|article schema|geo.*structured/, 'needs_schema_summary');
  addByPattern(gaps, haystack, /raw html|critical content|server.?render|initial html|critical seo/, 'needs_raw_html_signal');
  addByPattern(gaps, haystack, /rendered html|playwright|hydration|csr|ssr|rendering mode|js.?dependent/, 'needs_rendered_html_sample');
  addByPattern(gaps, haystack, /crux|psi|page.?speed|core web vitals|field data|lighthouse/, 'needs_crux_psi');
  addByPattern(gaps, haystack, /e-?e-?a-?t|ymyl|trust|entity|brand|citability|author|source|quality/, 'needs_entity_trust_review');
  addByPattern(gaps, haystack, /consent|privacy|cookie|gdpr|dsgvo|legal|datenschutz/, 'needs_legal_privacy_review');
  addByPattern(gaps, haystack, /strategy|strategic|business|policy|manual context|stakeholder/, 'needs_manual_strategy_context');

  if (!gaps.size && row.coverageStatus === 'partially_covered') gaps.add('needs_more_urls');
  return [...gaps].filter((gap) => EVIDENCE_GAP_TYPES.includes(gap));
}

export function primaryGapType(gapTypes = []) {
  const priority = [
    'needs_external_import',
    'needs_crux_psi',
    'needs_hreflang_facts',
    'needs_human_quality_review',
    'needs_legal_privacy_review',
    'needs_entity_trust_review',
    'needs_larger_crawl',
    'needs_more_urls',
    'needs_title_facts',
    'needs_meta_description_facts',
    'needs_h1_facts',
    'needs_canonical_facts',
    'needs_xrobots_facts',
    'needs_resource_facts',
    'needs_link_aggregates',
    'needs_schema_summary',
    'needs_raw_html_signal',
    'needs_rendered_html_sample'
  ];
  return priority.find((gap) => gapTypes.includes(gap)) || gapTypes[0] || null;
}

function addByPattern(gaps, haystack, pattern, gapType) {
  if (pattern.test(haystack)) gaps.add(gapType);
}

function searchable(values = []) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}
