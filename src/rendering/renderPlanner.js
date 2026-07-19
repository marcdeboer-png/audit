import crypto from 'node:crypto';

export const RENDER_PLANNING_VERSIONS = Object.freeze({
  v1: 'deterministic-render-gate-v1',
  v2: 'deterministic-render-gate-v2'
});
export const RENDER_PLANNING_VERSION = RENDER_PLANNING_VERSIONS.v2;
export const RUNTIME_METRICS_VERSION = 'render-runtime-metrics-v1';

export const RENDER_NEEDS = Object.freeze({
  required: 'render_required',
  recommended: 'render_recommended',
  notRequired: 'render_not_required'
});

const CONTENT_PAGE_TYPES = new Set(['homepage', 'article', 'product', 'category', 'service', 'location', 'blog_index']);
const UTILITY_PAGE_TYPES = new Set(['legal', 'search', 'filter', 'utility']);

export const RENDER_GATE_V2_MODEL = Object.freeze({
  recommendationThreshold: 4,
  rawEvidence: Object.freeze({
    nearEmptyVisibleWordsMaximum: 14,
    appShellComparableWordsMaximum: 49,
    appShellVisibleWordsMaximum: 99,
    criticalMainWordsMinimum: 30,
    substantialWordsMinimum: 100,
    usefulInternalLinksMinimum: 2,
    executableScriptCountMinimum: 1
  }),
  weights: Object.freeze({
    near_empty_document: 6,
    thin_primary_document: 4,
    missing_title: 3,
    missing_canonical: 2,
    missing_html_language: 1,
    missing_primary_heading: 1,
    low_internal_links: 1,
    executable_structure_corroboration: 1,
    substantial_main_content: -4,
    substantial_visible_content: -4,
    primary_heading_present: -2,
    critical_metadata_complete: -2,
    useful_internal_links_present: -1,
    relevant_structured_data_present: -1,
    complete_utility_document: -8,
    non_indexable_document: -8
  })
});

export const RENDER_CHECK_REQUIREMENTS = Object.freeze([
  Object.freeze({ checkId: 'tech.js_dependent_content', defaultRequirement: 'render_optional', requiredWhen: 'raw_primary_content_incomplete' }),
  Object.freeze({ checkId: 'tech.rendered_word_count_delta', defaultRequirement: 'render_optional' }),
  Object.freeze({ checkId: 'tech.raw_h1_missing_rendered_present', defaultRequirement: 'render_optional', requiredWhen: 'raw_primary_heading_and_content_incomplete' }),
  Object.freeze({ checkId: 'tech.raw_internal_links_fewer_rendered', defaultRequirement: 'render_optional', requiredWhen: 'raw_navigation_and_content_incomplete' }),
  Object.freeze({ checkId: 'tech.console_errors_present', defaultRequirement: 'render_optional' }),
  Object.freeze({ checkId: 'template.console_errors', defaultRequirement: 'render_optional' }),
  Object.freeze({ checkId: 'template.js_required_content', defaultRequirement: 'render_optional', requiredWhen: 'raw_primary_content_incomplete' })
]);

export const RENDER_CHECK_MINIMUM_MEASUREMENTS = Object.freeze({
  'tech.js_dependent_content': 2
});

export function normalizeMetricsMode(value) {
  return ['off', 'basic', 'profiling'].includes(value) ? value : 'basic';
}

export function normalizeOptionalBudget(value, { minimum = 0 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(minimum, Math.floor(number));
}

export function normalizeRenderPlanningVersion(value) {
  return Object.values(RENDER_PLANNING_VERSIONS).includes(value) ? value : RENDER_PLANNING_VERSION;
}

export function classifierForRenderPlanningVersion(value) {
  return normalizeRenderPlanningVersion(value) === RENDER_PLANNING_VERSIONS.v1 ? classifyRenderNeedV1 : classifyRenderNeed;
}

export function classifyRenderNeedV1(page = {}, options = {}) {
  const facts = collectRenderFacts(page, options);
  const { raw, visibleWords, mainWords, mainPresent, comparableWords, h1Count, internalLinks, pageType, indexable,
    scriptCount, hydrationBytes, metadata, missingMetadata, contentRelevant } = facts;
  const unknownDynamicCandidate = indexable && pageType === 'other' && comparableWords < 50 && h1Count === 0 && (scriptCount > 0 || hydrationBytes > 0);
  const completeUtility = UTILITY_PAGE_TYPES.has(pageType) && Boolean(metadata.title) && h1Count > 0 && comparableWords >= 15;
  const rawAppShell = (contentRelevant || unknownDynamicCandidate) && comparableWords < 50 && visibleWords < 100 && (h1Count === 0 || internalLinks < 3);
  const criticalMainAbsent = contentRelevant && mainPresent && mainWords < 30;
  const strongContentGap = contentRelevant && comparableWords < 50 && h1Count === 0;
  const fullRawContent = comparableWords >= 100 && h1Count > 0 && Boolean(metadata.title);
  const metadataGap = indexable && missingMetadata.length > 0;
  const linkGap = contentRelevant && internalLinks < 2;
  const signals = [];
  if (rawAppShell) signals.push('raw_app_shell');
  if (criticalMainAbsent) signals.push('critical_main_content_absent_raw');
  if (strongContentGap) signals.push('raw_content_and_h1_missing');
  if (metadataGap) signals.push(`raw_metadata_missing:${missingMetadata.join(',')}`);
  if (linkGap) signals.push('raw_internal_links_low');
  if (scriptCount >= 8 || hydrationBytes >= 50000) signals.push('substantial_script_or_hydration_structure');
  if (fullRawContent) signals.push('substantial_raw_content_present');
  if (completeUtility) signals.push('complete_thin_utility_page');

  let decision;
  let confidence;
  let reason;
  let strength;
  if (rawAppShell || criticalMainAbsent || strongContentGap) {
    decision = RENDER_NEEDS.required;
    confidence = 'high';
    strength = 300 + Math.max(0, 100 - comparableWords) + missingMetadata.length * 8 + (linkGap ? 5 : 0);
    reason = 'Raw HTML lacks enough primary content to support a fail-closed rendered-content assessment.';
  } else if (completeUtility) {
    decision = RENDER_NEEDS.notRequired;
    confidence = 'high';
    strength = 0;
    reason = 'The utility page is intentionally concise but has a complete visible raw document state.';
  } else if (fullRawContent && missingMetadata.length === 0) {
    decision = RENDER_NEEDS.notRequired;
    confidence = 'high';
    strength = 0;
    reason = 'Substantial main content, heading and core metadata are already present in raw HTML.';
  } else if (metadataGap || h1Count === 0 || linkGap) {
    decision = RENDER_NEEDS.recommended;
    confidence = 'medium';
    strength = 200 + missingMetadata.length * 8 + (h1Count === 0 ? 10 : 0) + (linkGap ? 5 : 0);
    reason = 'Raw evidence is incomplete for at least one rendered-sensitive field; browser evidence is recommended when budget permits.';
  } else {
    decision = RENDER_NEEDS.recommended;
    confidence = 'medium';
    strength = 190;
    reason = 'Raw evidence is usable but does not justify a high-confidence render_not_required decision.';
  }

  return {
    version: RENDER_PLANNING_VERSIONS.v1,
    decision,
    confidence,
    reason,
    signals,
    negativeSignals: [],
    signalContributions: [],
    recommendationScore: null,
    recommendationThreshold: null,
    checkRequirements: [],
    unmetPrerequisites: decision === RENDER_NEEDS.notRequired ? [] : ['stable_rendered_document_state'],
    requestedCheckFamilies: options.requestedCheckFamilies || ['rendered_metadata', 'rendered_content', 'rendered_links', 'browser_events'],
    strength,
    rawClass: rawContentClass(comparableWords),
    facts: { ...facts, raw: undefined, metadata }
  };
}

export function classifyRenderNeed(page = {}, options = {}) {
  const facts = collectRenderFacts(page, options);
  const { visibleWords, mainWords, mainPresent, comparableWords, h1Count, internalLinks, pageType, indexable,
    scriptCount, hydrationBytes, metadata, contentRelevant, structuredDataTypes } = facts;
  const thresholds = RENDER_GATE_V2_MODEL.rawEvidence;
  const unknownDynamicCandidate = indexable && pageType === 'other' && comparableWords <= thresholds.appShellComparableWordsMaximum && h1Count === 0 && (scriptCount > 0 || hydrationBytes > 0);
  const completeUtility = UTILITY_PAGE_TYPES.has(pageType) && Boolean(metadata.title) && h1Count > 0 && comparableWords >= 15;
  const rawAppShell = (contentRelevant || unknownDynamicCandidate) && comparableWords <= thresholds.appShellComparableWordsMaximum && visibleWords <= thresholds.appShellVisibleWordsMaximum && (h1Count === 0 || internalLinks < 3);
  const criticalMainAbsent = contentRelevant && mainPresent && mainWords < thresholds.criticalMainWordsMinimum;
  const strongContentGap = contentRelevant && comparableWords <= thresholds.appShellComparableWordsMaximum && h1Count === 0;
  const hardSignals = [];
  if (rawAppShell) hardSignals.push('raw_app_shell');
  if (criticalMainAbsent) hardSignals.push('critical_main_content_absent_raw');
  if (strongContentGap) hardSignals.push('raw_content_and_h1_missing');

  const contributions = [];
  const add = (signal, rawValue, applies = true) => {
    if (!applies) return;
    const weight = RENDER_GATE_V2_MODEL.weights[signal];
    contributions.push({ signal, weight, direction: weight > 0 ? 'toward_render' : 'against_render', rawValue, appliedContribution: weight });
  };
  const nearEmpty = visibleWords <= thresholds.nearEmptyVisibleWordsMaximum && comparableWords <= thresholds.nearEmptyVisibleWordsMaximum && h1Count === 0;
  const executableStructure = scriptCount >= thresholds.executableScriptCountMinimum || hydrationBytes > 0;
  const thinPrimaryDocument = contentRelevant
    && comparableWords <= thresholds.appShellComparableWordsMaximum
    && visibleWords <= thresholds.appShellVisibleWordsMaximum
    && h1Count > 0
    && internalLinks >= thresholds.usefulInternalLinksMinimum;
  add('near_empty_document', { visibleWords, comparableWords, h1Count }, nearEmpty);
  add('thin_primary_document', { visibleWords, comparableWords, h1Count, internalLinks }, thinPrimaryDocument);
  add('missing_title', metadata.title, indexable && !metadata.title);
  add('missing_canonical', metadata.canonical, indexable && !metadata.canonical);
  add('missing_html_language', metadata.htmlLang, indexable && !metadata.htmlLang);
  add('missing_primary_heading', h1Count, indexable && h1Count === 0);
  add('low_internal_links', internalLinks, contentRelevant && internalLinks < thresholds.usefulInternalLinksMinimum);
  add('executable_structure_corroboration', { scriptCount, hydrationBytes }, executableStructure && contributions.some((item) => item.appliedContribution > 0));
  add('substantial_main_content', mainWords, mainPresent && mainWords >= thresholds.substantialWordsMinimum);
  add('substantial_visible_content', visibleWords, visibleWords >= thresholds.substantialWordsMinimum);
  add('primary_heading_present', h1Count, h1Count > 0);
  add('critical_metadata_complete', metadata, Boolean(metadata.title && metadata.canonical && metadata.htmlLang));
  add('useful_internal_links_present', internalLinks, internalLinks >= thresholds.usefulInternalLinksMinimum);
  add('relevant_structured_data_present', structuredDataTypes, structuredDataTypes.length > 0);
  add('complete_utility_document', pageType, completeUtility);
  add('non_indexable_document', indexable, !indexable);

  const score = contributions.reduce((total, item) => total + item.appliedContribution, 0);
  const checkRequirements = resolveRenderCheckRequirements({ ...facts, hardSignals, nearEmpty, thinPrimaryDocument, executableStructure }, options.activeCheckIds);
  const requiredByCheck = checkRequirements.some((item) => item.requirement === 'render_required');
  const hardRequired = hardSignals.length > 0 || requiredByCheck;
  let decision;
  let confidence;
  let reason;
  let strength;
  if (hardRequired) {
    decision = RENDER_NEEDS.required;
    confidence = 'high';
    strength = 300 + Math.max(0, 100 - comparableWords) + hardSignals.length * 10;
    reason = 'Raw HTML lacks primary evidence required by an applicable rendered-content check.';
  } else if (score >= RENDER_GATE_V2_MODEL.recommendationThreshold) {
    decision = RENDER_NEEDS.recommended;
    confidence = 'medium';
    strength = 200 + score;
    reason = 'Multiple independent raw-evidence gaps exceed the deterministic render recommendation threshold.';
  } else {
    decision = RENDER_NEEDS.notRequired;
    confidence = score <= 0 ? 'high' : 'medium';
    strength = 100 - score;
    reason = score <= 0
      ? 'Raw content, document structure and critical metadata provide sufficient evidence for the active checks.'
      : 'Remaining raw uncertainty is below the render threshold and is limited to optional or corroborated fields.';
  }
  const positiveSignals = contributions.filter((item) => item.appliedContribution > 0).map((item) => item.signal);
  const negativeSignals = contributions.filter((item) => item.appliedContribution < 0).map((item) => item.signal);
  const requestedCheckFamilies = [...new Set(checkRequirements.filter((item) => item.requirement !== 'raw_sufficient').map((item) => item.family))];

  return {
    version: RENDER_PLANNING_VERSION,
    decision,
    confidence,
    reason,
    signals: [...hardSignals, ...positiveSignals.filter((signal) => !hardSignals.includes(signal))],
    negativeSignals,
    signalContributions: contributions,
    recommendationScore: score,
    recommendationThreshold: RENDER_GATE_V2_MODEL.recommendationThreshold,
    checkRequirements,
    unmetPrerequisites: decision === RENDER_NEEDS.notRequired ? [] : ['stable_rendered_document_state'],
    requestedCheckFamilies,
    strength,
    rawClass: rawContentClass(comparableWords),
    facts: { ...facts, raw: undefined, metadata, nearEmpty, thinPrimaryDocument, executableStructure }
  };
}

export function resolveRenderCheckRequirements(facts = {}, activeCheckIds = null) {
  const active = new Set(Array.isArray(activeCheckIds)
    ? activeCheckIds
    : RENDER_CHECK_REQUIREMENTS.map((item) => item.checkId));
  const primaryContentIncomplete = Boolean(facts.hardSignals?.length || ((facts.nearEmpty || facts.thinPrimaryDocument) && facts.executableStructure));
  return RENDER_CHECK_REQUIREMENTS.filter((item) => active.has(item.checkId)).map((item) => {
    let requirement = item.defaultRequirement;
    if (item.requiredWhen === 'raw_primary_content_incomplete' && primaryContentIncomplete) requirement = 'render_required';
    if (item.requiredWhen === 'raw_primary_heading_and_content_incomplete' && primaryContentIncomplete && facts.h1Count === 0) requirement = 'render_required';
    if (item.requiredWhen === 'raw_navigation_and_content_incomplete' && primaryContentIncomplete && facts.internalLinks < 2) requirement = 'render_required';
    return {
      checkId: item.checkId,
      family: renderCheckFamily(item.checkId),
      requirement,
      reason: requirement === 'render_required'
        ? 'The applicable check cannot replace missing primary raw evidence.'
        : 'Browser evidence can add diagnostics but must not force a render when raw evidence is sufficient.'
    };
  });
}

export function activeRenderCheckIdsForAuditType(auditType = 'both') {
  if (auditType === 'geo') return [];
  return RENDER_CHECK_REQUIREMENTS.map((item) => item.checkId);
}

export function evaluateTemplateRenderEvidence(observations = []) {
  const comparable = observations.filter((item) => item && item.samePageType && item.sameRawStructure && item.renderSucceeded);
  if (comparable.length < 2) return { status: 'insufficient_evidence', confirmed: false, reason: 'two_independent_confirmations_required' };
  const collision = comparable.some((item) => item.urlSpecificRequiredSignal || item.relevantDifference);
  if (collision) return { status: 'invalidated', confirmed: false, reason: 'url_specific_or_rendered_difference_detected' };
  return { status: 'confirmed_raw_sufficient_template', confirmed: true, confirmations: comparable.length };
}

function collectRenderFacts(page = {}, options = {}) {
  const raw = safeJson(page.rawDocumentStateJson, {});
  const visibleWords = numberOr(raw.visibleText?.wordCount, page.wordCountRaw, 0);
  const mainWords = numberOr(raw.mainText?.wordCount, 0);
  const mainPresent = Boolean(raw.documentReadiness?.mainContentPresent);
  const comparableWords = mainPresent ? mainWords : visibleWords;
  const h1Count = Array.isArray(raw.h1) ? raw.h1.length : Number(page.h1Count || 0);
  const internalLinks = Array.isArray(raw.internalLinks) ? raw.internalLinks.length : Number(page.internalLinksCount || 0);
  const pageType = String(page.pageType || 'other');
  const indexable = page.indexable === undefined || page.indexable === null ? true : Boolean(page.indexable);
  const scriptCount = Math.max(0, Number(options.scriptCount ?? page.scriptCount ?? 0));
  const hydrationBytes = Math.max(0, Number(options.hydrationBytes ?? page.hydrationBytes ?? 0));
  const metadata = {
    title: scalar(raw.title ?? page.title),
    metaDescription: scalar(raw.metaDescription ?? page.metaDescription),
    canonical: scalar(raw.canonical ?? page.canonical),
    htmlLang: scalar(raw.htmlLang ?? page.htmlLang)
  };
  const missingMetadata = Object.entries(metadata).filter(([, value]) => !value).map(([field]) => field);
  const contentRelevant = indexable && CONTENT_PAGE_TYPES.has(pageType);
  const structuredDataTypes = Array.isArray(raw.structuredData?.types) ? raw.structuredData.types : [];
  return { raw, pageType, indexable, visibleWords, mainWords, mainPresent, comparableWords, h1Count, internalLinks, scriptCount, hydrationBytes, metadata, missingMetadata, contentRelevant, structuredDataTypes };
}

export function buildDeterministicRenderPlan(pages = [], budget = {}) {
  const normalizedBudget = normalizePlanBudget(budget);
  const classified = pages.map((page) => ({
    page,
    classification: page.classification || classifyRenderNeed(page, page)
  }));
  const checkConfirmations = applyCheckMinimumMeasurements(classified);
  const templateOrdinals = new Map();
  for (const group of groupBy(classified, (item) => item.page.templateClusterKey || `url:${item.page.url}`)) {
    group.sort((a, b) => String(a.page.url).localeCompare(String(b.page.url)));
    group.forEach((item, index) => templateOrdinals.set(item.page.url, index));
  }
  classified.sort((a, b) => {
    const need = needRank(b.classification.decision) - needRank(a.classification.decision);
    if (need) return need;
    const confirmation = Math.min(templateOrdinals.get(a.page.url) || 0, 2) - Math.min(templateOrdinals.get(b.page.url) || 0, 2);
    if (confirmation) return confirmation;
    const strength = Number(b.classification.strength || 0) - Number(a.classification.strength || 0);
    if (strength) return strength;
    return String(a.page.url).localeCompare(String(b.page.url));
  });

  let plannedCount = 0;
  let plannedTimeMs = 0;
  let plannedBytes = 0;
  const rows = classified.map(({ page, classification }) => {
    const wantsRender = classification.decision !== RENDER_NEEDS.notRequired;
    let executionDecision = classification.decision;
    let budgetReason = null;
    if (wantsRender) {
      const countExceeded = normalizedBudget.maxRenderedUrls !== null && plannedCount >= normalizedBudget.maxRenderedUrls;
      const timeExceeded = normalizedBudget.maxTotalRenderTimeMs !== null && plannedTimeMs + normalizedBudget.estimatedRenderTimeMs > normalizedBudget.maxTotalRenderTimeMs;
      const bytesExceeded = normalizedBudget.maxPersistedRenderBytes !== null && plannedBytes + normalizedBudget.estimatedPersistedBytes > normalizedBudget.maxPersistedRenderBytes;
      if (countExceeded || timeExceeded || bytesExceeded) {
        executionDecision = 'render_budget_exhausted';
        budgetReason = countExceeded ? 'max_rendered_urls' : timeExceeded ? 'max_total_render_time_ms' : 'max_persisted_render_bytes';
      } else {
        plannedCount += 1;
        plannedTimeMs += normalizedBudget.estimatedRenderTimeMs;
        plannedBytes += normalizedBudget.estimatedPersistedBytes;
      }
    }
    return {
      url: page.url,
      pageId: page.id || null,
      pageType: page.pageType || 'other',
      templateClusterKey: page.templateClusterKey || null,
      templateConfirmationOrdinal: templateOrdinals.get(page.url) || 0,
      classification,
      executionDecision,
      plannedBrowserRun: wantsRender && executionDecision !== 'render_budget_exhausted',
      budgetReason,
      priorityKey: stablePlanKey(classification, page, templateOrdinals.get(page.url) || 0)
    };
  });
  return {
    version: classified[0]?.classification?.version || RENDER_PLANNING_VERSION,
    budget: normalizedBudget,
    rows,
    summary: {
      totalUrls: rows.length,
      plannedRenderedUrls: rows.filter((row) => row.plannedBrowserRun).length,
      notRequiredUrls: rows.filter((row) => row.classification.decision === RENDER_NEEDS.notRequired).length,
      budgetExcludedUrls: rows.filter((row) => row.executionDecision === 'render_budget_exhausted').length,
      estimatedRenderTimeMs: plannedTimeMs,
      estimatedPersistedBytes: plannedBytes
    },
    checkConfirmations
  };
}

function applyCheckMinimumMeasurements(classified) {
  const confirmations = [];
  for (const [checkId, minimumMeasurements] of Object.entries(RENDER_CHECK_MINIMUM_MEASUREMENTS)) {
    const relevant = classified.filter((item) => item.classification.checkRequirements?.some((requirement) => requirement.checkId === checkId)
      && pageCanSupplyCheckMeasurement(item.page, checkId));
    const planned = relevant.filter((item) => item.classification.decision !== RENDER_NEEDS.notRequired);
    if (!planned.some((item) => item.classification.checkRequirements.some((requirement) => requirement.checkId === checkId && requirement.requirement === 'render_required'))) continue;
    const selectedTemplates = new Set(planned.map((item) => item.page.templateClusterKey).filter(Boolean));
    const candidates = relevant.filter((item) => item.classification.decision === RENDER_NEEDS.notRequired).sort((a, b) => {
      const aNewTemplate = a.page.templateClusterKey && !selectedTemplates.has(a.page.templateClusterKey) ? 1 : 0;
      const bNewTemplate = b.page.templateClusterKey && !selectedTemplates.has(b.page.templateClusterKey) ? 1 : 0;
      if (aNewTemplate !== bNewTemplate) return bNewTemplate - aNewTemplate;
      const score = Number(b.classification.recommendationScore || 0) - Number(a.classification.recommendationScore || 0);
      return score || String(a.page.url).localeCompare(String(b.page.url));
    });
    while (planned.length < minimumMeasurements && candidates.length) {
      const candidate = candidates.shift();
      const prior = candidate.classification;
      candidate.classification = {
        ...prior,
        decision: RENDER_NEEDS.recommended,
        confidence: 'medium',
        reason: `A second deterministic browser measurement is required to satisfy ${checkId} without treating a single rendered URL as conclusive.`,
        signals: [...new Set([...(prior.signals || []), `check_minimum_measurement_confirmation:${checkId}`])],
        checkRequirements: (prior.checkRequirements || []).map((requirement) => requirement.checkId === checkId
          ? { ...requirement, requirement: 'render_required', reason: `The check requires at least ${minimumMeasurements} independent stable measurements.` }
          : requirement),
        requestedCheckFamilies: [...new Set([...(prior.requestedCheckFamilies || []), 'rendered_content'])],
        unmetPrerequisites: ['stable_rendered_document_state'],
        strength: Math.max(180, Number(prior.strength || 0))
      };
      planned.push(candidate);
      if (candidate.page.templateClusterKey) selectedTemplates.add(candidate.page.templateClusterKey);
      confirmations.push({ checkId, url: candidate.page.url, minimumMeasurements, reason: 'minimum_stable_measurements' });
    }
  }
  return confirmations;
}

function pageCanSupplyCheckMeasurement(page = {}, checkId) {
  if (checkId !== 'tech.js_dependent_content') return true;
  const finalStatus = finiteStatus(page.statusCode);
  const initialStatus = finiteStatus(page.initialStatusCode) ?? finalStatus;
  const contentType = String(page.contentType || '').toLowerCase();
  const finalOk = finalStatus === null || (finalStatus >= 200 && finalStatus < 300);
  const initialOk = initialStatus === null || (initialStatus >= 200 && initialStatus < 300);
  const html = !contentType || contentType.includes('html');
  return finalOk && initialOk && html;
}

export function estimateRenderCost(input = {}) {
  const urlCount = Math.max(0, Number(input.urlCount || 0));
  const renderShare = clamp(Number(input.renderShare ?? 0), 0, 1);
  const renderedUrls = Math.ceil(urlCount * renderShare);
  const concurrency = Math.max(1, Number(input.concurrency || 1));
  const rawFetchMs = Math.max(0, Number(input.rawFetchMs || 0));
  const browserLaunchMs = renderedUrls ? Math.max(0, Number(input.browserLaunchMs || 0)) : 0;
  const p50RenderMs = Math.max(0, Number(input.p50RenderMs || 0));
  const p90RenderMs = Math.max(p50RenderMs, Number(input.p90RenderMs || p50RenderMs));
  const bytesPerRender = Math.max(0, Number(input.bytesPerRender || 0));
  const estimate = (renderMs) => browserLaunchMs + urlCount * rawFetchMs + Math.ceil(renderedUrls / concurrency) * renderMs;
  return {
    assumptions: { urlCount, renderShare, renderedUrls, concurrency, rawFetchMs, browserLaunchMs, p50RenderMs, p90RenderMs, bytesPerRender },
    expectedTotalDurationP50Ms: estimate(p50RenderMs),
    expectedTotalDurationP90Ms: estimate(p90RenderMs),
    expectedRenderDurationP50Ms: browserLaunchMs + Math.ceil(renderedUrls / concurrency) * p50RenderMs,
    expectedRenderDurationP90Ms: browserLaunchMs + Math.ceil(renderedUrls / concurrency) * p90RenderMs,
    expectedPersistedRenderBytes: renderedUrls * bytesPerRender,
    expectedBrowserRuns: renderedUrls,
    warning: urlCount >= 1000 && concurrency === 1 ? 'Concurrency 1 makes browser rendering the dominant cost at this scale.' : null
  };
}

export function percentile(values = [], percentileValue = 0.5) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * clamp(percentileValue, 0, 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function normalizePlanBudget(value) {
  return {
    maxRenderedUrls: normalizeOptionalBudget(value.maxRenderedUrls),
    maxTotalRenderTimeMs: normalizeOptionalBudget(value.maxTotalRenderTimeMs),
    maxPersistedRenderBytes: normalizeOptionalBudget(value.maxPersistedRenderBytes),
    maxBrowserFailures: normalizeOptionalBudget(value.maxBrowserFailures),
    estimatedRenderTimeMs: Math.max(1, Number(value.estimatedRenderTimeMs || 5000)),
    estimatedPersistedBytes: Math.max(1, Number(value.estimatedPersistedBytes || 30000))
  };
}

function rawContentClass(words) {
  if (!words) return 'empty';
  if (words < 50) return 'thin';
  if (words < 100) return 'moderate';
  return 'substantial';
}

function stablePlanKey(classification, page, ordinal) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: classification.version || null,
    need: classification.decision,
    strength: classification.strength,
    template: page.templateClusterKey || null,
    confirmationOrdinal: ordinal,
    url: page.url
  })).digest('hex').slice(0, 20);
}

function needRank(value) {
  if (value === RENDER_NEEDS.required) return 3;
  if (value === RENDER_NEEDS.recommended) return 2;
  return 1;
}

function renderCheckFamily(checkId) {
  if (checkId.includes('console_errors')) return 'browser_events';
  if (checkId.includes('internal_links')) return 'rendered_links';
  if (checkId.includes('h1') || checkId.includes('word_count') || checkId.includes('js_dependent') || checkId.includes('js_required')) return 'rendered_content';
  return 'rendered_metadata';
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) || [];
    group.push(item);
    map.set(key, group);
  }
  return [...map.values()];
}

function scalar(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function numberOr(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function finiteStatus(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeJson(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || fallback; } catch { return fallback; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
