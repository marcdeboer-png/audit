import { normalizeCategory, normalizeList, text } from './referenceAuditModel.js';

export const REFERENCE_MAPPING_RULES = Object.freeze([
  rule('title', /title|titel|seitentitel/, ['tech.title_missing', 'tech.title_too_short', 'tech.title_too_long', 'tech.duplicate_titles'], {
    category: 'html-head',
    patternCheckIds: ['template.title_pattern_issue']
  }),
  rule('meta-description', /meta.?description|description|beschreibung/, ['tech.meta_description_missing', 'tech.meta_description_too_short', 'tech.meta_description_too_long', 'tech.duplicate_meta_descriptions'], {
    category: 'html-head',
    patternCheckIds: ['template.meta_pattern_issue']
  }),
  rule('h1', /\bh1\b|headline|hauptueberschrift|hauptüberschrift/, ['tech.h1_missing', 'tech.multiple_h1'], {
    category: 'html-head'
  }),
  rule('noindex', /noindex|nicht indexierbar|indexierbarkeit|indexability/, ['tech.noindex_pages'], {
    category: 'technical-seo',
    patternCheckIds: ['template.noindex_pattern']
  }),
  rule('canonical', /canonical|kanonisch|canonicalized|canonicalised/, ['tech.canonical_missing', 'tech.canonical_non_self', 'tech.canonical_to_other_domain', 'tech.canonical_target_non_200'], {
    category: 'technical-seo',
    patternCheckIds: ['template.canonical_pattern_issue']
  }),
  rule('status-redirect', /status.?code|4xx|5xx|redirect|weiterleitung|server.?error/, ['tech.status_code_distribution', 'tech.4xx_pages', 'tech.5xx_pages', 'tech.redirect_pages'], {
    category: 'technical-seo'
  }),
  rule('https-www-redirect', /https|http to https|non.?www|www.?non.?www|temporary 307|307.*301|redirect chain|trailing slash/, ['tech.https_reachable', 'tech.http_to_https_redirect', 'tech.www_non_www_consistency', 'tech.redirect_pages'], {
    category: 'technical-seo',
    requiredData: ['protocol_redirect_checks', 'response_headers']
  }),
  rule('compression', /compression|gzip|brotli|content-encoding/, ['tech.compression_header'], {
    category: 'media-performance',
    requiredData: ['response_headers']
  }),
  rule('http-version', /http\/2|http2|http version|h2\b|http protocol/, ['tech.http_version_support'], {
    category: 'media-performance',
    requiredData: ['requests_audit', 'protocol_version'],
    sourceTypes: ['external', 'screaming_frog_import'],
    requiresExternalData: true
  }),
  rule('charset-lang-viewport', /charset|utf-?8|html lang|language attribute|viewport meta|mobile rendering/, ['tech.charset_utf8_present', 'tech.html_lang_missing', 'tech.viewport_missing'], {
    category: 'html-head'
  }),
  rule('internal-links', /internal link|interne link|broken link|3xx|4xx|orphan/, ['tech.internal_links_to_3xx', 'tech.internal_links_to_4xx_5xx', 'tech.orphan_like_sitemap_urls'], {
    category: 'technical-seo'
  }),
  rule('robots-sitemap-pagination', /robots\.txt|sitemap|xml sitemap|pagination|rel=next|rel next|rel prev|paginated/, ['tech.robots_txt_present', 'tech.sitemap_present', 'tech.sitemap_in_robots', 'tech.sitemap_urls_non_200', 'tech.noindex_pages'], {
    category: 'technical-seo',
    requiredData: ['sitemap', 'robots', 'url_patterns']
  }),
  rule('hreflang', /hreflang|x-default|internationali[sz]ation|language.country|language region/, ['tech.hreflang_x_default_missing'], {
    category: 'html-head',
    sourceTypes: ['screaming_frog_import', 'external'],
    requiredData: ['hreflang_export'],
    requiresExternalData: true
  }),
  rule('schema', /schema|structured data|strukturierte daten|json.?ld/, ['tech.schema_types_coverage_summary', 'tech.json_ld_parse_errors'], {
    category: 'structured-data',
    patternCheckIds: ['template.schema_missing_pattern']
  }),
  rule('article-schema', /article schema|artikel.?schema|blog.*article/, ['tech.article_coverage_on_article_like_pages', 'geo.article_blog_pages_article_schema'], {
    category: 'structured-data',
    patternCheckIds: ['template.schema_missing_pattern']
  }),
  rule('breadcrumb-schema', /breadcrumb|breadcrumblist/, ['tech.breadcrumb_missing_low_coverage', 'geo.breadcrumblist_present'], {
    category: 'structured-data',
    patternCheckIds: ['template.schema_missing_pattern']
  }),
  rule('product-schema', /product schema|produkt.?schema|schema.*pdp|pdp.*schema/, ['tech.product_coverage_on_product_like_pages'], {
    category: 'structured-data',
    patternCheckIds: ['template.schema_missing_pattern']
  }),
  rule('large-html', /html.?size|html.?groesse|html.?größe|large html|dom size/, ['tech.raw_html_size_large'], {
    category: 'media-performance',
    patternCheckIds: ['template.large_html_pattern']
  }),
  rule('image-alt', /alt.?text|alt text|fehlende alt|image alt|bilder.*alt/, ['tech.images_without_alt', 'tech.empty_alt_texts'], {
    category: 'media-performance'
  }),
  rule('lazy-loading', /lazy.?loading|loading=.lazy|bilder.*lazy/, ['tech.images_without_lazy_loading'], {
    category: 'media-performance'
  }),
  rule('image-dimensions', /width|height|bildgroesse|bildgröße|dimensions/, ['tech.images_without_width_height'], {
    category: 'media-performance'
  }),
  rule('security-headers', /security|hsts|csp|content security|x-frame|x-content|referrer|permissions policy/, ['tech.hsts_header', 'tech.content_security_policy', 'tech.x_frame_options', 'tech.x_content_type_options', 'tech.referrer_policy', 'tech.permissions_policy'], {
    category: 'security-server'
  }),
  rule('cache-cdn', /cache|cdn|edge|expires|cache-control|azure front door|config_nocache|x-cache|cf-cache|akamai|fastly/, ['tech.cache_control_header', 'tech.cdn_cache_signals'], {
    category: 'media-performance',
    requiredData: ['response_headers', 'cdn_headers']
  }),
  rule('ttfb', /ttfb|time to first byte|server response|origin server|azure front door/, ['tech.high_ttfb'], {
    category: 'media-performance',
    requiredData: ['timing_facts', 'response_headers']
  }),
  rule('crux-psi', /crux|psi|page.?speed|core web vitals|lcp|inp|cls|field data|felddaten/, ['template.low_lighthouse_performance', 'template.high_lcp', 'template.high_tbt'], {
    category: 'media-performance',
    sourceTypes: ['screaming_frog_import', 'external'],
    requiredData: ['crux', 'psi', 'lighthouse'],
    requiresExternalData: true
  }),
  rule('js-css', /javascript|\bjs\b|css|resource|asset|script|stylesheet/, ['tech.too_many_js', 'tech.too_many_css', 'tech.large_js_total', 'tech.large_css_total', 'tech.third_party_scripts_detected'], {
    category: 'media-performance',
    requiredData: ['resource_facts']
  }),
  rule('critical-css-preload-fonts', /critical path css|render-blocking|preload|preconnect|dns-prefetch|font preload|web fonts|lcp image|fetchpriority|largest visible element|resource hints?/, ['tech.too_many_css', 'tech.large_css_total', 'tech.third_party_scripts_detected', 'tech.preload_missing', 'tech.preconnect_missing', 'tech.resource_hints_summary', 'tech.imported_resource_performance_signals', 'template.high_lcp', 'template.high_tbt'], {
    category: 'media-performance',
    sourceTypes: ['crawl', 'external', 'screaming_frog_import'],
    requiredData: ['resource_facts', 'browser_check', 'lighthouse']
  }),
  rule('open-graph', /open graph|\bog:|social preview|facebook sharing|social metadata/, ['tech.open_graph_basics_missing'], {
    category: 'html-head',
    requiredData: ['html_head']
  }),
  rule('webmanifest-favicon-pwa', /web manifest|manifest|pwa|favicon|app icon|apple-touch-icon|add to home screen/, ['tech.webmanifest_missing', 'tech.favicon_missing', 'tech.app_icons_incomplete'], {
    category: 'html-head',
    requiredData: ['html_head', 'browser_check']
  }),
  rule('consent-privacy-tagmanager', /consent|cookie banner|cookiebot|onetrust|usercentrics|didomi|consentmanager|google consent mode|tag manager|gtm|dataLayer|meta pixel|gdpr|dsgvo/, ['tech.consent_technical_signals'], {
    category: 'consent-privacy',
    sourceTypes: ['crawl', 'screaming_frog_import', 'external'],
    requiredData: ['browser_check', 'html_head', 'tag_manager_inventory'],
    requiresHumanJudgment: true
  }),
  rule('facet-bloat', /facet|facette|filter|sortier|sort|parameter|crawl.?bloat|pagination|paginierung/, [], {
    category: 'technical-seo',
    sourceTypes: ['crawl', 'screaming_frog_import'],
    requiredData: ['url_patterns', 'parameter_inventory'],
    possibleCheckId: 'tech.facet_filter_crawl_bloat',
    partialCheckIds: ['template.canonical_pattern_issue', 'tech.orphan_like_sitemap_urls']
  }),
  rule('llms', /llms\.txt|llms-full|markdown twin/, ['geo.llms_txt_present', 'geo.llms_txt_http_status', 'geo.llms_full_txt_present', 'geo.markdown_twin_homepage'], {
    category: 'geo-readiness'
  }),
  rule('ai-bots', /ai bot|gptbot|oai-searchbot|chatgpt-user|claudebot|perplexity|google-extended|ccbot|crawler policy/, ['geo.ai_bots_policy_summary', 'geo.robots_mentions_gptbot', 'geo.robots_mentions_oai_searchbot', 'geo.robots_mentions_chatgpt_user', 'geo.robots_mentions_claudebot', 'geo.robots_mentions_perplexitybot', 'geo.robots_mentions_google_extended', 'geo.robots_mentions_ccbot'], {
    category: 'ai-crawler-policy'
  }),
  rule('trust-entity', /e-?e-?a-?t|trust|author|quellenhinweis|source link|external source|entity|brand|marke|about|kontakt|contact|impressum|datenschutz/, ['geo.impressum_linked', 'geo.datenschutz_linked', 'geo.about_linked', 'geo.contact_linked', 'geo.source_or_external_links_present', 'geo.author_hints_present'], {
    category: 'trust-entity',
    requiresHumanJudgment: true
  }),
  rule('geo-quality', /geo|ai search|answerability|answer.?fähig|helpful|intent|suchintention|content quality|faq quality/, ['geo.tables_present', 'geo.bulletpoints_lists_present', 'geo.low_structured_sections'], {
    category: 'geo-readiness',
    sourceTypes: ['llm', 'crawl'],
    requiresLlmJudgment: true,
    partialCheckIds: ['llm.geo_answerability_sample', 'llm.trust_clarity_sample']
  })
]);

export function mapReferenceItemToChecks(item = {}, options = {}) {
  const haystack = [
    item.title,
    item.description,
    item.category,
    item.recommendation,
    item.notes,
    Object.values(item.evidence || {}).join(' ')
  ].map(text).join(' ').toLowerCase();
  const explicit = normalizeList(item.expectedToolCheckIds);
  const exactRules = REFERENCE_MAPPING_RULES.filter((mappingRule) => mappingRule.pattern.test(haystack));
  const categoryRules = REFERENCE_MAPPING_RULES.filter((mappingRule) => mappingRule.category === normalizeCategory(item.category));
  const matchedRules = exactRules.length ? exactRules : categoryRules;
  const checkIds = unique([
    ...explicit,
    ...matchedRules.flatMap((mappingRule) => mappingRule.checkIds),
    ...matchedRules.flatMap((mappingRule) => mappingRule.partialCheckIds || [])
  ]);
  const patternCheckIds = unique(matchedRules.flatMap((mappingRule) => mappingRule.patternCheckIds || []));
  const requiredData = unique([
    ...normalizeList(item.expectedDataSources),
    ...matchedRules.flatMap((mappingRule) => mappingRule.requiredData || [])
  ]);
  const sourceTypes = unique(matchedRules.flatMap((mappingRule) => mappingRule.sourceTypes || ['crawl', 'screaming_frog_import']));
  const possibleCheckIds = unique([
    ...matchedRules.map((mappingRule) => mappingRule.possibleCheckId).filter(Boolean),
    ...patternCheckIds
  ]);
  const requiresExternalData = Boolean(item.requiresExternalData || matchedRules.some((mappingRule) => mappingRule.requiresExternalData));
  const requiresHumanJudgment = Boolean(item.requiresHumanJudgment || matchedRules.some((mappingRule) => mappingRule.requiresHumanJudgment));
  const requiresLlmJudgment = Boolean(item.requiresLlmJudgment || matchedRules.some((mappingRule) => mappingRule.requiresLlmJudgment));

  return {
    itemId: item.id,
    category: matchedRules[0]?.category || normalizeCategory(item.category),
    expectedCheckIds: unique([...checkIds, ...patternCheckIds]),
    directCheckIds: checkIds,
    patternCheckIds,
    possibleCheckIds,
    requiredData,
    sourceTypes,
    requiresExternalData,
    requiresHumanJudgment,
    requiresLlmJudgment,
    matchedRules: matchedRules.map((mappingRule) => mappingRule.id),
    mappingConfidence: explicit.length || exactRules.length ? 'high' : matchedRules.length ? 'medium' : 'low',
    customMappings: options.customMappings || []
  };
}

function rule(id, pattern, checkIds, options = {}) {
  return {
    id,
    pattern,
    checkIds,
    category: options.category || 'uncategorized',
    patternCheckIds: options.patternCheckIds || [],
    partialCheckIds: options.partialCheckIds || [],
    sourceTypes: options.sourceTypes || ['crawl', 'screaming_frog_import'],
    requiredData: options.requiredData || [],
    possibleCheckId: options.possibleCheckId || null,
    requiresExternalData: Boolean(options.requiresExternalData),
    requiresHumanJudgment: Boolean(options.requiresHumanJudgment),
    requiresLlmJudgment: Boolean(options.requiresLlmJudgment)
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
