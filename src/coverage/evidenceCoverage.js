export const AVAILABILITY_SEMANTICS_VERSION = 'evidence-availability-v1';

export const EVIDENCE_CLASSES = Object.freeze({
  primaryRequired: 'primary_required',
  primaryConditional: 'primary_conditional',
  secondaryDiagnostic: 'secondary_diagnostic',
  optionalOpportunity: 'optional_opportunity',
  inventory: 'inventory'
});

export const EVIDENCE_CLASS_WEIGHTS = Object.freeze({
  primary_required: 1,
  primary_conditional: 1,
  secondary_diagnostic: 0.15,
  optional_opportunity: 0.05,
  inventory: 0.2
});

const BROWSER_DIAGNOSTICS = new Set([
  'tech.raw_h1_missing_rendered_present',
  'tech.raw_internal_links_fewer_rendered',
  'tech.rendered_word_count_delta',
  'tech.console_errors_present',
  'template.console_errors'
]);

const LIGHTHOUSE_CHECKS = new Set([
  'template.low_lighthouse_performance',
  'template.low_lighthouse_seo',
  'template.high_lcp',
  'template.high_tbt',
  'template.lighthouse_unavailable'
]);

const PLAYWRIGHT_TEMPLATE_CHECKS = new Set([
  'template.console_errors',
  'template.js_required_content',
  'template.playwright_unavailable'
]);

const INVENTORY_PATTERNS = [
  /(?:^|\.)(?:noindex_pages|nofollow_pages|schema_types_coverage_summary|status_code_distribution|security_headers_inventory)$/,
  /(?:inventory|distribution|summary)$/,
  /third_party_scripts_detected$/
];

const OPTIONAL_PATTERNS = [
  /(?:open_graph|twitter_|social_|og_image|webmanifest|speakable)/,
  /(?:llms|markdown_twin|ai_bots|robots_mentions_|robots_blocks_txt)/,
  /(?:preconnect|preload|visible_publish_date|author_bio|external_sources|person_present_missing)/,
  /(?:about_linked|contact_linked|datenschutz_linked|impressum_linked)/,
  /(?:opportunity|best_practice)/,
  /(?:compression_header|cache_control_header|http_version_support|cdn_cache_signals)/,
  /(?:hsts_header|content_security_policy|x_frame_options|x_content_type_options|referrer_policy|permissions_policy)/,
  /(?:favicon_missing|app_icons_incomplete|images_without_width_height|images_without_lazy_loading)/,
  /(?:html_semantics_summary|consent_technical_signals|too_many_js|too_many_css|resource_hints_summary)/,
  /(?:organization_missing|website_missing|local_business|person_schema|organization_same_as)/
];

const CONDITIONAL_PATTERNS = [
  /(?:article_coverage|article_blog_pages_article_schema|product_coverage|breadcrumb_missing|breadcrumblist|faqpage|hreflang)/,
  /^template\./
];

const SHARED_UNITS = new Map([
  ['tech.article_coverage_on_article_like_pages', 'site:structured_data:article_coverage'],
  ['geo.article_blog_pages_article_schema', 'site:structured_data:article_coverage'],
  ['tech.raw_h1_missing_rendered_present', 'site:render_diagnostic:raw_rendered_content'],
  ['tech.raw_internal_links_fewer_rendered', 'site:render_diagnostic:raw_rendered_content'],
  ['tech.rendered_word_count_delta', 'site:render_diagnostic:raw_rendered_content'],
  ['tech.console_errors_present', 'site:browser_diagnostic:console'],
  ['template.console_errors', 'site:browser_diagnostic:console'],
  ['template.low_lighthouse_performance', 'module:lighthouse:performance'],
  ['template.high_lcp', 'module:lighthouse:performance'],
  ['template.high_tbt', 'module:lighthouse:performance'],
  ['template.low_lighthouse_seo', 'module:lighthouse:seo']
]);

/**
 * Build run-level facts once. No check is allowed to infer that skipped browser
 * work was successful merely because no Playwright row exists.
 */
export function createEvidenceAvailabilityContext(db, run = {}) {
  const runId = Number(run.id);
  const render = Number.isInteger(runId) && runId > 0 && tableExists(db, 'url_runtime_metrics')
    ? db.prepare(`
      SELECT
        COUNT(*) AS plannedCount,
        SUM(CASE WHEN renderNeed = 'render_required' THEN 1 ELSE 0 END) AS requiredCount,
        SUM(CASE WHEN resultingBrowserRun = 1 THEN 1 ELSE 0 END) AS renderedCount,
        SUM(CASE WHEN renderDecision = 'render_budget_exhausted' THEN 1 ELSE 0 END) AS budgetExhaustedCount,
        SUM(CASE WHEN renderDecision = 'render_unavailable' THEN 1 ELSE 0 END) AS unavailableCount,
        SUM(CASE WHEN renderNeed = 'render_recommended' AND resultingBrowserRun = 0 THEN 1 ELSE 0 END) AS optionalNotSelectedCount,
        SUM(CASE WHEN renderNeed = 'render_required' AND resultingBrowserRun = 0 THEN 1 ELSE 0 END) AS missingRequiredCount
      FROM url_runtime_metrics
      WHERE runId = ?
    `).get(runId) : {};
  return {
    runId,
    auditType: run.auditType || 'both',
    sourceType: run.sourceType || 'crawl',
    enablePlaywrightSampling: Boolean(run.enablePlaywrightSampling),
    enableLighthouseSampling: Boolean(run.enableLighthouseSampling),
    usePlaywright: Boolean(run.usePlaywright),
    playwrightMode: run.playwrightMode || 'off',
    render: {
      plannedCount: number(render.plannedCount),
      requiredCount: number(render.requiredCount),
      renderedCount: number(render.renderedCount),
      budgetExhaustedCount: number(render.budgetExhaustedCount),
      unavailableCount: number(render.unavailableCount),
      optionalNotSelectedCount: number(render.optionalNotSelectedCount),
      missingRequiredCount: number(render.missingRequiredCount)
    }
  };
}

export function applyEvidenceAvailability(result = {}, context = {}) {
  const checkId = result.checkId || result.id || 'unknown';
  const evaluationStatus = normalizeEvaluation(result);
  const definition = definitionFor(checkId, result, context);
  const availability = availabilityFor({ checkId, evaluationStatus, definition, context, result });
  return {
    ...result,
    evidenceClass: definition.evidenceClass,
    executionStatus: availability.executionStatus,
    evidenceStatus: availability.evidenceStatus,
    evaluationStatus,
    coverageStatus: availability.coverageStatus,
    coverageUnitKey: result.coverageUnitKey || definition.coverageUnitKey,
    coverageWeight: result.coverageWeight ?? EVIDENCE_CLASS_WEIGHTS[definition.evidenceClass],
    coverageReason: availability.reason,
    availabilitySemanticsVersion: AVAILABILITY_SEMANTICS_VERSION
  };
}

export function normalizeEvidenceAvailability(result = {}, context = {}) {
  if (result.evidenceClass && result.coverageStatus && result.coverageUnitKey) {
    return {
      evidenceClass: result.evidenceClass,
      executionStatus: result.executionStatus || executionFromEvaluation(normalizeEvaluation(result)),
      evidenceStatus: result.evidenceStatus || evidenceFromEvaluation(normalizeEvaluation(result)),
      evaluationStatus: result.evaluationStatus || normalizeEvaluation(result),
      coverageStatus: result.coverageStatus,
      coverageUnitKey: result.coverageUnitKey,
      coverageWeight: finiteWeight(result.coverageWeight, result.evidenceClass),
      coverageReason: result.coverageReason || null,
      availabilitySemanticsVersion: result.availabilitySemanticsVersion || AVAILABILITY_SEMANTICS_VERSION
    };
  }
  const annotated = applyEvidenceAvailability(result, context);
  return {
    evidenceClass: annotated.evidenceClass,
    executionStatus: annotated.executionStatus,
    evidenceStatus: annotated.evidenceStatus,
    evaluationStatus: annotated.evaluationStatus,
    coverageStatus: annotated.coverageStatus,
    coverageUnitKey: annotated.coverageUnitKey,
    coverageWeight: annotated.coverageWeight,
    coverageReason: annotated.coverageReason,
    availabilitySemanticsVersion: annotated.availabilitySemanticsVersion
  };
}

function definitionFor(checkId, result, context) {
  if (Object.values(EVIDENCE_CLASSES).includes(result.evidenceClass)) {
    return definition(result.evidenceClass, checkId, result.coverageUnitKey || null);
  }
  if (checkId === 'tech.js_dependent_content') {
    const required = context.render?.requiredCount > 0;
    return definition(required ? EVIDENCE_CLASSES.primaryConditional : EVIDENCE_CLASSES.secondaryDiagnostic, checkId);
  }
  if (checkId === 'tech.critical_content_raw_html_signal') {
    return definition(EVIDENCE_CLASSES.primaryRequired, checkId, 'site:html:raw_content_integrity');
  }
  if (BROWSER_DIAGNOSTICS.has(checkId)) return definition(EVIDENCE_CLASSES.secondaryDiagnostic, checkId);
  if (LIGHTHOUSE_CHECKS.has(checkId)) return definition(EVIDENCE_CLASSES.primaryConditional, checkId);
  if (PLAYWRIGHT_TEMPLATE_CHECKS.has(checkId)) return definition(EVIDENCE_CLASSES.secondaryDiagnostic, checkId);
  if (INVENTORY_PATTERNS.some((pattern) => pattern.test(checkId))) return definition(EVIDENCE_CLASSES.inventory, checkId);
  if (CONDITIONAL_PATTERNS.some((pattern) => pattern.test(checkId))) return definition(EVIDENCE_CLASSES.primaryConditional, checkId);
  if (OPTIONAL_PATTERNS.some((pattern) => pattern.test(checkId))) {
    return definition(EVIDENCE_CLASSES.optionalOpportunity, checkId);
  }
  if (/^(geo|trust|llm)\./.test(checkId)) return definition(EVIDENCE_CLASSES.optionalOpportunity, checkId);
  return definition(EVIDENCE_CLASSES.primaryRequired, checkId);
}

function definition(evidenceClass, checkId, explicitUnit = null) {
  return {
    evidenceClass,
    coverageUnitKey: explicitUnit || SHARED_UNITS.get(checkId) || `check:${checkId}`
  };
}

function availabilityFor({ checkId, evaluationStatus, definition, context, result }) {
  const evidenceClass = definition.evidenceClass;
  const isDiagnostic = evidenceClass === EVIDENCE_CLASSES.secondaryDiagnostic;
  const isOptional = evidenceClass === EVIDENCE_CLASSES.optionalOpportunity;
  const isInventory = evidenceClass === EVIDENCE_CLASSES.inventory;

  if (checkId === 'tech.imported_resource_performance_signals' && context.sourceType !== 'screaming_frog_import') {
    return excluded('disabled', 'not_required', 'This import-only diagnostic is not part of a live crawl plan.');
  }

  if (LIGHTHOUSE_CHECKS.has(checkId) && !context.enableLighthouseSampling) {
    return excluded('disabled', 'not_required', 'The Lighthouse module was not part of the audit plan.');
  }
  if (PLAYWRIGHT_TEMPLATE_CHECKS.has(checkId) && !context.enablePlaywrightSampling) {
    return excluded('disabled', 'not_required', 'Template browser sampling was not part of the audit plan.');
  }
  if ((BROWSER_DIAGNOSTICS.has(checkId) || checkId === 'tech.js_dependent_content')
      && context.render?.requiredCount === 0
      && !['pass', 'fail'].includes(evaluationStatus)) {
    return excluded(
      context.render?.optionalNotSelectedCount > 0 ? 'render_optional_not_selected' : 'skipped_by_render_plan',
      'not_required',
      'Raw evidence was sufficient and the render plan did not require this browser diagnostic.'
    );
  }
  if (evaluationStatus === 'not_applicable') {
    return excluded('completed', 'not_required', 'The applicability condition was not met.');
  }
  const missingRequiredFacts = requirementFactsMissing(result);
  if (['pass', 'fail', 'inventory'].includes(evaluationStatus) && missingRequiredFacts.length) {
    if (isDiagnostic || isOptional) {
      return {
        executionStatus: 'completed',
        evidenceStatus: 'optional_unavailable',
        coverageStatus: 'diagnostic_unavailable',
        reason: `The diagnostic completed without required facts: ${missingRequiredFacts.join(', ')}.`
      };
    }
    return {
      executionStatus: 'completed',
      evidenceStatus: 'required_but_missing',
      coverageStatus: 'uncovered',
      reason: `The evaluation completed without required facts: ${missingRequiredFacts.join(', ')}.`
    };
  }
  if (['pass', 'fail', 'inventory'].includes(evaluationStatus)) {
    return {
      executionStatus: 'completed',
      evidenceStatus: 'complete',
      coverageStatus: 'covered',
      reason: isInventory ? 'Inventory collection completed.' : 'The planned evidence was evaluated.'
    };
  }

  const renderSensitive = browserEvidenceCanBeRequired(checkId);
  const renderBudgetFailure = renderSensitive && context.render?.budgetExhaustedCount > 0;
  const browserUnavailable = renderSensitive && context.render?.unavailableCount > 0;
  const executionStatus = renderBudgetFailure
    ? 'skipped_by_budget'
    : evaluationStatus === 'technical_error' || browserUnavailable ? 'technical_error' : 'not_executed';
  const evidenceStatus = evaluationStatus === 'technical_error' || browserUnavailable
    ? 'technical_error'
    : 'required_but_missing';
  if (isDiagnostic || isOptional) {
    return {
      executionStatus,
      evidenceStatus: evidenceStatus === 'required_but_missing' ? 'optional_unavailable' : evidenceStatus,
      coverageStatus: 'diagnostic_unavailable',
      reason: renderBudgetFailure
        ? 'Optional diagnostic evidence was omitted by the run budget.'
        : 'Optional diagnostic evidence was unavailable; primary coverage is unaffected.'
    };
  }
  return {
    executionStatus,
    evidenceStatus,
    coverageStatus: 'uncovered',
    reason: isInventory
      ? 'The planned inventory could not be collected.'
      : 'Evidence required for the planned primary evaluation is missing.'
  };
}

function requirementFactsMissing(result = {}) {
  const requirements = result.requirements || parseObject(result.requirementsJson);
  return Array.isArray(requirements?.missingFacts)
    ? [...new Set(requirements.missingFacts.map((value) => String(value).trim()).filter(Boolean))]
    : [];
}

function parseObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function browserEvidenceCanBeRequired(checkId) {
  return BROWSER_DIAGNOSTICS.has(checkId)
    || LIGHTHOUSE_CHECKS.has(checkId)
    || PLAYWRIGHT_TEMPLATE_CHECKS.has(checkId)
    || checkId === 'tech.js_dependent_content'
    || /(?:title|meta_description|canonical|h1|html_lang|hreflang|open_graph)/.test(checkId);
}

function excluded(executionStatus, evidenceStatus, reason) {
  return { executionStatus, evidenceStatus, coverageStatus: 'excluded', reason };
}

function normalizeEvaluation(result) {
  return result.evaluationStatus || result.evaluationState || (result.status === 'OK'
    ? 'pass'
    : ['Warning', 'Error'].includes(result.status) ? 'fail' : 'insufficient_evidence');
}

function executionFromEvaluation(state) {
  if (['pass', 'fail', 'inventory', 'not_applicable'].includes(state)) return 'completed';
  return state === 'technical_error' ? 'technical_error' : 'not_executed';
}

function evidenceFromEvaluation(state) {
  if (['pass', 'fail', 'inventory'].includes(state)) return 'complete';
  if (state === 'not_applicable') return 'not_required';
  if (state === 'technical_error') return 'technical_error';
  return 'required_but_missing';
}

function finiteWeight(value, evidenceClass) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : EVIDENCE_CLASS_WEIGHTS[evidenceClass] ?? 0;
}

function tableExists(db, name) {
  if (!db?.prepare) return false;
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
