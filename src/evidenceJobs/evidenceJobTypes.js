export const EVIDENCE_GAP_TYPES = Object.freeze([
  'needs_more_urls',
  'needs_specific_url_set',
  'needs_title_facts',
  'needs_meta_description_facts',
  'needs_h1_facts',
  'needs_canonical_facts',
  'needs_xrobots_facts',
  'needs_hreflang_facts',
  'needs_resource_facts',
  'needs_link_aggregates',
  'needs_schema_summary',
  'needs_raw_html_signal',
  'needs_rendered_html_sample',
  'needs_crux_psi',
  'needs_human_quality_review',
  'needs_legal_privacy_review',
  'needs_entity_trust_review',
  'needs_manual_strategy_context',
  'needs_larger_crawl',
  'needs_external_import'
]);

export const URL_SET_TYPES = Object.freeze([
  'current_run_urls',
  'known_url_facts',
  'sitemap_urls',
  'uploaded_url_list',
  'affected_sample_urls',
  'pattern_expansion'
]);

export const EVIDENCE_JOB_TYPES = Object.freeze({
  title_facts: job('title_facts', 'Title facts', {
    description: 'Fetch pages and store only status/indexability plus title length/hash/pattern facts.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'finalUrl', 'statusCode', 'indexability', 'title', 'titleLength', 'titleHash', 'titlePattern'],
    estimatedBytesPerUrl: 2500,
    closesGapTypes: ['needs_title_facts', 'needs_more_urls', 'needs_larger_crawl'],
    relatedCheckIds: ['tech.title_missing', 'tech.title_too_short', 'tech.title_too_long', 'tech.duplicate_titles', 'template.title_pattern_issue']
  }),
  meta_description_facts: job('meta_description_facts', 'Meta description facts', {
    description: 'Fetch pages and store only status/indexability plus meta description length/hash/pattern facts.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'finalUrl', 'statusCode', 'indexability', 'metaDescription', 'metaDescriptionLength', 'metaDescriptionHash', 'metaDescriptionPattern'],
    estimatedBytesPerUrl: 2500,
    closesGapTypes: ['needs_meta_description_facts', 'needs_more_urls', 'needs_larger_crawl'],
    relatedCheckIds: ['tech.meta_description_missing', 'tech.meta_description_too_short', 'tech.meta_description_too_long', 'tech.duplicate_meta_descriptions', 'template.meta_pattern_issue']
  }),
  h1_facts: job('h1_facts', 'H1 facts', {
    description: 'Fetch pages and store only H1 count/text hash/pattern facts.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'statusCode', 'indexability', 'h1Count', 'h1Text', 'h1Hash', 'h1Pattern'],
    estimatedBytesPerUrl: 3000,
    closesGapTypes: ['needs_h1_facts', 'needs_more_urls'],
    relatedCheckIds: ['tech.h1_missing', 'tech.multiple_h1', 'tech.html_semantics_summary']
  }),
  canonical_robots_facts: job('canonical_robots_facts', 'Canonical/robots facts', {
    description: 'Fetch pages and response headers, then store canonical, meta robots, X-Robots-Tag and indexability facts.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'finalUrl', 'statusCode', 'canonical', 'metaRobots', 'xRobotsTag', 'indexability'],
    estimatedBytesPerUrl: 3500,
    closesGapTypes: ['needs_canonical_facts', 'needs_xrobots_facts', 'needs_more_urls', 'needs_larger_crawl'],
    relatedCheckIds: ['tech.canonical_missing', 'tech.canonical_non_self', 'tech.canonical_to_other_domain', 'tech.canonical_target_non_200', 'tech.noindex_pages', 'tech.x_robots_tag_unusual', 'template.canonical_pattern_issue', 'template.noindex_pattern']
  }),
  hreflang_facts: job('hreflang_facts', 'Hreflang facts', {
    description: 'Fetch pages and store compact hreflang language/region/x-default target facts. Full return-link validation still needs broader data.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'finalUrl', 'statusCode', 'hreflangCount', 'languages', 'regions', 'hasXDefault', 'hasSelfLanguage', 'canonicalHreflangConflict', 'hreflangSummaryHash'],
    estimatedBytesPerUrl: 3500,
    closesGapTypes: ['needs_hreflang_facts', 'needs_external_import'],
    relatedCheckIds: ['tech.hreflang_x_default_missing'],
    safetyNotes: [
      'Does not validate hreflang return links.',
      'x-default missing is not treated as a hard issue by this targeted job.',
      'Stores compact entries and hashes only.'
    ]
  }),
  resource_facts: job('resource_facts', 'Resource facts', {
    description: 'Collect compact CSS/JS counts, third-party origins, resource hints and header/content-length signals without storing raw asset lists.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list', 'affected_sample_urls'],
    maxUrls: 25000,
    factsToExtract: ['url', 'scriptCount', 'stylesheetCount', 'thirdPartyOrigins', 'resourceHints', 'contentLengthSignals', 'renderBlockingCandidates'],
    estimatedBytesPerUrl: 12000,
    closesGapTypes: ['needs_resource_facts', 'needs_crux_psi', 'needs_external_import'],
    relatedCheckIds: ['tech.too_many_js', 'tech.too_many_css', 'tech.large_js_total', 'tech.large_css_total', 'tech.third_party_scripts_detected', 'tech.preload_missing', 'tech.preconnect_missing', 'tech.resource_hints_summary', 'tech.imported_resource_performance_signals']
  }),
  schema_summary_facts: job('schema_summary_facts', 'Structured data summary facts', {
    description: 'Extract schema type counts, JSON-LD hashes and capped parse-error summaries without storing full raw schema blobs.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'finalUrl', 'statusCode', 'schemaBlockCount', 'jsonLdBlockCount', 'schemaTypes', 'jsonLdHashes', 'cappedJsonLdExcerpt', 'parseErrors', 'schemaSummaryHash'],
    estimatedBytesPerUrl: 6500,
    closesGapTypes: ['needs_schema_summary', 'needs_more_urls'],
    relatedCheckIds: ['tech.schema_types_coverage_summary', 'tech.json_ld_parse_errors', 'tech.product_coverage_on_product_like_pages', 'tech.article_coverage_on_article_like_pages', 'tech.breadcrumb_missing_low_coverage', 'template.schema_missing_pattern'],
    safetyNotes: [
      'Does not store full JSON-LD raw blobs.',
      'Stores schema types, hashes and a capped 2 KB excerpt only.',
      'Parse errors are capped and do not fail the job.'
    ]
  }),
  link_aggregate_facts: job('link_aggregate_facts', 'Link aggregate facts', {
    description: 'Store internal/external link counts, unique target counts and coarse navigation/footer/content aggregates without raw link lists.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list'],
    maxUrls: 50000,
    factsToExtract: ['url', 'internalLinkCount', 'externalLinkCount', 'uniqueInternalTargets', 'navFooterContentCounts', 'inlinkAggregateIfAvailable'],
    estimatedBytesPerUrl: 14000,
    closesGapTypes: ['needs_link_aggregates', 'needs_more_urls', 'needs_larger_crawl'],
    relatedCheckIds: ['tech.internal_links_to_3xx', 'tech.internal_links_to_4xx_5xx', 'tech.orphan_like_sitemap_urls']
  }),
  raw_html_signal_facts: job('raw_html_signal_facts', 'Raw HTML critical signal facts', {
    description: 'Extract raw HTML presence signals for title/meta/H1/main content/critical terms without storing raw HTML.',
    requiredUrlSet: ['known_url_facts', 'sitemap_urls', 'uploaded_url_list', 'affected_sample_urls'],
    maxUrls: 25000,
    factsToExtract: ['url', 'rawTitlePresent', 'rawMetaPresent', 'rawH1Present', 'rawMainContentSignals', 'rawImportantLinkSignals'],
    estimatedBytesPerUrl: 6000,
    closesGapTypes: ['needs_raw_html_signal', 'needs_more_urls'],
    relatedCheckIds: ['tech.critical_content_raw_html_signal', 'tech.raw_h1_missing_rendered_present', 'tech.raw_internal_links_fewer_rendered', 'tech.rendered_word_count_delta', 'template.js_required_content']
  }),
  rendered_sample_facts: job('rendered_sample_facts', 'Rendered sample facts', {
    description: 'Run capped Playwright samples to compare raw vs rendered SEO-critical elements. Expensive and sample-only by design.',
    requiredUrlSet: ['affected_sample_urls', 'uploaded_url_list'],
    maxUrls: 200,
    factsToExtract: ['url', 'rawVsRenderedTitle', 'rawVsRenderedH1', 'rawVsRenderedLinks', 'rawVsRenderedWordCount', 'consoleErrorSummary'],
    storesRenderedHtml: false,
    estimatedBytesPerUrl: 45000,
    closesGapTypes: ['needs_rendered_html_sample'],
    relatedCheckIds: ['tech.raw_h1_missing_rendered_present', 'tech.raw_internal_links_fewer_rendered', 'tech.rendered_word_count_delta']
  }),
  human_quality_review: job('human_quality_review', 'Human quality review', {
    description: 'Review checklist for qualitative SEO/GEO/trust judgments that should not be closed by crawler facts alone.',
    requiredUrlSet: ['affected_sample_urls'],
    maxUrls: 50,
    storageProfile: 'review_only',
    factsToExtract: ['reviewChecklist', 'sampleUrls', 'reviewVerdict'],
    estimatedBytesPerUrl: 1000,
    closesGapTypes: ['needs_human_quality_review', 'needs_entity_trust_review', 'needs_manual_strategy_context'],
    relatedCheckIds: ['trust.eeat_signal_summary', 'trust.ymyl_review_signal', 'llm.geo_answerability_sample', 'llm.trust_clarity_sample']
  }),
  legal_privacy_review: job('legal_privacy_review', 'Legal/privacy review', {
    description: 'Human review queue for consent, privacy and legal-policy topics. Technical signals can support but not replace review.',
    requiredUrlSet: ['affected_sample_urls'],
    maxUrls: 50,
    storageProfile: 'review_only',
    factsToExtract: ['consentSignals', 'policyLinks', 'reviewVerdict'],
    estimatedBytesPerUrl: 1000,
    closesGapTypes: ['needs_legal_privacy_review'],
    relatedCheckIds: ['tech.consent_technical_signals']
  })
});

export function getEvidenceJobType(jobType) {
  return EVIDENCE_JOB_TYPES[jobType] || null;
}

export function estimateEvidenceJobStorage(jobTypeOrDefinition, maxUrls) {
  const definition = typeof jobTypeOrDefinition === 'string' ? getEvidenceJobType(jobTypeOrDefinition) : jobTypeOrDefinition;
  if (!definition) return null;
  const urls = Math.max(0, Number(maxUrls || definition.maxUrls || 0));
  const bytesPerUrl = Number(definition.estimatedBytesPerUrl || 0);
  const projection = {
    maxUrls: urls,
    bytesPerUrl,
    estimatedBytes: urls * bytesPerUrl,
    estimated10kBytes: 10000 * bytesPerUrl,
    estimated50kBytes: 50000 * bytesPerUrl,
    estimated400kBytes: 400000 * bytesPerUrl
  };
  return {
    ...projection,
    estimatedHuman: humanBytes(projection.estimatedBytes),
    estimated10kHuman: humanBytes(projection.estimated10kBytes),
    estimated50kHuman: humanBytes(projection.estimated50kBytes),
    estimated400kHuman: humanBytes(projection.estimated400kBytes),
    riskLevel: riskLevel(bytesPerUrl, urls),
    safetyNotes: definition.safetyNotes || safetyNotesFor(definition)
  };
}

function job(jobType, label, options = {}) {
  const definition = {
    jobType,
    label,
    description: options.description || '',
    requiredUrlSet: options.requiredUrlSet || ['known_url_facts'],
    maxUrls: options.maxUrls || 10000,
    storageProfile: options.storageProfile || 'targeted_minimal',
    factsToExtract: options.factsToExtract || [],
    storesRawHtml: Boolean(options.storesRawHtml),
    storesRenderedHtml: Boolean(options.storesRenderedHtml),
    estimatedBytesPerUrl: options.estimatedBytesPerUrl || 5000,
    estimatedRuntime: options.estimatedRuntime || runtimeEstimate(options.maxUrls || 10000),
    closesGapTypes: options.closesGapTypes || [],
    relatedCheckIds: options.relatedCheckIds || [],
    safetyNotes: options.safetyNotes || []
  };
  return Object.freeze(definition);
}

function runtimeEstimate(maxUrls) {
  if (maxUrls <= 500) return 'minutes';
  if (maxUrls <= 25000) return 'tens_of_minutes';
  return 'hours';
}

function riskLevel(bytesPerUrl, urls) {
  const projected = bytesPerUrl * urls;
  if (bytesPerUrl <= 5000 && projected <= 250 * 1024 * 1024) return 'low';
  if (bytesPerUrl <= 20000 && projected <= 2 * 1024 * 1024 * 1024) return 'medium';
  return 'high';
}

function safetyNotesFor(definition = {}) {
  const notes = [];
  if (!definition.storesRawHtml) notes.push('Does not store raw HTML.');
  if (!definition.storesRenderedHtml) notes.push('Does not store rendered HTML.');
  if (/link|resource|schema/i.test(definition.jobType || '')) notes.push('Stores aggregates/summaries only; raw lists are capped or omitted.');
  if (definition.jobType === 'rendered_sample_facts') notes.push('Rendered comparison is capped and should stay sample-only.');
  return notes;
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}
