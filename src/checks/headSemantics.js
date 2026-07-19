import { evaluateCanonicalPage } from './canonicalSemantics.js';

export const HEAD_CHECK_LOGIC_VERSION = 'effective-head-heading-v2';

export function normalizeHeadText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function normalizeHeadComparisonKey(value) {
  return normalizeHeadText(value).toLocaleLowerCase('und');
}

export function collectHeadMetadataPopulation(db, runId, finalDomain, field) {
  const legacyField = field === 'title' ? 'title' : 'metaDescription';
  const effectiveField = field === 'title' ? 'effectiveTitle' : 'effectiveMetaDescription';
  const sourceRows = db.prepare(`
    SELECT id, url, normalizedUrl, finalUrl, contentType, statusCode, initialStatusCode,
      indexable, pageType, templateClusterKey, canonical, effectiveCanonical,
      rawDocumentStateJson, effectiveDocumentStateJson, metadataProvenanceComplete,
      ${legacyField} AS rawValue, ${effectiveField} AS effectiveValue,
      renderStatus, settlingStatus
    FROM pages
    WHERE runId = ?
      AND (contentType LIKE '%text/html%' OR contentType LIKE '%application/xhtml%')
      AND statusCode >= 200 AND statusCode < 300
      AND COALESCE(initialStatusCode, statusCode) >= 200
      AND COALESCE(initialStatusCode, statusCode) < 300
      AND indexable = 1
      AND COALESCE(pageType, 'other') <> 'legal'
    ORDER BY id ASC
  `).all(runId);
  const current = sourceRows.some((row) => row.rawDocumentStateJson != null);
  const observations = sourceRows.map((row) => {
    const evaluated = !current || (row.rawDocumentStateJson != null && Number(row.metadataProvenanceComplete) === 1);
    const canonicalEvaluation = evaluated ? evaluateCanonicalPage(row, finalDomain, current) : null;
    const consolidated = Boolean(canonicalEvaluation && !canonicalEvaluation.missing && (!canonicalEvaluation.isSelf || canonicalEvaluation.conflict));
    const rawValue = evaluated ? (current ? row.effectiveValue : row.rawValue) : null;
    const value = rawValue == null ? null : normalizeHeadText(rawValue);
    return { ...row, evaluated, consolidated, value, comparisonKey: value == null ? '' : normalizeHeadComparisonKey(value) };
  });
  return {
    current,
    total: observations.length,
    incomplete: observations.filter((row) => !row.evaluated).length,
    canonicalizedExcluded: observations.filter((row) => row.evaluated && row.consolidated).length,
    observations,
    rows: observations.filter((row) => row.evaluated && !row.consolidated)
  };
}

export function duplicateHeadGroups(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.comparisonKey) continue;
    const group = groups.get(row.comparisonKey) || {
      groupKey: row.comparisonKey,
      value: row.value,
      urls: [],
      pageTypes: new Set(),
      templateKeys: new Set()
    };
    if (!group.urls.includes(row.url)) group.urls.push(row.url);
    group.pageTypes.add(row.pageType || 'other');
    group.templateKeys.add(row.templateClusterKey || `${row.pageType || 'other'}:unclustered`);
    groups.set(row.comparisonKey, group);
  }
  return [...groups.values()]
    .filter((group) => group.urls.length > 1)
    .map((group) => ({
      groupKey: group.groupKey,
      value: group.value,
      count: group.urls.length,
      urls: [...group.urls].sort(),
      pageTypes: [...group.pageTypes].sort(),
      templateKeys: [...group.templateKeys].sort()
    }))
    .sort((left, right) => right.count - left.count || left.groupKey.localeCompare(right.groupKey));
}
