import { COVERAGE_STATUSES, normalizePriority, normalizeUrls, text } from './referenceAuditModel.js';

const ACTIVE_STATUSES = new Set(['Warning', 'Error']);

export function classifyManualItemCoverage(item, mapping, toolFindings = [], options = {}) {
  const candidates = candidateMatches(item, mapping, toolFindings);
  const best = candidates[0] || null;
  const activeBest = candidates.find((candidate) => ACTIVE_STATUSES.has(candidate.finding.status || candidate.finding.effectiveStatus)) || null;
  const largerCrawl = needsLargerCrawl(item, mapping, options.run);

  if (item.status === 'not_applicable') return manualResult(item, mapping, best, 'not_applicable', 'high', 'Reference item is marked not applicable.');
  if (item.status === 'ok' && best && ['OK', 'NA'].includes(best.finding.status || best.finding.effectiveStatus)) {
    const coverageStatus = best.matchScore >= 55 ? 'covered' : 'partially_covered';
    return manualResult(item, mapping, best, coverageStatus, confidenceFromScore(best.matchScore), 'Manual audit marks this point OK and the related tool check is not active.');
  }
  if (item.status === 'ok' && activeBest && isAdvisoryNonContradictory(activeBest.finding)) {
    const coverageStatus = activeBest.matchScore >= 55 ? 'covered' : 'partially_covered';
    return manualResult(
      item,
      mapping,
      activeBest,
      coverageStatus,
      confidenceFromScore(activeBest.matchScore),
      'Manual audit marks this point OK; the related tool finding is advisory/review-oriented and does not contradict the manual OK.'
    );
  }
  if (item.status === 'ok' && activeBest) {
    return manualResult(item, mapping, activeBest, 'false_positive_candidate', confidenceFromScore(activeBest.matchScore), 'Manual audit marks this point OK, but the current tool run has an active related finding.');
  }
  if (mapping.requiresExternalData && !activeBest) return manualResult(item, mapping, best, 'needs_external_data', mapping.mappingConfidence, 'Reference item needs data not available in the current run.');
  if (mapping.requiresLlmJudgment && !activeBest) return manualResult(item, mapping, best, 'needs_llm_review', mapping.mappingConfidence, 'Reference item needs qualitative LLM-assisted review.');
  if (mapping.requiresHumanJudgment && !activeBest) return manualResult(item, mapping, best, 'needs_human_review', mapping.mappingConfidence, 'Reference item needs human judgment.');

  if (activeBest) {
    const coverageStatus = activeBest.matchScore >= 70 ? 'covered' : 'partially_covered';
    const rationale = largerCrawl && coverageStatus === 'partially_covered'
      ? `${activeBest.reason}. Current run is a small sample for this large-domain reference item.`
      : activeBest.reason;
    return manualResult(item, mapping, activeBest, coverageStatus, confidenceFromScore(activeBest.matchScore), rationale);
  }

  if (largerCrawl && (mapping.expectedCheckIds.length || mapping.possibleCheckIds.length)) {
    return manualResult(item, mapping, best, 'needs_larger_crawl', mapping.mappingConfidence, 'Reference item is automatable, but the current run is too small/sampled to validate the full-domain manual finding fairly.');
  }

  if (best && ['OK', 'NA'].includes(best.finding.status || best.finding.effectiveStatus)) {
    return manualResult(item, mapping, best, 'partially_covered', confidenceFromScore(best.matchScore), 'Tool has a related check, but it did not produce an active finding.');
  }

  if (mapping.expectedCheckIds.length || mapping.possibleCheckIds.length) {
    return manualResult(item, mapping, null, 'false_negative_candidate', mapping.mappingConfidence, 'Reference item maps to an automatable check, but no matching tool finding was active.');
  }

  return manualResult(item, mapping, null, 'not_covered', 'low', 'No reliable mapping to an existing tool check was found.');
}

function needsLargerCrawl(item, mapping, run = {}) {
  const processedUrls = Number(run?.processedUrls || run?.successfulUrls || 0);
  if (!processedUrls || processedUrls > 1000) return false;
  const affectedCount = Number(item.affectedCount || 0);
  const itemText = searchableText([
    item.title,
    item.description,
    item.recommendation,
    item.notes,
    Object.values(item.evidence || {}).join(' '),
    (item.expectedDataSources || []).join(' ')
  ]);
  const hasLargeManualScope = affectedCount >= Math.max(500, processedUrls * 3)
    || /(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(pages|pdps?|plps?|urls|seiten)/i.test(itemText)
    || /full crawl|all pages|gesamte domain|sitewide|template|systematic|systematisch|crawl budget|faceted navigation|facet|filter/.test(itemText);
  const automatable = (mapping.expectedCheckIds || []).length || (mapping.possibleCheckIds || []).length;
  return Boolean(hasLargeManualScope && automatable);
}

export function classifyToolExtraFindings(toolFindings = [], matchedToolFindingIds = new Set(), coverageMatrix = []) {
  const indirectlyCoveredCheckIds = new Set(coverageMatrix
    .filter((row) => ['covered', 'partially_covered'].includes(row.coverageStatus))
    .flatMap((row) => [
      ...(row.mapping?.expectedCheckIds || []),
      ...(row.mapping?.possibleCheckIds || [])
    ]));
  return toolFindings
    .filter((finding) => ACTIVE_STATUSES.has(finding.status || finding.effectiveStatus))
    .filter((finding) => !matchedToolFindingIds.has(Number(finding.id)))
    .map((finding) => {
      const affectedCount = Number(finding.affectedCount || 0);
      const priority = finding.effectivePriority || finding.priority || 'Low';
      const confidence = finding.confidence || 'medium';
      const { extraClassification, reason, suggestedAction } = classifyExtra({
        finding,
        affectedCount,
        priority,
        confidence,
        indirectlyCoveredCheckIds
      });
      return {
        coverageStatus: 'tool_finds_extra',
        extraClassification,
        confidence: confidence === 'high' ? 'high' : confidence === 'low' ? 'low' : 'medium',
        reason,
        suggestedAction,
        toolFindingId: finding.id,
        checkId: finding.checkId,
        category: finding.category,
        title: finding.checkName || finding.title || finding.checkId,
        priority,
        status: finding.status || finding.effectiveStatus,
        affectedCount,
        finding: finding.finding || finding.effectiveFinding || '',
        recommendation: finding.recommendation || finding.effectiveRecommendation || '',
        sampleUrls: parseJson(finding.sampleUrlsJson, finding.sampleUrls || [])
      };
    });
}

function classifyExtra({ finding, affectedCount, priority, confidence, indirectlyCoveredCheckIds }) {
  const findingType = finding.normalizedFindingType || finding.findingType || '';
  const reviewRecommended = Boolean(finding.reviewRecommended);
  if (affectedCount === 0 || (confidence === 'low' && priority === 'Low')) {
    return {
      extraClassification: 'false_positive_candidate',
      reason: 'Active finding has low confidence or no affected rows.',
      suggestedAction: 'Review threshold and evidence before using this as audit delta.'
    };
  }
  if (indirectlyCoveredCheckIds.has(finding.checkId)) {
    return {
      extraClassification: 'already_covered_indirectly',
      reason: 'Check belongs to a family already matched to a manual audit item.',
      suggestedAction: 'Group with the matched manual item or keep as supporting evidence.'
    };
  }
  if (reviewRecommended && ['opportunity', 'best_practice'].includes(findingType)) {
    return {
      extraClassification: 'needs_review',
      reason: 'Advisory finding should be reviewed before using it as tool-only audit value.',
      suggestedAction: 'Keep as review evidence; do not present as a hard additional defect without validation.'
    };
  }
  if (findingType === 'opportunity') {
    return {
      extraClassification: 'low_priority',
      reason: 'Tool-only finding is an opportunity rather than a hard issue.',
      suggestedAction: 'Keep separate from executive risks unless repeated across important templates.'
    };
  }
  if (confidence === 'low') {
    return {
      extraClassification: 'needs_review',
      reason: 'Finding confidence is low.',
      suggestedAction: 'Review manually before presenting as added tool value.'
    };
  }
  if (priority === 'Low') {
    return {
      extraClassification: 'low_priority',
      reason: 'Finding is active but low priority.',
      suggestedAction: 'Keep separate from executive risks unless repeated across templates.'
    };
  }
  return {
    extraClassification: 'likely_relevant',
    reason: 'Active unmatched finding with non-low priority.',
    suggestedAction: 'Review as potential additional tool insight beyond the manual audit.'
  };
}

export function candidateMatches(item, mapping, toolFindings = []) {
  const expectedIds = new Set(mapping.expectedCheckIds || []);
  const possibleIds = new Set(mapping.possibleCheckIds || []);
  const itemUrls = new Set(normalizeUrls(item.affectedUrls || []));
  const itemText = searchableText([item.title, item.description, item.recommendation, item.category]);

  return toolFindings
    .map((finding) => {
      const checkId = finding.checkId;
      const sampleUrls = normalizeUrls(parseJson(finding.sampleUrlsJson, finding.sampleUrls || []));
      const urlOverlap = sampleUrls.filter((url) => itemUrls.has(url)).length;
      const categoryMatch = normalizeCategoryKey(finding.category) === normalizeCategoryKey(mapping.category || item.category);
      const direct = expectedIds.has(checkId);
      const possible = possibleIds.has(checkId);
      const textScore = textSimilarity(itemText, searchableText([finding.checkName, finding.finding, finding.details, finding.recommendation, finding.category]));
      const affectedScore = affectedCountScore(item.affectedCount, finding.affectedCount);
      let score = 0;
      const reasons = [];
      if (direct) {
        score += 55;
        reasons.push('checkId mapped');
      } else if (possible) {
        score += 35;
        reasons.push('possible/pattern check matched');
      }
      if (urlOverlap) {
        score += Math.min(25, 10 + urlOverlap * 5);
        reasons.push(`${urlOverlap} URL sample overlap`);
      }
      if (affectedScore) {
        score += affectedScore;
        reasons.push('affected count aligned');
      }
      if (categoryMatch) {
        score += 10;
        reasons.push('category aligned');
      }
      if (textScore >= 0.18) {
        score += Math.min(15, Math.round(textScore * 50));
        reasons.push('text similarity');
      }
      if (priorityAligned(item.priority, finding.effectivePriority || finding.priority)) {
        score += 5;
        reasons.push('priority aligned');
      }
      return {
        finding,
        matchScore: Math.min(100, score),
        confidence: confidenceFromScore(score),
        urlOverlap,
        reason: reasons.join(', ') || 'weak candidate'
      };
    })
    .filter((candidate) => candidate.matchScore >= 25)
    .sort((a, b) => b.matchScore - a.matchScore || Number(b.finding.affectedCount || 0) - Number(a.finding.affectedCount || 0));
}

function manualResult(item, mapping, match, coverageStatus, confidence, rationale) {
  if (!COVERAGE_STATUSES.includes(coverageStatus)) throw new Error(`Invalid coverage status ${coverageStatus}`);
  return {
    manualItemId: item.id,
    coverageStatus,
    confidence,
    rationale,
    matchedToolFindingId: match?.finding?.id || null,
    matchedCheckId: match?.finding?.checkId || null,
    matchScore: match?.matchScore || 0,
    urlOverlap: match?.urlOverlap || 0,
    expectedCheckIds: mapping.expectedCheckIds,
    requiredData: mapping.requiredData,
    requiresExternalData: mapping.requiresExternalData,
    requiresHumanJudgment: mapping.requiresHumanJudgment,
    requiresLlmJudgment: mapping.requiresLlmJudgment,
    manualItem: item,
    toolFinding: match?.finding || null,
    mapping
  };
}

function confidenceFromScore(score) {
  if (score >= 75) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function affectedCountScore(manualAffected, toolAffected) {
  const manual = Number(manualAffected || 0);
  const tool = Number(toolAffected || 0);
  if (!manual || !tool) return 0;
  const ratio = Math.min(manual, tool) / Math.max(manual, tool);
  if (ratio >= 0.8) return 10;
  if (ratio >= 0.4) return 6;
  return 2;
}

function priorityAligned(manualPriority, toolPriority) {
  const manual = normalizePriority(manualPriority);
  const tool = normalizePriority(toolPriority);
  return manual && tool && manual === tool;
}

function isAdvisoryNonContradictory(finding = {}) {
  const findingType = finding.normalizedFindingType || finding.findingType || '';
  const priority = finding.effectivePriority || finding.priority || 'Medium';
  const confidence = finding.confidence || 'medium';
  const automationCoverage = finding.automationCoverage || '';
  return ['opportunity', 'best_practice', 'info'].includes(findingType)
    || priority === 'Low'
    || confidence === 'low'
    || Boolean(finding.reviewRecommended)
    || /^requires_/.test(automationCoverage);
}

function searchableText(values) {
  return values.map(text).join(' ').toLowerCase();
}

function textSimilarity(a, b) {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function tokenSet(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3));
}

function normalizeCategoryKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
