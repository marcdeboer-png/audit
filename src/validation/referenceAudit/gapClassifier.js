import { slug } from './referenceAuditModel.js';

const GAP_STATUSES = new Set([
  'partially_covered',
  'not_covered',
  'needs_external_data',
  'needs_larger_crawl',
  'needs_human_review',
  'needs_llm_review',
  'false_negative_candidate',
  'false_positive_candidate'
]);

export function buildGapBacklog(coverageMatrix = []) {
  return coverageMatrix
    .filter((row) => GAP_STATUSES.has(row.coverageStatus))
    .map((row, index) => backlogEntry(row, index + 1));
}

export function gapAnalysisFromCoverage(coverageMatrix = [], toolExtras = []) {
  const grouped = groupBy(coverageMatrix, (row) => row.coverageStatus);
  return {
    totalGaps: coverageMatrix.filter((row) => GAP_STATUSES.has(row.coverageStatus)).length,
    falseNegativeCandidates: grouped.false_negative_candidate?.length || 0,
    falsePositiveCandidates: grouped.false_positive_candidate?.length || 0,
    needsExternalData: grouped.needs_external_data?.length || 0,
    needsLargerCrawl: grouped.needs_larger_crawl?.length || 0,
    needsHumanReview: grouped.needs_human_review?.length || 0,
    needsLlmReview: grouped.needs_llm_review?.length || 0,
    partiallyCovered: grouped.partially_covered?.length || 0,
    notCovered: grouped.not_covered?.length || 0,
    toolExtras: toolExtras.length,
    scoreCalibrationNotes: scoreCalibrationNotes(coverageMatrix, toolExtras)
  };
}

function backlogEntry(row, ordinal) {
  const item = row.manualItem || {};
  const mapping = row.mapping || {};
  const gapType = row.coverageStatus;
  const possibleCheckId = mapping.expectedCheckIds?.[0] || mapping.possibleCheckIds?.[0] || possibleCheckIdFor(item, mapping);
  return {
    gapId: `gap-${String(ordinal).padStart(3, '0')}-${slug(item.title || row.manualItemId).slice(0, 48)}`,
    sourceManualItemId: row.manualItemId,
    title: item.title || row.manualItemId,
    category: item.category || mapping.category || 'uncategorized',
    gapType,
    priority: item.priority || priorityForGap(gapType),
    suggestedImplementation: suggestedImplementation(row, possibleCheckId),
    requiredData: mapping.requiredData || [],
    possibleCheckId,
    estimatedEffort: estimatedEffort(row),
    expectedImpact: expectedImpact(row),
    notes: row.rationale || ''
  };
}

function suggestedImplementation(row, possibleCheckId) {
  const item = row.manualItem || {};
  const title = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (row.coverageStatus === 'needs_external_data') {
    return `Importiere oder mappe die benoetigten externen Daten (${(row.requiredData || []).join(', ') || 'external data'}) und ergaenze daraus ${possibleCheckId || 'einen validierbaren Check'}.`;
  }
  if (row.coverageStatus === 'needs_larger_crawl') {
    return 'Validiere diesen Punkt mit einem groesseren Crawl oder Screaming-Frog-Import, damit Template-/Full-Domain-Reichweite belastbar messbar ist.';
  }
  if (row.coverageStatus === 'needs_llm_review') {
    return 'Ergaenze einen sample-basierten LLM-Check mit Prompt Registry, Cost Guard und Review-Pflicht.';
  }
  if (row.coverageStatus === 'needs_human_review') {
    return 'Fuehre eine Review-Queue/Checkliste ein, damit fachliche Bewertung neben technischen Fakten sichtbar wird.';
  }
  if (/facet|facette|filter|parameter|crawl.?bloat/.test(title)) {
    return 'Baue URL-Pattern- und Parameter-Cluster fuer Facetten-/Filter-Crawl-Bloat inklusive Template-/PageType-Reichweite.';
  }
  if (/cache|cdn/.test(title)) {
    return 'Erweitere Response-Header- und Resource-Facts um Cache-/CDN-Pattern und exportiere betroffene Templates.';
  }
  if (/crux|psi|core web vitals/.test(title)) {
    return 'Mappe CrUX-/PSI-Felder aus Screaming Frog oder externen Exporten stabil in URL-Facts und Performance-Findings.';
  }
  if (row.coverageStatus === 'partially_covered') {
    return `Verbessere Evidence Matching und Detaildaten fuer ${possibleCheckId || 'den bestehenden Check'}, damit der manuelle Punkt vollstaendig belegbar wird.`;
  }
  return `Implementiere oder erweitere ${possibleCheckId || 'einen generischen Check'} fuer diesen manuellen Auditpunkt.`;
}

function possibleCheckIdFor(item, mapping) {
  const category = item.category || mapping.category || '';
  if (category === 'geo-readiness') return 'llm.geo_answerability_sample';
  if (category === 'trust-entity') return 'llm.trust_clarity_sample';
  if (category === 'media-performance') return 'tech.performance_pattern_extension';
  if (category === 'technical-seo') return 'tech.reference_gap_check';
  return null;
}

function priorityForGap(gapType) {
  if (['false_negative_candidate', 'not_covered'].includes(gapType)) return 'High';
  if (['needs_external_data', 'needs_larger_crawl', 'partially_covered'].includes(gapType)) return 'Medium';
  return 'Low';
}

function estimatedEffort(row) {
  if (row.coverageStatus === 'needs_external_data') return 'M';
  if (row.coverageStatus === 'needs_larger_crawl') return 'S';
  if (row.coverageStatus === 'needs_llm_review') return 'M';
  if (row.coverageStatus === 'needs_human_review') return 'S';
  if (row.coverageStatus === 'partially_covered') return 'S';
  return 'M';
}

function expectedImpact(row) {
  const priority = row.manualItem?.priority || row.manualItem?.severity || '';
  if (/high|critical|hoch/i.test(priority)) return 'high';
  if (/medium|mittel/i.test(priority)) return 'medium';
  return row.coverageStatus === 'false_negative_candidate' ? 'medium' : 'low';
}

function scoreCalibrationNotes(coverageMatrix, toolExtras) {
  const notes = [];
  const highManualGaps = coverageMatrix.filter((row) =>
    ['not_covered', 'false_negative_candidate'].includes(row.coverageStatus) && row.manualItem?.priority === 'High'
  );
  if (highManualGaps.length) {
    notes.push(`${highManualGaps.length} high-priority manual point(s) are not fully represented in tool scoring yet.`);
  }
  const lowPriorityExtras = toolExtras.filter((row) => row.extraClassification === 'low_priority');
  if (lowPriorityExtras.length) {
    notes.push(`${lowPriorityExtras.length} low-priority tool extra(s) should stay separated from score calibration until reviewed.`);
  }
  if (!notes.length) notes.push('No automatic scoring change recommended from this validation run.');
  return notes;
}

function groupBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row);
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});
}
