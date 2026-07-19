import { all, safeJson } from './helpers.js';
import { hasArticleSchema, hasProductSchema } from '../extractors/pageType.js';
import { classifyPageType } from '../extractors/pageType.js';
import { hasVisibleTextProvenance } from '../extractors/visibleText.js';

export const STRUCTURED_DATA_COVERAGE_LOGIC_VERSION = 'structured-data-coverage-v2';

const SUCCESSFUL_HTML = `
  statusCode >= 200 AND statusCode < 300
  AND COALESCE(initialStatusCode, statusCode) >= 200 AND COALESCE(initialStatusCode, statusCode) < 300
  AND (contentType LIKE '%text/html%' OR contentType LIKE '%application/xhtml%')
`;

export function evaluatePageTypeSchemaCoverage(db, runId, pageType, schemaFamily) {
  const candidates = all(db, `
    SELECT url, schemaTypesJson, effectiveSchemaTypesJson, structuredDataFactsJson,
           statusCode, initialStatusCode, contentType, indexable, pageType,
           pageTypeConfidence, pageTypeSignalsJson, textFactsJson, featureFlagsJson
    FROM pages
    WHERE runId = ? AND pageType = ? AND ${SUCCESSFUL_HTML}
    ORDER BY id ASC
  `, [runId, pageType]);
  const excluded = candidates.filter((row) => {
    const urlOnlyClassification = classifyPageType({ url: row.url });
    return urlOnlyClassification.confidence === 'high' &&
      ['blog_index', 'article_index', 'category_index', 'product_index', 'category']
        .includes(urlOnlyClassification.pageType);
  });
  const scopedCandidates = candidates.filter((row) => !excluded.includes(row));
  const scopeUnavailable = scopedCandidates.filter((row) => row.indexable === null || row.indexable === undefined);
  const nonIndexable = scopedCandidates.filter((row) => Number(row.indexable) === 0);
  const eligibleCandidates = scopedCandidates.filter((row) => Number(row.indexable) === 1);
  const classified = eligibleCandidates.map((row) => {
    const schemaTypes = effectiveSchemaTypes(row);
    const schemaMatches = schemaFamily === 'Article' ? hasArticleSchema(schemaTypes) : hasProductSchema(schemaTypes);
    const classificationReliable = row.pageTypeConfidence === 'high' || schemaMatches || legacyClassificationReliable(row, pageType);
    return { ...row, schemaTypes, schemaMatches, classificationReliable };
  });
  const uncertain = classified.filter((row) => !row.classificationReliable);
  const evaluable = classified.filter((row) => row.classificationReliable);
  const missing = evaluable.filter((row) => !row.schemaMatches);
  return { candidates: eligibleCandidates, excluded, scopeUnavailable, nonIndexable, classified, uncertain, evaluable, missing };
}

export function effectiveSchemaTypes(row = {}) {
  const effective = safeJson(row.effectiveSchemaTypesJson, null);
  return Array.isArray(effective) ? effective : safeJson(row.schemaTypesJson, []);
}

function legacyClassificationReliable(row, pageType) {
  if (!hasVisibleTextProvenance(row.textFactsJson)) return false;
  const flags = safeJson(row.featureFlagsJson, {});
  if (pageType === 'article') {
    return Number(flags.articleElementCount || 0) > 0 || /\/(beitrag|post|posts|article|articles|artikel)\//i.test(String(row.url || ''));
  }
  if (pageType === 'product') {
    const independentCommerceSignals = [
      Number(flags.productDetailFormCount || 0) > 0,
      Number(flags.visiblePriceCount || 0) > 0,
      Number(flags.visibleSkuCount || 0) > 0
    ].filter(Boolean).length;
    return independentCommerceSignals >= 2 && /\/(product|products|produkt|produkte|shop|p)\//i.test(String(row.url || ''));
  }
  return false;
}
