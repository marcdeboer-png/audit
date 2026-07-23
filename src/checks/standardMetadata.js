export const AUDIT_STANDARD_VERSION = 'audit-standard-v1';

const STANDARD_METADATA = Object.freeze({
  'geo.article_blog_pages_article_schema': metadata({
    severity: 'Medium',
    scoreEffect: 'score_free',
    usage: 'fully_automated',
    applicability: 'High-confidence individual editorial content pages; excludes homepages, archives, categories, PLPs, PDPs, service, contact and FAQ pages.',
    notApplicableRule: 'Excluded page types and pages without a high-confidence individual-article classification are not applicable.',
    reviewStatus: 'not_required',
    scoreDeduplicationKey: 'structured_data.article_coverage',
    rollupRole: 'score_free_perspective',
    scoreOwnerCheckId: 'tech.article_coverage_on_article_like_pages'
  }),
  'geo.llms_full_txt_present': metadata({
    severity: null,
    scoreEffect: 'score_free',
    usage: 'disabled',
    applicability: 'Disabled for new audits; historical observations remain readable.',
    notApplicableRule: 'The check is outside the current audit standard.',
    reviewStatus: 'disabled'
  }),
  'geo.speakable_present': metadata({
    severity: null,
    scoreEffect: 'score_free',
    usage: 'disabled',
    applicability: 'Disabled for new audits; historical observations remain readable.',
    notApplicableRule: 'Speakable is outside the current audit standard.',
    reviewStatus: 'disabled'
  }),
  'tech.article_coverage_on_article_like_pages': metadata({
    severity: 'Medium',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'High-confidence individual editorial content pages; excludes homepages, archives, categories, PLPs, PDPs, service, contact and FAQ pages.',
    notApplicableRule: 'Excluded page types and pages without a high-confidence individual-article classification are not applicable.',
    reviewStatus: 'not_required',
    scoreDeduplicationKey: 'structured_data.article_coverage',
    rollupRole: 'primary_score_owner',
    relatedCheckIds: ['geo.article_blog_pages_article_schema']
  }),
  'tech.canonical_non_self': metadata({
    severity: 'Info',
    scoreEffect: 'conditional',
    usage: 'automated_with_limits',
    applicability: 'Successful indexable HTML pages with a complete effective canonical state.',
    notApplicableRule: 'Non-indexable, non-HTML, unsuccessful or incomplete canonical observations are not a normal pass or fail.',
    reviewStatus: 'required_before_scoring',
    rollupRole: 'url_finding'
  }),
  'tech.duplicate_meta_descriptions': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Successful indexable, non-consolidated HTML pages with a complete effective meta description.',
    notApplicableRule: 'Canonicalized, non-indexable and technically identical alternative URLs are outside the normal duplicate scope.',
    reviewStatus: 'not_required',
    rollupRole: 'url_group_score_owner'
  }),
  'tech.duplicate_titles': metadata({
    severity: 'Medium',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Successful indexable, non-consolidated HTML pages with a complete effective title.',
    notApplicableRule: 'Canonicalized, non-indexable and technically identical alternative URLs are outside the normal duplicate scope.',
    reviewStatus: 'not_required',
    rollupRole: 'url_group_score_owner'
  }),
  'tech.h1_missing': metadata({
    severity: 'Medium',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'All successful indexable HTML pages with a complete effective document state.',
    notApplicableRule: 'Non-indexable resources and incomplete or technically failed document observations are not applicable.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner'
  }),
  'tech.high_ttfb': metadata({
    severity: 'Medium',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Representative URLs with sufficient comparable, stable TTFB measurements.',
    notApplicableRule: 'Technical timing failures and incomplete or unstable measurement sets are not a pass or fail.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner'
  }),
  'tech.hreflang_x_default_missing': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Pages or clusters with an observed hreflang configuration.',
    notApplicableRule: 'Pages without an hreflang setup are not applicable.',
    reviewStatus: 'not_required',
    rollupRole: 'cluster_score_owner'
  }),
  'tech.html_semantics_summary': metadata({
    severity: 'Info',
    scoreEffect: 'score_free',
    usage: 'diagnostic_only',
    applicability: 'Successful relevant HTML pages with available semantic inventory facts.',
    notApplicableRule: 'Unavailable or incomplete semantic evidence cannot produce a quality pass.',
    reviewStatus: 'diagnostic_only',
    rollupRole: 'score_free_summary'
  }),
  'tech.imported_resource_performance_signals': metadata({
    severity: 'Info',
    scoreEffect: 'score_free',
    usage: 'diagnostic_only',
    applicability: 'Pages with an available imported or measured resource inventory.',
    notApplicableRule: 'Missing or incomplete resource inventory cannot produce a performance pass.',
    reviewStatus: 'diagnostic_only',
    rollupRole: 'score_free_summary'
  }),
  'tech.internal_links_to_3xx': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Normalized internal HTTP(S) link occurrences with a measured initial target response.',
    notApplicableRule: 'External, non-HTTP and technically unmeasured targets are outside the normal finding scope.',
    reviewStatus: 'not_required',
    rollupRole: 'normalized_target_score_owner'
  }),
  'tech.json_ld_parse_errors': metadata({
    severity: 'Medium',
    severityMode: 'dynamic_medium_high',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Successful HTML pages with fully extracted application/ld+json blocks.',
    notApplicableRule: 'Pages without JSON-LD blocks are not applicable; extraction, browser and transfer failures are technical availability states.',
    reviewStatus: 'not_required',
    rollupRole: 'normalized_parse_root_score_owner'
  }),
  'tech.meta_description_missing': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Successful indexable HTML pages with a complete effective document state.',
    notApplicableRule: 'Noindex pages and confirmed technical alternative resources are outside the required scope.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner'
  }),
  'tech.meta_description_too_long': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Indexable HTML pages with a non-empty effective meta description.',
    notApplicableRule: 'Missing descriptions and incomplete effective document states are handled separately.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner',
    patternRole: 'template_rollup_score_free'
  }),
  'tech.meta_description_too_short': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Indexable HTML pages with a non-empty effective meta description.',
    notApplicableRule: 'Missing descriptions and incomplete effective document states are handled separately.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner',
    patternRole: 'template_rollup_score_free'
  }),
  'tech.multiple_h1': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Successful indexable HTML pages with a complete effective heading state.',
    notApplicableRule: 'Incomplete document states and non-indexable resources are not applicable.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner',
    patternRole: 'template_rollup_score_free'
  }),
  'tech.product_coverage_on_product_like_pages': metadata({
    severity: 'Medium',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'High-confidence product detail pages; excludes categories, search pages, brand hubs and editorial guides.',
    notApplicableRule: 'Uncertain page types and non-product-detail pages are not applicable.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner'
  }),
  'tech.raw_h1_missing_rendered_present': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Relevant successfully rendered HTML pages with complete raw and settled H1 evidence.',
    notApplicableRule: 'Failed or unstable rendering is an availability state; a fully missing effective H1 is handled separately.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner'
  }),
  'tech.redirect_pages': metadata({
    severity: 'Info',
    scoreEffect: 'score_free',
    usage: 'diagnostic_only',
    applicability: 'All run URLs with an initial redirect or a different final URL.',
    notApplicableRule: 'Missing redirect-chain evidence cannot produce a complete inventory pass.',
    reviewStatus: 'diagnostic_only',
    rollupRole: 'score_free_inventory'
  }),
  'tech.speakable_missing': metadata({
    severity: null,
    scoreEffect: 'score_free',
    usage: 'disabled',
    applicability: 'Disabled for new audits; historical observations remain readable.',
    notApplicableRule: 'Speakable is outside the current audit standard.',
    reviewStatus: 'disabled'
  }),
  'tech.status_code_distribution': metadata({
    severity: 'Info',
    scoreEffect: 'score_free',
    usage: 'diagnostic_only',
    applicability: 'All run URLs and stored HTTP attempts.',
    notApplicableRule: 'Missing status evidence cannot produce a complete inventory pass.',
    reviewStatus: 'diagnostic_only',
    rollupRole: 'score_free_inventory'
  }),
  'tech.title_too_long': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Relevant indexable HTML pages with a non-empty effective title.',
    notApplicableRule: 'Missing titles and incomplete effective document states are handled separately.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner',
    patternRole: 'template_rollup_score_free'
  }),
  'tech.title_too_short': metadata({
    severity: 'Low',
    scoreEffect: 'score_capable',
    usage: 'fully_automated',
    applicability: 'Relevant indexable HTML pages with a non-empty effective title.',
    notApplicableRule: 'Missing titles and incomplete effective document states are handled separately.',
    reviewStatus: 'not_required',
    rollupRole: 'url_score_owner',
    patternRole: 'template_rollup_score_free'
  })
});

const STANDARD_FINDING_TYPES = Object.freeze({
  'geo.article_blog_pages_article_schema': 'opportunity',
  'geo.llms_full_txt_present': 'info',
  'geo.speakable_present': 'info',
  'tech.article_coverage_on_article_like_pages': 'core_issue',
  'tech.canonical_non_self': 'best_practice',
  'tech.duplicate_meta_descriptions': 'core_issue',
  'tech.duplicate_titles': 'core_issue',
  'tech.h1_missing': 'core_issue',
  'tech.high_ttfb': 'core_issue',
  'tech.hreflang_x_default_missing': 'core_issue',
  'tech.html_semantics_summary': 'info',
  'tech.imported_resource_performance_signals': 'info',
  'tech.internal_links_to_3xx': 'core_issue',
  'tech.json_ld_parse_errors': 'core_issue',
  'tech.meta_description_missing': 'core_issue',
  'tech.meta_description_too_long': 'core_issue',
  'tech.meta_description_too_short': 'core_issue',
  'tech.multiple_h1': 'core_issue',
  'tech.product_coverage_on_product_like_pages': 'core_issue',
  'tech.raw_h1_missing_rendered_present': 'core_issue',
  'tech.redirect_pages': 'info',
  'tech.speakable_missing': 'info',
  'tech.status_code_distribution': 'info',
  'tech.title_too_long': 'core_issue',
  'tech.title_too_short': 'core_issue'
});

export const STANDARD_ALIGNED_CHECK_IDS = Object.freeze(Object.keys(STANDARD_METADATA));
export const DISABLED_CHECK_IDS = Object.freeze(
  STANDARD_ALIGNED_CHECK_IDS.filter((checkId) => STANDARD_METADATA[checkId].disabled)
);

export function standardMetadataFor(checkId) {
  const standard = STANDARD_METADATA[checkId];
  return standard ? { ...standard, findingType: STANDARD_FINDING_TYPES[checkId] } : null;
}

export function applyStandardCheckMetadata(check) {
  const standard = standardMetadataFor(check?.id);
  if (!standard) return check;
  return {
    ...check,
    priority: standard.severity || check.priority,
    scoreDeduplicationKey: standard.scoreDeduplicationKey || check.scoreDeduplicationKey,
    relatedCheckIds: standard.relatedCheckIds || check.relatedCheckIds,
    findingType: standard.findingType,
    standardMetadata: standard,
    standardVersion: AUDIT_STANDARD_VERSION,
    standardStatus: standard.status,
    standardUsage: standard.usage,
    standardSeverity: standard.severity,
    standardScoreEffect: standard.scoreEffect,
    standardFindingType: standard.findingType,
    standardApplicability: standard.applicability,
    standardNotApplicableRule: standard.notApplicableRule,
    standardReviewStatus: standard.reviewStatus,
    standardRollupRole: standard.rollupRole,
    standardPatternRole: standard.patternRole,
    standardScoreOwnerCheckId: standard.scoreOwnerCheckId,
    diagnosticOnly: standard.diagnosticOnly,
    disabled: standard.disabled
  };
}

export function activeStandardChecks(checks) {
  return checks.map(applyStandardCheckMetadata).filter((check) => !check.disabled);
}

export function applyStandardResultMetadata(row = {}) {
  const checkId = row.checkId || row.id;
  const standard = standardMetadataFor(checkId);
  if (!standard) return row;
  const priority = standardPriorityForResult(standard, row);
  const scoreEligible = standardScoreEligibility(standard, row);
  const reviewRecommended = standardReviewRecommended(standard, row);
  const findingType = standard.findingType;
  const effectivePriority = row.manualPriority || priority;
  const assessment = row.assessment && typeof row.assessment === 'object'
    ? { ...row.assessment, severity: priority.toLowerCase() }
    : row.assessment;
  return {
    ...row,
    originalPriority: row.originalPriority || row.priority,
    originalFindingType: row.originalFindingType || row.findingType,
    priority,
    effectivePriority,
    findingType,
    assessment,
    scoreEligible,
    scoreExclusionReason: scoreEligible
      ? null
      : (standard.scoreEffect === 'score_free' || standard.disabled
          ? `audit_standard_${standard.usage}`
          : row.scoreExclusionReason),
    scoreDeduplicationKey: standard.scoreDeduplicationKey || row.scoreDeduplicationKey,
    reviewRecommended,
    automationCoverage: standard.usage === 'fully_automated'
      ? 'full'
      : standard.usage === 'automated_with_limits'
        ? 'partial'
        : row.automationCoverage,
    standardVersion: AUDIT_STANDARD_VERSION,
    standardStatus: standard.status,
    standardUsage: standard.usage,
    standardSeverity: standard.severity,
    standardScoreEffect: standard.scoreEffect,
    standardFindingType: standard.findingType,
    standardApplicability: standard.applicability,
    standardNotApplicableRule: standard.notApplicableRule,
    standardReviewStatus: standard.reviewStatus,
    standardRollupRole: standard.rollupRole,
    standardPatternRole: standard.patternRole,
    standardScoreOwnerCheckId: standard.scoreOwnerCheckId,
    diagnosticOnly: standard.diagnosticOnly,
    disabled: standard.disabled
  };
}

function metadata(input) {
  const usage = input.usage;
  return Object.freeze({
    standardVersion: AUDIT_STANDARD_VERSION,
    status: usage === 'disabled' ? 'disabled' : 'active',
    severityMode: 'fixed',
    rollupRole: 'none',
    patternRole: 'none',
    scoreDeduplicationKey: null,
    scoreOwnerCheckId: null,
    relatedCheckIds: [],
    ...input,
    diagnosticOnly: usage === 'diagnostic_only',
    disabled: usage === 'disabled'
  });
}

function standardPriorityForResult(standard, row) {
  if (!standard.severity) return row.priority || row.originalPriority || 'Info';
  if (standard.severityMode === 'dynamic_medium_high' && ['Medium', 'High'].includes(row.priority)) {
    return row.priority;
  }
  if (standard.scoreEffect === 'conditional' && row.manualPriority) return row.manualPriority;
  return standard.severity;
}

function standardScoreEligibility(standard, row) {
  if (standard.disabled || standard.scoreEffect === 'score_free') return false;
  if (standard.scoreEffect === 'conditional') return Boolean(row.scoreEligible);
  const evaluationState = row.evaluationState || row.evaluationStatus;
  if (evaluationState) return ['pass', 'fail'].includes(evaluationState);
  return ['OK', 'Warning', 'Error'].includes(row.status || row.effectiveStatus);
}

function standardReviewRecommended(standard, row) {
  if (standard.disabled || standard.diagnosticOnly || standard.usage === 'fully_automated') return false;
  if (standard.reviewStatus === 'required_before_scoring') {
    return ['Warning', 'Error'].includes(row.status || row.effectiveStatus) || Boolean(row.reviewRecommended);
  }
  return Boolean(row.reviewRecommended);
}
