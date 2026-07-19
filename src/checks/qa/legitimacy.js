export const legitCheckFamilies = [
  {
    family: 'Title',
    checkIds: ['tech.title_missing', 'tech.title_too_short', 'tech.title_too_long', 'tech.duplicate_titles'],
    dataBasis: 'pages.title/titleLength on stored HTML pages',
    expectation: 'Missing titles can be core findings; length and duplicate findings remain evidence-based warnings.'
  },
  {
    family: 'Meta Description',
    checkIds: ['tech.meta_description_missing', 'tech.meta_description_too_short', 'tech.meta_description_too_long', 'tech.duplicate_meta_descriptions'],
    dataBasis: 'pages.metaDescription/metaDescriptionLength on stored HTML pages',
    expectation: 'Descriptions are SERP/snippet quality signals, so missing or weak values are warnings, not fatal crawl errors.'
  },
  {
    family: 'Canonical',
    checkIds: ['tech.canonical_missing', 'tech.canonical_non_self', 'tech.canonical_to_other_domain', 'tech.canonical_target_non_200'],
    dataBasis: 'pages.canonical plus known crawl status for canonical targets',
    expectation: 'Canonical problems use stored targets and status evidence; unknown targets are not invented as errors.'
  },
  {
    family: 'Indexability',
    checkIds: ['tech.noindex_pages', 'tech.nofollow_pages', 'tech.x_robots_tag_unusual'],
    dataBasis: 'meta robots, X-Robots-Tag and pageType',
    expectation: 'Legal noindex pages are separated from content noindex findings.'
  },
  {
    family: 'Status Codes',
    checkIds: ['tech.4xx_pages', 'tech.5xx_pages', 'tech.redirect_pages'],
    dataBasis: 'stored HTTP status codes from crawled pages',
    expectation: '5xx and linked 4xx/5xx can be hard issues; redirects and isolated 4xx are warnings with samples.'
  },
  {
    family: 'Internal Links',
    checkIds: ['tech.internal_links_to_3xx', 'tech.internal_links_to_4xx_5xx', 'tech.orphan_like_sitemap_urls'],
    dataBasis: 'page_links joined to known pages and sitemap/crawl inventory',
    expectation: 'Broken internal links are core issues only when target status is known.'
  },
  {
    family: 'H1',
    checkIds: ['tech.h1_missing', 'tech.multiple_h1', 'tech.raw_h1_missing_rendered_present'],
    dataBasis: 'raw and rendered H1 counts',
    expectation: 'Raw/rendered differences are rendering warnings with evidence, not invented content quality judgements.'
  },
  {
    family: 'Images',
    checkIds: ['tech.images_without_alt', 'tech.empty_alt_texts', 'tech.images_without_width_height', 'tech.images_without_lazy_loading', 'tech.large_image_resources', 'tech.modern_image_format_coverage_low'],
    dataBasis: 'page_images/resources with decorative/icon/badge/pixel heuristics',
    expectation: 'Decorative and tracking images are excluded from normal alt findings.'
  },
  {
    family: 'Performance Light',
    checkIds: ['tech.high_ttfb', 'tech.raw_html_size_large', 'tech.too_many_js', 'tech.too_many_css', 'tech.large_js_total', 'tech.large_css_total'],
    dataBasis: 'stored crawl timings and resource inventory',
    expectation: 'Lightweight performance checks are threshold warnings with central configuration.'
  },
  {
    family: 'Security Headers',
    checkIds: ['tech.hsts_header', 'tech.content_security_policy', 'tech.x_frame_options', 'tech.x_content_type_options', 'tech.referrer_policy', 'tech.permissions_policy'],
    dataBasis: 'response headers from stored HTML pages',
    expectation: 'Security headers are best-practice findings, not core SEO errors.'
  },
  {
    family: 'Structured Data',
    checkIds: ['tech.schema_types_coverage_summary', 'tech.breadcrumb_missing_low_coverage', 'tech.article_coverage_on_article_like_pages', 'tech.product_coverage_on_product_like_pages', 'tech.localbusiness_present_missing'],
    dataBasis: 'schemas plus pageType/template heuristics',
    expectation: 'Schema checks apply only to suitable page types or domain-level hints.'
  },
  {
    family: 'FAQ/Speakable',
    checkIds: ['tech.faqpage_missing_low_coverage', 'geo.faq_html_present_schema_missing', 'tech.speakable_missing', 'geo.speakable_present'],
    dataBasis: 'hasFaqPattern, weak FAQ hints and schema inventory',
    expectation: 'FAQPage requires strong FAQ structure; Speakable is an opportunity.'
  },
  {
    family: 'AI Files and Bot Policy',
    checkIds: ['geo.llms_txt_present', 'geo.llms_full_txt_present', 'geo.robots_mentions_gptbot', 'geo.ai_bots_policy_summary', 'geo.markdown_twin_homepage'],
    dataBasis: 'domain_assets, robots.txt parsing and known references',
    expectation: 'AI-readiness signals are opportunities unless a referenced local AI asset is demonstrably broken.'
  },
  {
    family: 'Template Rendering',
    checkIds: ['template.low_lighthouse_performance', 'template.low_lighthouse_seo', 'template.high_lcp', 'template.high_tbt', 'template.console_errors', 'template.js_required_content', 'template.lighthouse_unavailable', 'template.playwright_unavailable'],
    dataBasis: 'template samples, Playwright results and Lighthouse results',
    expectation: 'Unavailable local tooling is NA/info; collected poor metrics can become warnings.'
  }
];

export const legitCheckGuardrails = {
  opportunitiesAreNotCore: [
    'tech.webmanifest_missing',
    'tech.speakable_missing',
    'geo.llms_txt_present',
    'geo.llms_full_txt_present',
    'geo.robots_mentions_gptbot',
    'geo.markdown_twin_homepage',
    'tech.faqpage_missing_low_coverage',
    'geo.faq_html_present_schema_missing',
    'tech.article_coverage_on_article_like_pages',
    'tech.product_coverage_on_product_like_pages'
  ],
  bestPracticesAreNotCore: [
    'tech.hsts_header',
    'tech.content_security_policy',
    'tech.x_frame_options',
    'tech.x_content_type_options',
    'tech.referrer_policy',
    'tech.permissions_policy',
    'tech.images_without_width_height'
  ],
  unavailableToolingIsNotCore: [
    'template.lighthouse_unavailable',
    'template.playwright_unavailable'
  ],
  pageTypeScopedSchema: [
    'tech.article_coverage_on_article_like_pages',
    'geo.article_blog_pages_article_schema',
    'tech.product_coverage_on_product_like_pages',
    'tech.localbusiness_present_missing',
    'tech.videoobject_schema_present_missing'
  ]
};

const ALL_STATUSES = ['OK', 'Warning', 'Error', 'NA'];
const ISSUE_TYPES = ['core_issue', 'info'];
const OPPORTUNITY_TYPES = ['opportunity', 'info'];
const BEST_PRACTICE_TYPES = ['best_practice', 'info'];
const TEMPLATE_TYPES = ['core_issue', 'best_practice', 'info'];

function expectation(checkId, {
  expectedScope,
  allowedStatuses = ALL_STATUSES,
  allowedFindingTypes = ISSUE_TYPES,
  requiresEvidence = true,
  hardIssueAllowed = true,
  pageTypeScope = null,
  detailHandlerExpected = false
}) {
  return {
    checkId,
    expectedScope,
    allowedStatuses,
    allowedFindingTypes,
    requiresEvidence,
    hardIssueAllowed,
    pageTypeScope,
    detailHandlerExpected
  };
}

export const legitCheckExpectations = [
  expectation('tech.title_missing', {
    expectedScope: 'Indexable HTML pages with no stored title element.',
    allowedStatuses: ['OK', 'Error', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.title_too_short', {
    expectedScope: 'HTML pages with non-empty titleLength below configured titleTooShort.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.title_too_long', {
    expectedScope: 'HTML pages with titleLength above configured titleTooLong.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.meta_description_missing', {
    expectedScope: 'Indexable HTML pages with no stored meta description.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.meta_description_too_short', {
    expectedScope: 'HTML pages with non-empty metaDescriptionLength below configured descriptionTooShort.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.meta_description_too_long', {
    expectedScope: 'HTML pages with metaDescriptionLength above configured descriptionTooLong.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.canonical_missing', {
    expectedScope: 'Successful indexable non-legal HTML pages with complete effective metadata provenance and no effective canonical URL.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.canonical_non_self', {
    expectedScope: 'Successful indexable non-legal HTML pages whose effective canonical differs from the final served URL or has conflicting canonical tags; intent remains manual.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.canonical_to_other_domain', {
    expectedScope: 'Successful indexable non-legal HTML pages with an effective canonical on another registrable domain; intent remains manual.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.canonical_target_non_200', {
    expectedScope: 'Known canonical targets whose initial GET redirects, whose final GET is non-200, or whose final representation is non-HTML.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.noindex_pages', {
    expectedScope: 'Non-legal HTML pages with noindex directives; legal noindex is evidence but not a hard issue.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: false
  }),
  expectation('tech.nofollow_pages', {
    expectedScope: 'Non-legal HTML pages with page-level nofollow directives.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: false
  }),
  expectation('tech.x_robots_tag_unusual', {
    expectedScope: 'Non-legal pages with X-Robots-Tag noindex values.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: false
  }),
  expectation('tech.4xx_pages', {
    expectedScope: 'Stored page responses with HTTP status 400-499.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.5xx_pages', {
    expectedScope: 'Stored page responses with HTTP status 500 or higher.',
    allowedStatuses: ['OK', 'Error', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.redirect_pages', {
    expectedScope: 'Stored page URLs with 3xx status or finalUrl different from original URL.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.internal_links_to_3xx', {
    expectedScope: 'Internal links whose known crawled target is a redirect.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.internal_links_to_4xx_5xx', {
    expectedScope: 'Internal links whose known crawled target is a 4xx or 5xx page.',
    allowedStatuses: ['OK', 'Error', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.h1_missing', {
    expectedScope: 'HTML pages with no raw H1.',
    allowedStatuses: ['OK', 'Error', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.multiple_h1', {
    expectedScope: 'HTML pages with more than one raw H1.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.charset_utf8_present', {
    expectedScope: 'HTML pages without a UTF-8 signal in either HTTP Content-Type or HTML meta charset.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.cache_control_header', {
    expectedScope: 'HTML responses without a stored HTTP Cache-Control header; treated as server/performance best practice.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.raw_h1_missing_rendered_present', {
    expectedScope: 'Pages where raw H1 is absent but rendered H1 exists.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: false
  }),
  expectation('tech.images_without_alt', {
    expectedScope: 'Likely content images without meaningful alt text; decorative, badge, icon and tracking images excluded.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.empty_alt_texts', {
    expectedScope: 'Likely content images with an empty alt attribute; decorative images excluded.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.images_without_width_height', {
    expectedScope: 'Likely content images without width or height attributes; decorative, badge, icon and tracking images excluded.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.images_without_lazy_loading', {
    expectedScope: 'Likely non-critical content images whose loading attribute is missing or not lazy; decorative, small, hero, badge, icon and tracking images excluded.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.high_ttfb', {
    expectedScope: 'Pages with stored ttfbMs above configured highTtfbMs; network timing is volatile and should be confirmed before final prioritization.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  ...[
    'tech.hsts_header',
    'tech.content_security_policy',
    'tech.x_frame_options',
    'tech.x_content_type_options',
    'tech.referrer_policy',
    'tech.permissions_policy'
  ].map((checkId) => expectation(checkId, {
    expectedScope: 'HTML pages missing a security best-practice response header.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: BEST_PRACTICE_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  })),
  expectation('tech.json_ld_parse_errors', {
    expectedScope: 'Stored JSON-LD blocks with parseStatus=error.',
    allowedStatuses: ['OK', 'Error', 'NA'],
    detailHandlerExpected: true
  }),
  expectation('tech.breadcrumb_missing_low_coverage', {
    expectedScope: 'Eligible deeper detail pages without BreadcrumbList schema; homepage and index/legal/contact pages excluded.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    pageTypeScope: ['article', 'product', 'category', 'location', 'deeper_detail'],
    detailHandlerExpected: true
  }),
  expectation('geo.breadcrumblist_present', {
    expectedScope: 'GEO BreadcrumbList presence on eligible deeper pages.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    pageTypeScope: ['article', 'product', 'category', 'location', 'deeper_detail'],
    detailHandlerExpected: true
  }),
  expectation('tech.article_coverage_on_article_like_pages', {
    expectedScope: 'Only pages classified as pageType=article are expected to carry Article schema.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    pageTypeScope: ['article'],
    detailHandlerExpected: true
  }),
  expectation('geo.article_blog_pages_article_schema', {
    expectedScope: 'GEO opportunity for Article schema only on pageType=article pages.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    pageTypeScope: ['article'],
    detailHandlerExpected: true
  }),
  expectation('tech.product_coverage_on_product_like_pages', {
    expectedScope: 'Only pages classified as pageType=product are expected to carry Product schema.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    pageTypeScope: ['product'],
    detailHandlerExpected: true
  }),
  expectation('tech.localbusiness_present_missing', {
    expectedScope: 'Domain/template hint for location pages; not a per-URL global requirement.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    pageTypeScope: ['location'],
    detailHandlerExpected: true
  }),
  expectation('tech.faqpage_missing_low_coverage', {
    expectedScope: 'Only strong stored FAQ structures are candidates for missing FAQPage schema.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: ['core_issue', 'opportunity', 'info'],
    pageTypeScope: ['hasFaqPattern'],
    detailHandlerExpected: true
  }),
  expectation('geo.faq_html_present_schema_missing', {
    expectedScope: 'GEO opportunity only when strong FAQ HTML structures exist without FAQPage schema.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    pageTypeScope: ['hasFaqPattern'],
    detailHandlerExpected: true
  }),
  expectation('tech.speakable_missing', {
    expectedScope: 'Optional Speakable structured data signal, never a hard technical error.',
    allowedStatuses: ['OK', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('geo.speakable_present', {
    expectedScope: 'Optional GEO Speakable presence signal.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('geo.llms_txt_present', {
    expectedScope: 'Optional llms.txt availability signal.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('geo.llms_txt_http_status', {
    expectedScope: 'Stored HTTP status for optional llms.txt availability.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('geo.llms_full_txt_present', {
    expectedScope: 'Optional llms-full.txt availability; hard only when referenced and demonstrably broken, still displayed as opportunity.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('geo.markdown_twin_homepage', {
    expectedScope: 'Optional Markdown twin candidate files checked at known local paths.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  ...[
    'geo.robots_mentions_gptbot',
    'geo.robots_mentions_oai_searchbot',
    'geo.robots_mentions_claudebot',
    'geo.robots_mentions_perplexitybot',
    'geo.robots_mentions_google_extended'
  ].map((checkId) => expectation(checkId, {
    expectedScope: 'Explicit AI crawler user-agent block presence in robots.txt.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  })),
  expectation('geo.ai_bots_policy_summary', {
    expectedScope: 'AI crawler allow/block/unclear summary inferred only from stored robots.txt.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('tech.webmanifest_missing', {
    expectedScope: 'Optional browser metadata/PWA manifest presence.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: OPPORTUNITY_TYPES,
    hardIssueAllowed: false,
    detailHandlerExpected: false
  }),
  expectation('template.playwright_unavailable', {
    expectedScope: 'Local Playwright/Chromium sampling availability.',
    allowedStatuses: ['OK', 'NA'],
    allowedFindingTypes: ['info'],
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('template.lighthouse_unavailable', {
    expectedScope: 'Local Lighthouse sampling availability.',
    allowedStatuses: ['OK', 'NA'],
    allowedFindingTypes: ['info'],
    hardIssueAllowed: false,
    detailHandlerExpected: true
  }),
  expectation('template.console_errors', {
    expectedScope: 'Template samples with captured Playwright console errors.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: TEMPLATE_TYPES,
    detailHandlerExpected: true
  }),
  expectation('template.js_required_content', {
    expectedScope: 'Template samples where rendered content materially exceeds raw crawl content.',
    allowedStatuses: ['OK', 'Warning', 'NA'],
    allowedFindingTypes: TEMPLATE_TYPES,
    detailHandlerExpected: true
  })
];

export const legitExpectationByCheckId = Object.freeze(Object.fromEntries(
  legitCheckExpectations.map((item) => [item.checkId, Object.freeze({ ...item })])
));

export function getLegitCheckExpectation(checkId) {
  return legitExpectationByCheckId[checkId] || null;
}
