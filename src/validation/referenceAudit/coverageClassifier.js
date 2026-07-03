import {
  COVERAGE_STATUSES,
  normalizeCategory,
  normalizePriority,
  normalizeUrls,
  text
} from './referenceAuditModel.js';

const ACTIVE_STATUSES = new Set(['Warning', 'Error']);
const COVERED_SCORE = 72;
const COVERED_IN_SAMPLE_SCORE = 72;

export function classifyManualItemCoverage(item, mapping, toolFindings = [], options = {}) {
  const candidates = candidateMatches(item, mapping, toolFindings, options);
  const best = candidates[0] || null;
  const activeCandidates = candidates.filter((candidate) => isActiveFinding(candidate.finding) && hasUsableMappingSignal(candidate));
  const activeBest = activeCandidates[0] || null;
  const composite = buildCompositeCoverage(item, mapping, activeCandidates, options);
  const selectedActive = chooseCoverageCandidate(activeBest, composite);
  const largerCrawl = needsLargerCrawl(item, mapping, options.run);
  const selected = selectedActive ? decorateDecisionCandidate(selectedActive, item, mapping, largerCrawl) : null;

  if (item.status === 'not_applicable') {
    return manualResult(item, mapping, best, 'not_applicable', 'high', 'Reference item is marked not applicable.');
  }

  if (item.status === 'ok' && best && ['OK', 'NA'].includes(best.finding.status || best.finding.effectiveStatus)) {
    const okBest = decorateDecisionCandidate(best, item, mapping, largerCrawl);
    const coverageStatus = okBest.matchScore >= 55 ? 'covered' : 'partially_covered';
    return manualResult(
      item,
      mapping,
      okBest,
      coverageStatus,
      confidenceFromScore(okBest.matchScore),
      'Manual audit marks this point OK and the related tool check is not active.'
    );
  }

  if (item.status === 'ok' && selected && isAdvisoryNonContradictory(selected.finding)) {
    const coverageStatus = selected.matchScore >= 55 ? 'covered' : 'partially_covered';
    return manualResult(
      item,
      mapping,
      selected,
      coverageStatus,
      confidenceFromScore(selected.matchScore),
      'Manual audit marks this point OK; the related tool finding is advisory/review-oriented and does not contradict the manual OK.'
    );
  }

  if (item.status === 'ok' && selected) {
    return manualResult(
      item,
      mapping,
      selected,
      'false_positive_candidate',
      confidenceFromScore(selected.matchScore),
      'Manual audit marks this point OK, but the current tool run has an active related finding.'
    );
  }

  if (mapping.requiresExternalData && !selected) {
    return manualResult(item, mapping, best, 'needs_external_data', mapping.mappingConfidence, 'Reference item needs data not available in the current run.');
  }
  if (mapping.requiresLlmJudgment && !selected) {
    return manualResult(item, mapping, best, 'needs_llm_review', mapping.mappingConfidence, 'Reference item needs qualitative LLM-assisted review.');
  }
  if (mapping.requiresHumanJudgment && !selected) {
    return manualResult(item, mapping, best, 'needs_human_review', mapping.mappingConfidence, 'Reference item needs human judgment.');
  }

  if (selected) {
    const fullEligible = isFullCoverageEligible(selected, mapping, largerCrawl);
    const sampleEligible = isCoveredInSampleEligible(selected, mapping, largerCrawl);
    const coverageStatus = fullEligible ? 'covered' : sampleEligible ? 'covered_in_sample' : 'partially_covered';
    const partialReason = primaryPartialReason(selected, mapping, largerCrawl, coverageStatus);
    const rationale = rationaleForMatch(selected, mapping, largerCrawl, coverageStatus, partialReason);
    return manualResult(item, mapping, selected, coverageStatus, confidenceFromScore(selected.matchScore), rationale, {
      partialReason: coverageStatus === 'covered' ? null : partialReason,
      coverageDecision: fullEligible ? 'covered_by_strong_evidence' : sampleEligible ? 'covered_in_sample_by_sample_evidence' : 'partial_with_explicit_missing_reasons',
      sampleBased: coverageStatus === 'covered_in_sample' || largerCrawl
    });
  }

  if (largerCrawl && (mapping.expectedCheckIds.length || mapping.possibleCheckIds.length)) {
    return manualResult(
      item,
      mapping,
      best,
      'needs_larger_crawl',
      mapping.mappingConfidence,
      'Reference item is automatable, but the current run is too small/sampled to validate the full-domain manual finding fairly.',
      { partialReason: 'sample_too_small', sampleBased: true }
    );
  }

  if (best && ['OK', 'NA'].includes(best.finding.status || best.finding.effectiveStatus)) {
    const okBest = decorateDecisionCandidate(best, item, mapping, largerCrawl);
    return manualResult(
      item,
      mapping,
      okBest,
      'partially_covered',
      confidenceFromScore(okBest.matchScore),
      'Tool has a related check, but it did not produce an active finding.',
      { partialReason: primaryPartialReason(okBest, mapping, largerCrawl, 'partially_covered') }
    );
  }

  if (mapping.expectedCheckIds.length || mapping.possibleCheckIds.length) {
    return manualResult(
      item,
      mapping,
      null,
      'false_negative_candidate',
      mapping.mappingConfidence,
      'Reference item maps to an automatable check, but no matching tool finding was active.',
      { partialReason: 'evidence_too_weak' }
    );
  }

  return manualResult(item, mapping, null, 'not_covered', 'low', 'No reliable mapping to an existing tool check was found.', {
    partialReason: 'weak_title_match'
  });
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
    .filter((row) => ['covered', 'covered_in_sample', 'partially_covered'].includes(row.coverageStatus))
    .flatMap((row) => [
      ...(row.mapping?.expectedCheckIds || []),
      ...(row.mapping?.possibleCheckIds || []),
      ...(row.matchedCheckIds || [])
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

export function candidateMatches(item, mapping, toolFindings = [], options = {}) {
  const expectedIds = new Set(mapping.expectedCheckIds || []);
  const possibleIds = new Set(mapping.possibleCheckIds || []);
  const allMappedIds = [...expectedIds, ...possibleIds];
  const itemUrls = new Set(normalizeUrls(item.affectedUrls || []));
  const itemTitle = searchableText([item.title]);
  const itemText = searchableText([item.title, item.description, item.recommendation, item.category, Object.values(item.evidence || {}).join(' ')]);
  const itemRecommendation = searchableText([item.recommendation]);
  const sourceType = options.run?.sourceType || 'crawl';
  const mappingSourceTypes = mapping.sourceTypes || ['crawl', 'screaming_frog_import'];
  const runSourceMatches = mappingSourceTypes.includes(sourceType) || (!sourceType && mappingSourceTypes.includes('crawl'));
  const largerCrawl = needsLargerCrawl(item, mapping, options.run);

  return toolFindings
    .map((finding) => {
      const checkId = finding.checkId;
      const sampleUrls = normalizeUrls(parseJson(finding.sampleUrlsJson, finding.sampleUrls || []));
      const urlOverlap = sampleUrls.filter((url) => itemUrls.has(url)).length;
      const categoryMatch = categoryFamilyKey(finding.category) === categoryFamilyKey(mapping.category || item.category);
      const direct = expectedIds.has(checkId);
      const possible = possibleIds.has(checkId);
      const familyMatch = !direct && sharesCheckFamily(checkId, allMappedIds);
      const titleScore = textSimilarity(itemTitle, searchableText([finding.checkName, finding.finding, finding.category]));
      const textScore = textSimilarity(itemText, searchableText([
        finding.checkName,
        finding.finding,
        finding.details,
        finding.recommendation,
        finding.category,
        stringifyEvidence(finding.evidence || parseJson(finding.evidenceJson, {}))
      ]));
      const recommendationScore = textSimilarity(itemRecommendation, searchableText([finding.recommendation, finding.details]));
      const evidenceScore = textSimilarity(searchableText([item.description, Object.values(item.evidence || {}).join(' ')]), searchableText([
        finding.details,
        stringifyEvidence(finding.evidence || parseJson(finding.evidenceJson, {}))
      ]));
      const affectedScore = affectedCountScore(item.affectedCount, finding.affectedCount);
      const toolAffected = Number(finding.affectedCount || 0);
      const affectedCountAvailable = toolAffected > 0;
      const sampleUrlsAvailable = sampleUrls.length > 0;
      const pageTypeOverlap = hasPageTypeOverlap(itemText, finding);
      const templatePatternOverlap = hasTemplatePatternOverlap(itemText, finding);
      const dataSourceMatch = !mapping.requiresExternalData && runSourceMatches;
      const { score, matchReasons } = scoreCandidate({
        direct,
        possible,
        familyMatch,
        categoryMatch,
        urlOverlap,
        affectedScore,
        affectedCountAvailable,
        sampleUrlsAvailable,
        titleScore,
        textScore,
        recommendationScore,
        evidenceScore,
        pageTypeOverlap,
        templatePatternOverlap,
        dataSourceMatch,
        priorityMatch: priorityAligned(item.priority, finding.effectivePriority || finding.priority)
      });
      const missingReasons = missingReasonsForCandidate({
        item,
        mapping,
        finding,
        direct,
        possible,
        familyMatch,
        categoryMatch,
        urlOverlap,
        affectedCountAvailable,
        sampleUrlsAvailable,
        titleScore,
        textScore,
        recommendationScore,
        evidenceScore,
        pageTypeOverlap,
        templatePatternOverlap,
        dataSourceMatch,
        largerCrawl
      });
      return {
        finding,
        matchScore: Math.min(100, score),
        evidenceMatchScore: Math.min(100, score),
        confidence: confidenceFromScore(score),
        urlOverlap,
        reason: humanizeMatchReasons(matchReasons),
        matchReasons,
        missingReasons,
        direct,
        possible,
        familyMatch,
        categoryMatch,
        affectedCountAvailable,
        sampleUrlsAvailable,
        dataSourceMatch,
        titleScore,
        textScore,
        recommendationScore,
        evidenceScore
      };
    })
    .filter((candidate) => candidate.matchScore >= 25)
    .sort((a, b) => {
      const priorityDelta = relevanceRank(b) - relevanceRank(a);
      if (priorityDelta) return priorityDelta;
      return b.matchScore - a.matchScore || Number(b.finding.affectedCount || 0) - Number(a.finding.affectedCount || 0);
    });
}

function scoreCandidate(signals) {
  let score = 0;
  const matchReasons = [];
  if (signals.direct) {
    score += 50;
    matchReasons.push('direct_check_id_match');
  } else if (signals.possible) {
    score += 35;
    matchReasons.push('possible_check_id_match');
  } else if (signals.familyMatch) {
    score += 25;
    matchReasons.push('same_check_family');
  }
  if (signals.urlOverlap) {
    score += Math.min(25, 10 + signals.urlOverlap * 5);
    matchReasons.push('shared_url_sample');
  }
  if (signals.affectedScore) {
    score += signals.affectedScore;
    matchReasons.push('affected_count_aligned');
  } else if (signals.affectedCountAvailable) {
    score += 6;
    matchReasons.push('affected_count_available');
  }
  if (signals.sampleUrlsAvailable) {
    score += 5;
    matchReasons.push('sample_urls_available');
  }
  if (signals.categoryMatch) {
    score += 10;
    matchReasons.push('same_validation_category');
  }
  if (signals.titleScore >= 0.16) {
    score += Math.min(12, Math.round(signals.titleScore * 45));
    matchReasons.push('title_keyword_overlap');
  }
  if (signals.textScore >= 0.18) {
    score += Math.min(12, Math.round(signals.textScore * 40));
    matchReasons.push('evidence_keyword_overlap');
  }
  if (signals.recommendationScore >= 0.12) {
    score += Math.min(8, Math.round(signals.recommendationScore * 35));
    matchReasons.push('recommendation_overlap');
  }
  if (signals.pageTypeOverlap) {
    score += 8;
    matchReasons.push('page_type_overlap');
  }
  if (signals.templatePatternOverlap) {
    score += 10;
    matchReasons.push('template_pattern_overlap');
  }
  if (signals.dataSourceMatch) {
    score += 5;
    matchReasons.push('same_data_source');
  }
  if (signals.priorityMatch) {
    score += 4;
    matchReasons.push('priority_aligned');
  }
  return { score, matchReasons: unique(matchReasons) };
}

function missingReasonsForCandidate(signals) {
  const missingReasons = [];
  if (!signals.direct && !signals.possible && !signals.familyMatch) missingReasons.push('weak_title_match');
  if (!signals.categoryMatch) missingReasons.push('weak_category_match');
  if (normalizeUrls(signals.item.affectedUrls || []).length && !signals.urlOverlap) missingReasons.push('missing_url_overlap');
  if (!signals.affectedCountAvailable) missingReasons.push('missing_affected_count');
  if (!signals.sampleUrlsAvailable) missingReasons.push('evidence_too_weak');
  if (signals.mapping.requiresExternalData || !signals.dataSourceMatch) missingReasons.push('missing_data_source');
  if (signals.mapping.requiresHumanJudgment) missingReasons.push('human_review_needed');
  if (signals.mapping.requiresLlmJudgment) missingReasons.push('human_review_needed');
  if (signals.largerCrawl) missingReasons.push('sample_too_small');
  if (signals.titleScore < 0.08 && signals.textScore < 0.12) missingReasons.push('weak_title_match');
  if (signals.recommendationScore < 0.08) missingReasons.push('recommendation_too_generic');
  if (mentionsTemplate(signals.item) && !signals.templatePatternOverlap) missingReasons.push('missing_template_context');
  if (mentionsPageType(signals.item) && !signals.pageTypeOverlap) missingReasons.push('missing_page_type_context');
  if (!signals.direct && !signals.possible && signals.familyMatch) missingReasons.push('tool_finding_too_granular');
  return unique(missingReasons);
}

function buildCompositeCoverage(item, mapping, activeCandidates = [], options = {}) {
  const related = activeCandidates
    .filter((candidate) => candidate.direct || candidate.possible || candidate.familyMatch || candidate.categoryMatch)
    .slice(0, 8);
  if (related.length < 2) return null;

  const primary = related[0];
  const distinctChecks = unique(related.map((candidate) => candidate.finding.checkId));
  const distinctFamilies = unique(related.map((candidate) => checkFamilyKey(candidate.finding.checkId)).filter(Boolean));
  const sampleUrls = unique(related.flatMap((candidate) => normalizeUrls(parseJson(candidate.finding.sampleUrlsJson, candidate.finding.sampleUrls || []))));
  const affectedTotal = related.reduce((sum, candidate) => sum + Number(candidate.finding.affectedCount || 0), 0);
  const matchReasons = unique([
    ...related.flatMap((candidate) => candidate.matchReasons || []),
    'composite_check_family_bundle',
    distinctChecks.length >= 2 ? 'multiple_related_findings' : null,
    distinctFamilies.length >= 2 ? 'multiple_check_families' : null,
    sampleUrls.length ? 'sample_urls_available' : null,
    affectedTotal > 0 ? 'affected_count_available' : null
  ].filter(Boolean));
  const missingReasons = unique(related.flatMap((candidate) => candidate.missingReasons || []));
  const scoreBoost = Math.min(22, Math.max(0, distinctChecks.length - 1) * 5 + Math.max(0, distinctFamilies.length - 1) * 4);
  const score = Math.min(100, Math.max(...related.map((candidate) => candidate.matchScore)) + scoreBoost);
  return {
    ...primary,
    matchScore: score,
    evidenceMatchScore: score,
    confidence: confidenceFromScore(score),
    reason: humanizeMatchReasons(matchReasons),
    matchReasons,
    missingReasons,
    matchedToolFindings: related.map((candidate) => candidate.finding),
    matchedCheckIds: distinctChecks,
    urlOverlap: related.reduce((sum, candidate) => sum + Number(candidate.urlOverlap || 0), 0),
    affectedCountAvailable: affectedTotal > 0,
    sampleUrlsAvailable: sampleUrls.length > 0 || related.some((candidate) => candidate.sampleUrlsAvailable),
    compositeCoverage: {
      enabled: true,
      relatedFindingCount: related.length,
      matchedCheckIds: distinctChecks,
      matchedFamilies: distinctFamilies,
      affectedCountInMatchedFindings: affectedTotal,
      sampleUrlCount: sampleUrls.length,
      sourceType: options.run?.sourceType || 'crawl'
    }
  };
}

function chooseCoverageCandidate(activeBest, composite) {
  if (!activeBest) return composite || null;
  if (!composite) return activeBest;
  return composite.matchScore >= activeBest.matchScore ? composite : activeBest;
}

function decorateDecisionCandidate(candidate, item, mapping, largerCrawl) {
  if (!candidate) return null;
  const missingReasons = unique([
    ...(candidate.missingReasons || []),
    ...(largerCrawl ? ['sample_too_small'] : []),
    ...(mapping.requiresExternalData ? ['missing_data_source'] : []),
    ...(mapping.requiresHumanJudgment || mapping.requiresLlmJudgment ? ['human_review_needed'] : [])
  ]);
  const decorated = {
    ...candidate,
    missingReasons,
    upgradeEligible: isUpgradeEligible(candidate, mapping, largerCrawl),
    sampleUpgradeEligible: isSampleUpgradeEligible(candidate, mapping, largerCrawl),
    partialReason: primaryPartialReason({ ...candidate, missingReasons }, mapping, largerCrawl, 'partially_covered')
  };
  decorated.reason = humanizeMatchReasons(decorated.matchReasons || []);
  return decorated;
}

function isFullCoverageEligible(candidate, mapping, largerCrawl) {
  return isUpgradeEligible(candidate, mapping, largerCrawl);
}

function isCoveredInSampleEligible(candidate, mapping, largerCrawl) {
  return isSampleUpgradeEligible(candidate, mapping, largerCrawl);
}

function isUpgradeEligible(candidate, mapping, largerCrawl) {
  if (!candidate || !isActiveFinding(candidate.finding)) return false;
  if (candidate.matchScore < COVERED_SCORE) return false;
  if (largerCrawl || mapping.requiresExternalData || mapping.requiresHumanJudgment || mapping.requiresLlmJudgment) return false;
  return hasStrongMapping(candidate) && hasStrongEvidence(candidate);
}

function isSampleUpgradeEligible(candidate, mapping, largerCrawl) {
  if (!candidate || !isActiveFinding(candidate.finding)) return false;
  if (!largerCrawl || candidate.matchScore < COVERED_IN_SAMPLE_SCORE) return false;
  if (mapping.requiresExternalData || mapping.requiresHumanJudgment || mapping.requiresLlmJudgment) return false;
  return hasStrongMapping(candidate) && hasStrongEvidence(candidate);
}

function hasStrongMapping(candidate) {
  const reasons = new Set(candidate.matchReasons || []);
  return reasons.has('direct_check_id_match')
    || reasons.has('possible_check_id_match')
    || reasons.has('same_check_family')
    || reasons.has('composite_check_family_bundle');
}

function hasUsableMappingSignal(candidate) {
  return Boolean(candidate.direct || candidate.possible || candidate.familyMatch)
    || (candidate.categoryMatch && candidate.titleScore >= 0.16 && candidate.textScore >= 0.18);
}

function hasStrongEvidence(candidate) {
  const reasons = new Set(candidate.matchReasons || []);
  return reasons.has('shared_url_sample')
    || reasons.has('affected_count_aligned')
    || reasons.has('affected_count_available')
    || reasons.has('sample_urls_available')
    || reasons.has('page_type_overlap')
    || reasons.has('template_pattern_overlap')
    || reasons.has('multiple_related_findings');
}

function primaryPartialReason(candidate, mapping, largerCrawl, coverageStatus) {
  if (coverageStatus === 'covered_in_sample' || largerCrawl) return 'sample_too_small';
  if (mapping.requiresExternalData || candidate?.missingReasons?.includes('missing_data_source')) return 'missing_data_source';
  if (mapping.requiresHumanJudgment || mapping.requiresLlmJudgment || candidate?.missingReasons?.includes('human_review_needed')) return 'human_review_needed';
  const missingReasons = candidate?.missingReasons || [];
  if (missingReasons.includes('missing_url_overlap')) return 'missing_url_overlap';
  if (missingReasons.includes('missing_affected_count')) return 'missing_affected_count';
  if (missingReasons.includes('missing_template_context')) return 'missing_template_context';
  if (missingReasons.includes('missing_page_type_context')) return 'missing_page_type_context';
  if (missingReasons.includes('evidence_too_weak')) return 'evidence_too_weak';
  if (missingReasons.includes('recommendation_too_generic')) return 'recommendation_too_generic';
  if (candidate?.matchReasons?.includes('composite_check_family_bundle')) return 'tool_finding_too_granular';
  if (candidate?.matchScore >= 65 && candidate?.matchReasons?.includes('direct_check_id_match')) return 'already_covered_but_mapping_too_strict';
  if (candidate?.matchReasons?.includes('same_check_family')) return 'tool_finding_too_granular';
  if (missingReasons.includes('weak_category_match')) return 'weak_category_match';
  if (missingReasons.includes('weak_title_match')) return 'weak_title_match';
  return 'check_too_generic';
}

function rationaleForMatch(candidate, mapping, largerCrawl, coverageStatus, partialReason) {
  const base = candidate.reason || 'related evidence matched';
  if (coverageStatus === 'covered') {
    return `${base}. Match score is high enough for full coverage with current data.`;
  }
  if (coverageStatus === 'covered_in_sample') {
    return `${base}. Tool evidence covers the point inside the current sample; full-domain reach still needs a larger crawl or import.`;
  }
  if (mapping.requiresExternalData) {
    return `${base}. Technical signals exist, but the reference item also needs external data (${(mapping.requiredData || []).join(', ') || 'external data'}).`;
  }
  if (mapping.requiresHumanJudgment || mapping.requiresLlmJudgment) {
    return `${base}. Technical signals exist, but the reference item needs human/qualitative review.`;
  }
  if (largerCrawl) {
    return `${base}. Current run is a small sample for this large-domain reference item.`;
  }
  if (partialReason === 'already_covered_but_mapping_too_strict') {
    return `${base}. Evidence is relevant, but at least one matching dimension is still too weak for automatic full coverage.`;
  }
  return base;
}

function manualResult(item, mapping, match, coverageStatus, confidence, rationale, extras = {}) {
  if (!COVERAGE_STATUSES.includes(coverageStatus)) throw new Error(`Invalid coverage status ${coverageStatus}`);
  const matchedToolFindings = match?.matchedToolFindings || (match?.finding ? [match.finding] : []);
  const matchedCheckIds = match?.matchedCheckIds || unique(matchedToolFindings.map((finding) => finding.checkId).filter(Boolean));
  return {
    manualItemId: item.id,
    coverageStatus,
    confidence,
    rationale,
    matchedToolFindingId: match?.finding?.id || null,
    matchedCheckId: match?.finding?.checkId || null,
    matchedToolFindingIds: matchedToolFindings.map((finding) => finding.id).filter((id) => id !== null && id !== undefined),
    matchedCheckIds,
    matchScore: match?.matchScore || 0,
    evidenceMatchScore: match?.evidenceMatchScore || match?.matchScore || 0,
    urlOverlap: match?.urlOverlap || 0,
    matchReasons: match?.matchReasons || [],
    missingReasons: coverageStatus === 'covered' ? [] : unique([
      ...(match?.missingReasons || []),
      ...(extras.partialReason && !['already_covered_but_mapping_too_strict', 'check_too_generic'].includes(extras.partialReason) ? [extras.partialReason] : [])
    ]),
    partialReason: coverageStatus === 'covered' ? null : extras.partialReason || match?.partialReason || null,
    coverageDecision: extras.coverageDecision || null,
    upgradeEligible: Boolean(match?.upgradeEligible),
    sampleUpgradeEligible: Boolean(match?.sampleUpgradeEligible),
    sampleBased: Boolean(extras.sampleBased),
    affectedInSample: Number(match?.finding?.affectedCount || 0),
    compositeCoverage: match?.compositeCoverage || null,
    expectedCheckIds: mapping.expectedCheckIds,
    requiredData: mapping.requiredData,
    requiresExternalData: mapping.requiresExternalData,
    requiresHumanJudgment: mapping.requiresHumanJudgment,
    requiresLlmJudgment: mapping.requiresLlmJudgment,
    manualItem: item,
    toolFinding: match?.finding || null,
    matchedToolFindings,
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

function isActiveFinding(finding = {}) {
  return ACTIVE_STATUSES.has(finding.status || finding.effectiveStatus);
}

function relevanceRank(candidate) {
  return (candidate.direct ? 100 : 0)
    + (candidate.possible ? 70 : 0)
    + (candidate.familyMatch ? 45 : 0)
    + (candidate.categoryMatch ? 10 : 0)
    + Math.min(10, candidate.titleScore * 20)
    + Math.min(10, candidate.textScore * 20);
}

function humanizeMatchReasons(reasons = []) {
  const labels = {
    direct_check_id_match: 'checkId mapped',
    possible_check_id_match: 'possible/pattern check matched',
    same_check_family: 'same check family matched',
    composite_check_family_bundle: 'multiple related checks matched',
    multiple_related_findings: 'multiple related findings',
    multiple_check_families: 'multiple check families',
    same_validation_category: 'category aligned',
    shared_url_sample: 'URL sample overlap',
    affected_count_aligned: 'affected count aligned',
    affected_count_available: 'affected count available',
    sample_urls_available: 'sample URLs available',
    same_data_source: 'data source aligned',
    recommendation_overlap: 'recommendation overlap',
    evidence_keyword_overlap: 'evidence text overlap',
    title_keyword_overlap: 'title/check text overlap',
    page_type_overlap: 'page type overlap',
    template_pattern_overlap: 'template pattern overlap',
    priority_aligned: 'priority aligned'
  };
  return unique(reasons).map((reason) => labels[reason] || reason).join(', ') || 'weak candidate';
}

function categoryFamilyKey(value) {
  return normalizeCategory(value || '').replace(/[^a-z0-9]+/g, '-');
}

function checkFamilyKey(checkId = '') {
  const id = String(checkId || '').toLowerCase();
  if (!id) return '';
  if (/title/.test(id)) return 'title';
  if (/meta_description|meta_pattern/.test(id)) return 'meta-description';
  if (/\bh1\b|multiple_h1/.test(id)) return 'h1';
  if (/canonical/.test(id)) return 'canonical';
  if (/noindex|robots_txt|sitemap|crawl_bloat|orphan|pagination/.test(id)) return 'crawl-indexability';
  if (/schema|json_ld|breadcrumb|product_coverage|article_coverage/.test(id)) return 'structured-data';
  if (/cache|cdn|ttfb|compression/.test(id)) return 'cache-performance';
  if (/lighthouse|lcp|tbt|css|js|script|preload|preconnect|resource_hint|resource_performance/.test(id)) return 'resource-performance';
  if (/image|alt|lazy/.test(id)) return 'image-media';
  if (/hsts|csp|x_frame|x_content|referrer|permissions|https|www/.test(id)) return 'security-headers';
  if (/open_graph|og_/.test(id)) return 'open-graph';
  if (/webmanifest|favicon|app_icons/.test(id)) return 'app-icons';
  if (/consent|tagmanager|gtm|datalayer/.test(id)) return 'consent';
  if (/critical_content|raw_|rendered|js_required/.test(id)) return 'javascript-rendering';
  if (/html_semantics|http_version/.test(id)) return 'html-semantics';
  if (/llms|markdown_twin/.test(id)) return 'llms';
  if (/ai_bots|robots_mentions|gptbot|claude|perplexity|applebot|bytespider/.test(id)) return 'ai-bots';
  if (/ymyl|eeat|impressum|datenschutz|about|contact|author|source/.test(id)) return 'trust-entity';
  return id.split('.').slice(0, 2).join('.');
}

function sharesCheckFamily(checkId, mappedIds = []) {
  const family = checkFamilyKey(checkId);
  return Boolean(family && mappedIds.some((mappedId) => checkFamilyKey(mappedId) === family));
}

function hasPageTypeOverlap(itemText, finding = {}) {
  const evidence = stringifyEvidence(finding.evidence || parseJson(finding.evidenceJson, {}));
  const checkText = searchableText([finding.checkName, finding.finding, finding.details, evidence, finding.checkId]);
  const pageTypeTokens = ['pdp', 'product', 'produkt', 'plp', 'category', 'kategorie', 'article', 'artikel', 'blog', 'magazine', 'facette', 'facet', 'filter'];
  return pageTypeTokens.some((token) => itemText.includes(token) && checkText.includes(token));
}

function hasTemplatePatternOverlap(itemText, finding = {}) {
  const checkText = searchableText([finding.checkId, finding.checkName, finding.finding, finding.details, stringifyEvidence(finding.evidence || parseJson(finding.evidenceJson, {}))]);
  return /template|pattern|pdp|plp|category|kategorie|article|artikel|schema|canonical|title|meta|h1/.test(itemText)
    && /template|pattern|pdp|plp|category|article|schema|canonical|title|meta|h1/.test(checkText);
}

function mentionsTemplate(item = {}) {
  return /template|pattern|pdp|plp|category|kategorie|systematic|systematisch/.test(searchableText([
    item.title,
    item.description,
    item.recommendation,
    item.notes
  ]));
}

function mentionsPageType(item = {}) {
  return /pdp|product|produkt|plp|category|kategorie|article|artikel|blog|magazine/.test(searchableText([
    item.title,
    item.description,
    item.recommendation,
    item.notes
  ]));
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

function stringifyEvidence(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== ''))];
}
