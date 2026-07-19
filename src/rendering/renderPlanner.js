import crypto from 'node:crypto';

export const RENDER_PLANNING_VERSION = 'deterministic-render-gate-v1';
export const RUNTIME_METRICS_VERSION = 'render-runtime-metrics-v1';

export const RENDER_NEEDS = Object.freeze({
  required: 'render_required',
  recommended: 'render_recommended',
  notRequired: 'render_not_required'
});

const CONTENT_PAGE_TYPES = new Set(['homepage', 'article', 'product', 'category', 'service', 'location', 'blog_index']);
const UTILITY_PAGE_TYPES = new Set(['legal', 'search', 'filter', 'utility']);

export function normalizeMetricsMode(value) {
  return ['off', 'basic', 'profiling'].includes(value) ? value : 'basic';
}

export function normalizeOptionalBudget(value, { minimum = 0 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(minimum, Math.floor(number));
}

export function classifyRenderNeed(page = {}, options = {}) {
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
    version: RENDER_PLANNING_VERSION,
    decision,
    confidence,
    reason,
    signals,
    unmetPrerequisites: decision === RENDER_NEEDS.notRequired ? [] : ['stable_rendered_document_state'],
    requestedCheckFamilies: options.requestedCheckFamilies || ['rendered_metadata', 'rendered_content', 'rendered_links', 'browser_events'],
    strength,
    rawClass: rawContentClass(comparableWords),
    facts: { pageType, indexable, visibleWords, mainWords, mainPresent, comparableWords, h1Count, internalLinks, scriptCount, hydrationBytes, missingMetadata }
  };
}

export function buildDeterministicRenderPlan(pages = [], budget = {}) {
  const normalizedBudget = normalizePlanBudget(budget);
  const classified = pages.map((page) => ({
    page,
    classification: page.classification || classifyRenderNeed(page, page)
  }));
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
    version: RENDER_PLANNING_VERSION,
    budget: normalizedBudget,
    rows,
    summary: {
      totalUrls: rows.length,
      plannedRenderedUrls: rows.filter((row) => row.plannedBrowserRun).length,
      notRequiredUrls: rows.filter((row) => row.classification.decision === RENDER_NEEDS.notRequired).length,
      budgetExcludedUrls: rows.filter((row) => row.executionDecision === 'render_budget_exhausted').length,
      estimatedRenderTimeMs: plannedTimeMs,
      estimatedPersistedBytes: plannedBytes
    }
  };
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

function safeJson(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || fallback; } catch { return fallback; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
