export const PARTIAL_REASON_TYPES = Object.freeze([
  'weak_title_match',
  'weak_category_match',
  'missing_url_overlap',
  'missing_affected_count',
  'missing_template_context',
  'missing_page_type_context',
  'missing_data_source',
  'sample_too_small',
  'check_too_generic',
  'recommendation_too_generic',
  'evidence_too_weak',
  'human_review_needed',
  'already_covered_but_mapping_too_strict',
  'manual_item_too_broad',
  'tool_finding_too_granular',
  'tool_finding_duplicate_family'
]);

const DIAGNOSTIC_STATUSES = new Set([
  'covered_in_sample',
  'partially_covered',
  'needs_external_data',
  'needs_larger_crawl',
  'needs_human_review',
  'needs_llm_review',
  'false_negative_candidate',
  'false_positive_candidate'
]);

export function buildPartialCoverageDiagnostics(coverageMatrix = []) {
  const items = coverageMatrix
    .filter((row) => shouldDiagnose(row))
    .map((row) => diagnosticRow(row));
  return {
    generatedAt: new Date().toISOString(),
    analyzedItems: items.length,
    currentPartiallyCovered: coverageMatrix.filter((row) => row.coverageStatus === 'partially_covered').length,
    coveredInSample: coverageMatrix.filter((row) => row.coverageStatus === 'covered_in_sample').length,
    upgradeEligible: coverageMatrix.filter((row) => row.upgradeEligible).length,
    byReason: countBy(items, (item) => item.partialReason || item.missingReason || 'unknown'),
    byUpgradePath: countBy(items, (item) => item.possibleUpgradePath || 'unknown'),
    items
  };
}

export function renderPartialCoverageDiagnosticsMarkdown(diagnostics = {}) {
  const items = diagnostics.items || [];
  const lines = [
    '# Partial Coverage Diagnostics',
    '',
    `- Analyzed items: ${diagnostics.analyzedItems || 0}`,
    `- Current partially covered: ${diagnostics.currentPartiallyCovered || 0}`,
    `- Covered in sample: ${diagnostics.coveredInSample || 0}`,
    `- Upgrade eligible: ${diagnostics.upgradeEligible || 0}`,
    '',
    '## Partial Reason Classification',
    '',
    ...Object.entries(diagnostics.byReason || {}).map(([reason, count]) => `- ${reason}: ${count}`),
    '',
    '## Diagnostics',
    '',
    '| Manual Item | Status | Confidence | Reason | Missing | Matched Checks | Upgrade Path | Suggested Change |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  if (!items.length) lines.push('| None |  |  |  |  |  |  |  |');
  for (const item of items) {
    lines.push(`| ${md(item.manualTitle)} | ${md(item.currentCoverageStatus)} | ${md(item.currentConfidence)} | ${md(item.partialReason || item.missingReason)} | ${md((item.missingReasons || []).join(', '))} | ${md((item.matchedCheckIds || []).join(', '))} | ${md(item.possibleUpgradePath)} | ${md(item.suggestedChange)} |`);
  }
  return `${lines.join('\n')}\n`;
}

function shouldDiagnose(row = {}) {
  return DIAGNOSTIC_STATUSES.has(row.coverageStatus)
    || Boolean(row.partialReason)
    || row.coverageDecision === 'covered_in_sample_by_sample_evidence'
    || row.coverageDecision === 'partial_with_explicit_missing_reasons';
}

function diagnosticRow(row = {}) {
  const manualItem = row.manualItem || {};
  const missingReasons = normalizeMissingReasons(row);
  const partialReason = normalizePartialReason(row.partialReason || missingReasons[0] || inferPartialReason(row));
  const matchedToolFindings = compactMatchedFindings(row);
  const needsLargerCrawl = row.coverageStatus === 'needs_larger_crawl'
    || row.coverageStatus === 'covered_in_sample'
    || missingReasons.includes('sample_too_small');
  const needsHumanReview = row.coverageStatus === 'needs_human_review'
    || missingReasons.includes('human_review_needed')
    || Boolean(row.requiresHumanJudgment || row.requiresLlmJudgment);
  const needsExternalData = row.coverageStatus === 'needs_external_data'
    || missingReasons.includes('missing_data_source')
    || Boolean(row.requiresExternalData);
  const canBeCoveredWithCurrentData = Boolean(row.upgradeEligible || row.coverageStatus === 'covered')
    && !needsLargerCrawl
    && !needsHumanReview
    && !needsExternalData;

  return {
    manualItemId: row.manualItemId,
    manualTitle: manualItem.title || row.manualItemId,
    manualCategory: manualItem.category || row.mapping?.category || 'uncategorized',
    manualPriority: manualItem.priority || 'unknown',
    currentCoverageStatus: row.coverageStatus,
    currentConfidence: row.confidence || 'unknown',
    matchedToolFindings,
    matchedCheckIds: row.matchedCheckIds?.length ? row.matchedCheckIds : [row.matchedCheckId].filter(Boolean),
    matchScore: row.matchScore || 0,
    evidenceMatchScore: row.evidenceMatchScore || row.matchScore || 0,
    matchReasons: row.matchReasons || [],
    missingReasons,
    missingReason: partialReason,
    partialReason,
    possibleUpgradePath: upgradePathFor(row, partialReason, {
      needsLargerCrawl,
      needsHumanReview,
      needsExternalData,
      canBeCoveredWithCurrentData
    }),
    requiredData: row.requiredData || row.mapping?.requiredData || [],
    canBeCoveredWithCurrentData,
    needsLargerCrawl,
    needsHumanReview,
    needsExternalData,
    needsBetterMapping: ['weak_title_match', 'weak_category_match', 'already_covered_but_mapping_too_strict', 'tool_finding_too_granular', 'tool_finding_duplicate_family'].includes(partialReason),
    needsBetterEvidence: ['missing_url_overlap', 'missing_template_context', 'missing_page_type_context', 'evidence_too_weak'].includes(partialReason),
    needsBetterAffectedCount: missingReasons.includes('missing_affected_count') || partialReason === 'missing_affected_count',
    needsBetterRecommendation: missingReasons.includes('recommendation_too_generic') || partialReason === 'recommendation_too_generic',
    suggestedChange: suggestedChangeFor(row, partialReason, {
      needsLargerCrawl,
      needsHumanReview,
      needsExternalData,
      canBeCoveredWithCurrentData
    })
  };
}

function compactMatchedFindings(row = {}) {
  const findings = row.matchedToolFindings?.length
    ? row.matchedToolFindings
    : row.toolFinding ? [row.toolFinding] : [];
  return findings.map((finding) => ({
    id: finding.id,
    checkId: finding.checkId,
    title: finding.checkName || finding.title || finding.checkId,
    status: finding.status || finding.effectiveStatus,
    priority: finding.priority || finding.effectivePriority,
    affectedCount: Number(finding.affectedCount || 0),
    sampleUrls: finding.sampleUrls || []
  }));
}

function normalizeMissingReasons(row = {}) {
  const reasons = [...(row.missingReasons || [])];
  if (row.coverageStatus === 'covered_in_sample') reasons.push('sample_too_small');
  if (row.requiresExternalData) reasons.push('missing_data_source');
  if (row.requiresHumanJudgment || row.requiresLlmJudgment) reasons.push('human_review_needed');
  return unique(reasons.map(normalizePartialReason));
}

function inferPartialReason(row = {}) {
  if (row.coverageStatus === 'covered_in_sample' || row.sampleBased) return 'sample_too_small';
  if (row.requiresExternalData) return 'missing_data_source';
  if (row.requiresHumanJudgment || row.requiresLlmJudgment) return 'human_review_needed';
  if ((row.matchReasons || []).includes('composite_check_family_bundle')) return 'tool_finding_too_granular';
  if ((row.matchScore || 0) >= 65) return 'already_covered_but_mapping_too_strict';
  if (!row.matchedCheckId && !(row.matchedCheckIds || []).length) return 'weak_title_match';
  return 'evidence_too_weak';
}

function normalizePartialReason(reason) {
  const normalized = String(reason || 'check_too_generic').trim().toLowerCase();
  return PARTIAL_REASON_TYPES.includes(normalized) ? normalized : 'check_too_generic';
}

function upgradePathFor(row, reason, state) {
  if (row.coverageStatus === 'covered_in_sample') return 'validate_full_domain_reach';
  if (state.canBeCoveredWithCurrentData) return 'upgradeable_with_current_evidence';
  if (state.needsLargerCrawl || reason === 'sample_too_small') return 'run_full_crawl_or_screaming_frog_import';
  if (state.needsExternalData || reason === 'missing_data_source') return 'import_required_external_dataset';
  if (state.needsHumanReview || reason === 'human_review_needed') return 'route_to_human_or_llm_review';
  if (['weak_title_match', 'weak_category_match', 'already_covered_but_mapping_too_strict'].includes(reason)) return 'improve_mapping_confidence';
  if (['missing_url_overlap', 'missing_template_context', 'missing_page_type_context', 'evidence_too_weak'].includes(reason)) return 'improve_evidence_capture';
  if (reason === 'missing_affected_count') return 'store_or_export_affected_counts';
  return 'refine_check_recommendation_or_grouping';
}

function suggestedChangeFor(row, reason, state) {
  if (row.coverageStatus === 'covered_in_sample') {
    return 'Keep sample coverage explicit and validate affected reach with a larger crawl or Screaming-Frog import before claiming full-domain coverage.';
  }
  if (state.canBeCoveredWithCurrentData) {
    return 'Allow this item to move to covered when direct/composite match, evidence and data basis remain strong.';
  }
  if (state.needsLargerCrawl || reason === 'sample_too_small') {
    return 'Use the current finding as sample evidence, but require a full crawl or import for domain-wide affected counts and template reach.';
  }
  if (state.needsExternalData || reason === 'missing_data_source') {
    return `Import the required data source(s): ${(row.requiredData || []).join(', ') || 'external data'}.`;
  }
  if (state.needsHumanReview || reason === 'human_review_needed') {
    return 'Keep the technical signal, but add a review checklist before presenting the item as fully covered.';
  }
  if (reason === 'missing_affected_count') {
    return 'Populate affectedCount and sample URLs consistently in the check output and coverage matrix.';
  }
  if (reason === 'missing_template_context' || reason === 'missing_page_type_context') {
    return 'Attach pageType, templateId or URL-pattern evidence to the matched finding.';
  }
  if (reason === 'tool_finding_too_granular') {
    return 'Keep the composite coverage bundle and show grouped check families instead of a single granular check.';
  }
  return 'Improve mapping/evidence specificity before upgrading this partial item.';
}

function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
