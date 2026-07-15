const STRONG_QUERY_KEYS = new Set(['s', 'search', 'query']);
const AMBIGUOUS_QUERY_KEYS = new Set(['q']);
const SEARCH_PATH_SEGMENTS = new Set(['search', 'suche', 'site-search', 'site-search-results']);
const NON_SEARCH_PAGE_TYPES = new Set(['blog_index', 'article_index', 'category_index', 'product_index', 'category']);

export function classifyInternalSearchPage(page = {}) {
  const url = safeUrl(page.url || page.finalUrl);
  const flags = objectValue(page.featureFlags ?? page.featureFlagsJson);
  const schemaTypes = arrayValue(page.schemaTypes ?? page.schemaTypesJson);
  const titleAndH1 = `${page.title || ''} ${arrayValue(page.h1 ?? page.h1Json).join(' ')}`.toLowerCase();
  const pathSegments = url ? url.pathname.toLowerCase().split('/').filter(Boolean) : [];
  const queryKeys = url ? [...url.searchParams.keys()].map((key) => key.toLowerCase()) : [];
  const positiveSignals = [];
  const contradictorySignals = [];

  const strongQueryKeys = queryKeys.filter((key) => STRONG_QUERY_KEYS.has(key));
  const ambiguousQueryKeys = queryKeys.filter((key) => AMBIGUOUS_QUERY_KEYS.has(key));
  const hasSearchPath = pathSegments.some((segment) => SEARCH_PATH_SEGMENTS.has(segment));
  const hasExplicitResultHeading = /\b(search results?|suchergebnisse|ergebnisse\s+f(?:u|ü)r|results?\s+for)\b/i.test(titleAndH1) || Boolean(flags.hasExplicitSearchResultsText);
  const hasMainSearchForm = Number(flags.mainSearchFormCount || 0) > 0;
  const hasResultList = Number(flags.searchResultListCount || 0) > 0;
  const hasSearchAction = schemaTypes.some((type) => String(type).toLowerCase() === 'searchaction') || Boolean(flags.hasSearchAction);
  const globalSearchFormOnly = Number(flags.searchFormCount || 0) > 0 && !hasMainSearchForm;

  if (strongQueryKeys.length) positiveSignals.push(signal('strong_search_query', 3, { keys: strongQueryKeys }));
  if (ambiguousQueryKeys.length) positiveSignals.push(signal('ambiguous_q_query', 1, { keys: ambiguousQueryKeys }));
  if (hasSearchPath) positiveSignals.push(signal('search_path_segment', 3, { segments: pathSegments.filter((segment) => SEARCH_PATH_SEGMENTS.has(segment)) }));
  if (hasExplicitResultHeading) positiveSignals.push(signal('explicit_results_heading_or_text', 3));
  if (hasMainSearchForm) positiveSignals.push(signal('main_content_search_form', 2, { count: Number(flags.mainSearchFormCount) }));
  if (hasResultList) positiveSignals.push(signal('search_result_list', 2, { count: Number(flags.searchResultListCount) }));
  if (hasSearchAction) positiveSignals.push(signal('search_action_schema', 1));

  if (NON_SEARCH_PAGE_TYPES.has(page.pageType)) contradictorySignals.push(signal('listing_or_archive_page_type', -3, { pageType: page.pageType }));
  if (pathSegments.some((segment) => ['tag', 'tags', 'category', 'kategorie', 'author', 'autor', 'glossar', 'glossary'].includes(segment))) {
    contradictorySignals.push(signal('archive_or_glossary_path', -3));
  }
  if (url && [...url.searchParams.keys()].some((key) => ['filter', 'sort', 'page', 'category', 'tag'].includes(key.toLowerCase())) && !strongQueryKeys.length) {
    contradictorySignals.push(signal('filter_or_listing_query', -2));
  }
  if (globalSearchFormOnly) contradictorySignals.push(signal('global_header_search_form_only', 0));

  const positiveScore = positiveSignals.reduce((sum, item) => sum + item.weight, 0);
  const contradictionScore = contradictorySignals.reduce((sum, item) => sum + item.weight, 0);
  const score = positiveScore + contradictionScore;
  const independentStrongSignals = [strongQueryKeys.length > 0, hasSearchPath, hasExplicitResultHeading, hasMainSearchForm, hasResultList].filter(Boolean).length;
  const highConfidence = independentStrongSignals >= 2 && score >= 5 && contradictionScore > -3;
  const conflicting = positiveScore >= 3 && contradictionScore <= -2;
  const unclear = !highConfidence && (positiveScore >= 2 || conflicting);

  return {
    classification: highConfidence ? 'internal_search' : unclear ? 'unclear' : 'not_internal_search',
    confidence: highConfidence ? 'high' : unclear ? 'low' : 'high',
    score,
    positiveScore,
    contradictionScore,
    positiveSignals,
    contradictorySignals,
    rationale: highConfidence
      ? 'Multiple independent search-result signals are present.'
      : unclear
        ? 'Search-related evidence is incomplete or contradicted by listing/archive signals.'
        : globalSearchFormOnly
          ? 'Only a global header/navigation search form was detected.'
          : 'No sufficient search-result-page evidence was detected.'
  };
}

function signal(id, weight, details = {}) {
  return { id, weight, ...details };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
