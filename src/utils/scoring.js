import crypto from 'node:crypto';

export const SCORING_VERSION = 'root-cause-scoring-v3';
export const DEDUPLICATION_VERSION = 'deterministic-root-cause-v1';
export const COVERAGE_MODEL_VERSION = 'weighted-coverage-v2';
export const CHECK_LOGIC_VERSION = 'csr-render-provenance-v1';

export const scoringConfig = Object.freeze({
  severityPenalties: Object.freeze({ critical: 30, high: 14, medium: 5, low: 1 }),
  confidenceFactors: Object.freeze({ high: 1, medium: 0.7, low: 0 }),
  scope: Object.freeze({
    logarithmicStep: 0.25,
    countFactorCap: 1.75,
    totalFactorCap: 2,
    typeMultipliers: Object.freeze({
      url: 1,
      template: 1.15,
      sitewide: 1.25,
      resource: 1,
      external: 0.75,
      service: 1.15,
      unknown: 1
    })
  }),
  optionalLowPenaltyCap: 5,
  categoryPenaltyCaps: Object.freeze({
    technical_seo: 35,
    crawling_indexing: 30,
    html_meta: 25,
    structured_data: 20,
    performance: 20,
    media: 15,
    content: 15,
    geo: 12,
    accessibility: 15,
    security: 15,
    other: 15
  }),
  categoryPenaltyFactors: Object.freeze({
    technical_seo: 1,
    crawling_indexing: 1,
    html_meta: 0.9,
    structured_data: 0.9,
    performance: 0.9,
    media: 0.8,
    content: 0.8,
    geo: 0.7,
    accessibility: 0.8,
    security: 0.8,
    other: 0.8
  }),
  coverageThresholds: Object.freeze({ final: 80, provisional: 60 })
});

const EVALUATED_STATES = new Set(['pass', 'fail']);
const SCORE_FREE_STATES = new Set(['not_applicable', 'insufficient_evidence', 'not_executed', 'technical_error']);
const SEVERITY_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, critical: 4 });
const FINDING_TYPE_RANK = Object.freeze({ core_issue: 0, best_practice: 1, opportunity: 2, llm_assisted: 3, info: 4 });

export function scoringVersions() {
  return {
    scoringVersion: SCORING_VERSION,
    deduplicationVersion: DEDUPLICATION_VERSION,
    coverageModelVersion: COVERAGE_MODEL_VERSION,
    checkLogicVersion: CHECK_LOGIC_VERSION
  };
}

// Kept for persisted per-check display compatibility. The calibrated aggregate
// score below does not use these values as severity penalties.
export function scoreForStatus(status) {
  if (status === 'OK') return 10;
  if (status === 'Warning') return 5;
  if (status === 'Error') return 1;
  return null;
}

export function computeScores(results = [], options = {}) {
  if (options.legacy === true) return computeLegacyScores(results);
  const prepared = results.map(prepareRow);
  const overall = calculateModel(prepared, () => true);
  const tech = calculateModel(prepared, (row) => row.auditType === 'tech');
  const geo = calculateModel(prepared, (row) => row.auditType === 'geo');

  return {
    scoringVersion: SCORING_VERSION,
    deduplicationVersion: DEDUPLICATION_VERSION,
    coverageModelVersion: COVERAGE_MODEL_VERSION,
    checkLogicVersion: CHECK_LOGIC_VERSION,
    scoreStatus: overall.scoreStatus,
    weightedCoverage: overall.weightedCoverage,
    overallScore: overall.score,
    diagnosticOverallScore: overall.diagnosticScore,
    techScore: tech.score,
    diagnosticTechScore: tech.diagnosticScore,
    techScoreStatus: tech.scoreStatus,
    geoScore: geo.score,
    diagnosticGeoScore: geo.diagnosticScore,
    geoScoreStatus: geo.scoreStatus,
    breakdown: overall.breakdown
  };
}

export function scopeFactorForCount(count, scopeType = 'url') {
  const safeCount = Math.max(1, Number(count || 1));
  const countFactor = Math.min(
    scoringConfig.scope.countFactorCap,
    1 + Math.log10(safeCount) * scoringConfig.scope.logarithmicStep
  );
  const type = normalizeScopeType(scopeType);
  const typeMultiplier = scoringConfig.scope.typeMultipliers[type] || scoringConfig.scope.typeMultipliers.unknown;
  return round(Math.min(scoringConfig.scope.totalFactorCap, countFactor * typeMultiplier), 4);
}

export function rootCauseIdForKey(key) {
  return `rc_${crypto.createHash('sha256').update(String(key || 'unknown')).digest('hex').slice(0, 16)}`;
}

function calculateModel(allRows, predicate) {
  const rows = allRows.filter(predicate);
  const coverage = calculateCoverage(rows);
  const rootCauses = buildRootCauses(rows);
  const capped = applyCaps(rootCauses);
  const diagnosticScore = clamp(Math.round(100 - capped.appliedPenalty), 0, 100);
  const scoreStatus = coverageStatus(coverage.weightedCoverage);
  const score = scoreStatus === 'insufficient_coverage' ? null : diagnosticScore;
  const failingRows = rows.filter((row) => row.evaluationState === 'fail');
  const scoredFindingIds = new Set(capped.rootCauses.flatMap((root) => root.memberFindingIds));
  const deduplicatedFindingCount = capped.rootCauses.reduce(
    (sum, root) => sum + Math.max(0, root.memberFindingIds.length - 1),
    0
  );
  const categoryScores = categoryBreakdown(rows, capped.rootCauses, coverage.categories);
  const excludedResults = exclusionBreakdown(rows);

  return {
    score,
    diagnosticScore,
    scoreStatus,
    weightedCoverage: coverage.weightedCoverage,
    breakdown: {
      scoringVersion: SCORING_VERSION,
      deduplicationVersion: DEDUPLICATION_VERSION,
      coverageModelVersion: COVERAGE_MODEL_VERSION,
      checkLogicVersion: CHECK_LOGIC_VERSION,
      scoreStatus,
      score,
      diagnosticScore,
      rawFindingCount: rows.length,
      rawFailingFindingCount: failingRows.length,
      scoredFindingCount: scoredFindingIds.size,
      rootCauseCount: capped.rootCauses.length,
      deduplicatedFindingCount,
      weightedCoverage: coverage.weightedCoverage,
      eligibleWeight: coverage.eligibleWeight,
      evaluatedWeight: coverage.evaluatedWeight,
      excludedWeight: coverage.excludedWeight,
      notApplicableWeight: coverage.notApplicableWeight,
      coverageThresholds: scoringConfig.coverageThresholds,
      scopeFormula: {
        expression: 'min(total_cap, (1 + logarithmic_step * log10(max(1, affected_url_count))) * scope_type_multiplier)',
        logarithmicStep: scoringConfig.scope.logarithmicStep,
        countFactorCap: scoringConfig.scope.countFactorCap,
        totalFactorCap: scoringConfig.scope.totalFactorCap,
        typeMultipliers: scoringConfig.scope.typeMultipliers
      },
      severityPenalties: scoringConfig.severityPenalties,
      confidenceFactors: scoringConfig.confidenceFactors,
      rawPenalty: capped.rawPenalty,
      appliedPenalty: capped.appliedPenalty,
      capsApplied: capped.capsApplied,
      categoryScores,
      excludedResults,
      rootCauses: capped.rootCauses,
      // Compatibility aliases used by older report consumers.
      scoringModel: SCORING_VERSION,
      configuredChecks: rows.length,
      eligibleChecks: scoredFindingIds.size,
      excludedChecks: rows.filter((row) => !row.reliablyEvaluated).length,
      deduplicatedChecks: deduplicatedFindingCount,
      dataCoveragePct: coverage.weightedCoverage,
      maximumScoreAtAvailableCoverage: coverage.weightedCoverage,
      normalizedMaximumScore: scoreStatus === 'insufficient_coverage' ? null : 100,
      configuredWeight: coverage.configuredWeight,
      categories: categoryScores,
      deductions: capped.rootCauses.map(rootAsDeduction),
      excluded: excludedResults.rows,
      deduplicated: capped.rootCauses.flatMap((root) => root.memberFindingIds.slice(1).map((findingId) => ({
        findingId,
        rootCauseId: root.rootCauseId,
        rootCauseKey: root.rootCauseKey,
        representedBy: root.primaryCheckId
      })))
    }
  };
}

function prepareRow(row = {}, index) {
  const checkId = row.checkId || row.id || `check-${index}`;
  const evaluationState = row.evaluationState || (row.status === 'OK'
    ? 'pass'
    : ['Warning', 'Error'].includes(row.status) ? 'fail' : 'insufficient_evidence');
  const scoreEligible = row.scoreEligible === undefined || row.scoreEligible === null
    ? EVALUATED_STATES.has(evaluationState)
    : Boolean(row.scoreEligible);
  const confidence = normalizeConfidence(row.confidence || objectValue(row.assessment, row.assessmentJson)?.confidence);
  const severity = normalizeSeverity(
    row.severity || objectValue(row.assessment, row.assessmentJson)?.severity,
    row.status,
    row.priority
  );
  const findingType = row.findingType || row.normalizedFindingType || 'core_issue';
  const categoryKey = categoryKeyFor(row.category, checkId, row.auditType);
  const categoryFactor = scoringConfig.categoryPenaltyFactors[categoryKey] || scoringConfig.categoryPenaltyFactors.other;
  // Coverage measures whether the configured evidence was actually available.
  // Category penalty factors calibrate risk, but must not make a missing
  // category appear better covered merely because its findings carry a lower
  // score penalty.
  const coverageWeight = round(baseCoverageWeight(row.priority, findingType), 4);
  const coverageEvaluated = EVALUATED_STATES.has(evaluationState) && confidence !== 'low';
  const reliablyEvaluated = scoreEligible && coverageEvaluated;
  const evidence = objectValue(row.evidence, row.evidenceJson);
  const facts = objectValue(row.facts, row.factsJson);
  const sampleUrls = arrayValue(row.sampleUrls, row.sampleUrlsJson);
  return {
    ...row,
    index,
    findingId: String(row.findingId || row.id || `${checkId}#${index}`),
    checkId,
    auditType: row.auditType || (checkId.startsWith('geo.') || checkId.startsWith('trust.') || checkId.startsWith('llm.') ? 'geo' : 'tech'),
    evaluationState,
    scoreEligible,
    coverageEvaluated,
    reliablyEvaluated,
    confidence,
    severity,
    findingType,
    categoryKey,
    categoryFactor,
    coverageWeight,
    evidence,
    facts,
    sampleUrls,
    explicitRootCauseKey: cleanKey(row.rootCauseKey || row.scoreDeduplicationKey),
    rootCauseFamily: cleanKey(row.rootCauseFamily),
    scopeType: normalizeScopeType(row.scopeType || inferScopeType(row, evidence)),
    occurrenceCount: nonNegative(row.occurrenceCount ?? evidence.occurrenceCount ?? row.affectedCount),
    affectedUrlCount: nonNegative(row.affectedUrlCount ?? evidence.affectedUrlCount ?? evidence.uniqueTargets ?? row.affectedCount),
    displayedSampleCount: nonNegative(row.displayedSampleCount ?? evidence.displayedSamples ?? sampleUrls.length)
  };
}

function calculateCoverage(rows) {
  const units = new Map();
  for (const row of rows) {
    const key = coverageUnitKey(row);
    const unit = units.get(key) || { key, rows: [], weight: 0, categoryKey: row.categoryKey };
    unit.rows.push(row);
    unit.weight = Math.max(unit.weight, row.coverageWeight);
    units.set(key, unit);
  }
  let configuredWeight = 0;
  let eligibleWeight = 0;
  let evaluatedWeight = 0;
  let notApplicableWeight = 0;
  const categoryUnits = new Map();
  for (const unit of units.values()) {
    configuredWeight += unit.weight;
    const states = new Set(unit.rows.map((row) => row.evaluationState));
    const isNotApplicable = [...states].every((state) => state === 'not_applicable');
    // A deliberately score-free inventory or derived roll-up can still prove
    // that the required facts were collected. Score eligibility and evidence
    // coverage are independent dimensions.
    const evaluated = unit.rows.some((row) => row.coverageEvaluated);
    if (isNotApplicable) notApplicableWeight += unit.weight;
    else {
      eligibleWeight += unit.weight;
      if (evaluated) evaluatedWeight += unit.weight;
    }
    const bucket = categoryUnits.get(unit.categoryKey) || { configuredWeight: 0, eligibleWeight: 0, evaluatedWeight: 0, notApplicableWeight: 0 };
    bucket.configuredWeight += unit.weight;
    if (isNotApplicable) bucket.notApplicableWeight += unit.weight;
    else {
      bucket.eligibleWeight += unit.weight;
      if (evaluated) bucket.evaluatedWeight += unit.weight;
    }
    categoryUnits.set(unit.categoryKey, bucket);
  }
  const categories = Object.fromEntries([...categoryUnits.entries()].map(([key, value]) => [key, {
    ...roundObject(value),
    weightedCoverage: percent(value.evaluatedWeight, value.eligibleWeight),
    scoreStatus: coverageStatus(percent(value.evaluatedWeight, value.eligibleWeight))
  }]));
  return {
    configuredWeight: round(configuredWeight, 3),
    eligibleWeight: round(eligibleWeight, 3),
    evaluatedWeight: round(evaluatedWeight, 3),
    excludedWeight: round(Math.max(0, eligibleWeight - evaluatedWeight), 3),
    notApplicableWeight: round(notApplicableWeight, 3),
    weightedCoverage: percent(evaluatedWeight, eligibleWeight),
    categories
  };
}

function buildRootCauses(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.evaluationState !== 'fail' || !row.reliablyEvaluated) continue;
    for (const candidate of rootCauseCandidates(row)) {
      const member = { ...row, ...candidate };
      const group = groups.get(candidate.rootCauseKey) || [];
      group.push(member);
      groups.set(candidate.rootCauseKey, group);
    }
  }
  return [...groups.entries()].map(([rootCauseKey, members]) => rootCauseFromMembers(rootCauseKey, members));
}

function rootCauseCandidates(row) {
  const explicitCandidates = Array.isArray(row.evidence.rootCauseCandidates)
    ? row.evidence.rootCauseCandidates.filter((candidate) => candidate && candidate.key)
    : [];
  if (explicitCandidates.length) return explicitCandidates.map((candidate) => ({
    rootCauseKey: cleanKey(candidate.key),
    rootCauseFamily: cleanKey(candidate.family || row.rootCauseFamily || familyForCheck(row.checkId)),
    occurrenceCount: nonNegative(candidate.occurrenceCount ?? candidate.count ?? row.occurrenceCount),
    affectedUrlCount: nonNegative(candidate.affectedUrlCount ?? candidate.count ?? row.affectedUrlCount),
    displayedSampleCount: nonNegative(candidate.displayedSampleCount ?? 0),
    scopeType: normalizeScopeType(candidate.scopeType || row.scopeType),
    deduplicationConfidence: normalizeConfidence(candidate.deduplicationConfidence || 'high'),
    deduplicationReason: candidate.reason || 'Explicit deterministic root-cause candidate emitted by the check.'
  }));

  if (row.explicitRootCauseKey) return [{
    rootCauseKey: row.explicitRootCauseKey,
    rootCauseFamily: row.rootCauseFamily || familyForCheck(row.checkId),
    occurrenceCount: row.occurrenceCount,
    affectedUrlCount: row.affectedUrlCount,
    displayedSampleCount: row.displayedSampleCount,
    scopeType: row.scopeType,
    deduplicationConfidence: 'high',
    deduplicationReason: 'Checks emitted the same explicit rootCauseKey.'
  }];

  if (ARTICLE_CHECKS.has(row.checkId)) return [{
    rootCauseKey: 'structured_data.article_coverage',
    rootCauseFamily: 'structured_data.article',
    occurrenceCount: row.occurrenceCount,
    affectedUrlCount: row.affectedUrlCount,
    displayedSampleCount: row.displayedSampleCount,
    scopeType: row.scopeType,
    deduplicationConfidence: 'high',
    deduplicationReason: 'Deterministic Article/BlogPosting coverage rule shared by Tech and GEO checks.'
  }];

  return [{
    rootCauseKey: `check.${cleanKey(row.checkId)}`,
    rootCauseFamily: row.rootCauseFamily || familyForCheck(row.checkId),
    occurrenceCount: row.occurrenceCount,
    affectedUrlCount: row.affectedUrlCount,
    displayedSampleCount: row.displayedSampleCount,
    scopeType: row.scopeType,
    deduplicationConfidence: 'high',
    deduplicationReason: 'Same deterministic check and technical condition; no cross-check merge inferred.'
  }];
}

const ARTICLE_CHECKS = new Set([
  'tech.article_coverage_on_article_like_pages',
  'geo.article_blog_pages_article_schema'
]);

function rootCauseFromMembers(rootCauseKey, members) {
  const sorted = [...members].sort(comparePrimary);
  const primary = sorted[0];
  const relatedCheckIds = [...new Set(members.map((row) => row.checkId))].sort();
  const memberFindingIds = [...new Set(members.map((row) => row.findingId))];
  const scopeType = strongestScopeType(members.map((row) => row.scopeType));
  const occurrenceCount = maxAcrossCheckGroups(members, 'occurrenceCount');
  const affectedUrlCount = Math.max(
    maxAcrossCheckGroups(members, 'affectedUrlCount'),
    maxUniqueSamplesAcrossCheckGroups(members)
  );
  const displayedSampleCount = new Set(members.flatMap((row) => row.sampleUrls || [])).size || Math.max(...members.map((row) => row.displayedSampleCount), 0);
  const severity = members.reduce((current, row) => SEVERITY_RANK[row.severity] > SEVERITY_RANK[current] ? row.severity : current, 'low');
  const confidence = members.reduce((current, row) => confidenceRank(row.confidence) < confidenceRank(current) ? row.confidence : current, 'high');
  const confidenceFactor = scoringConfig.confidenceFactors[confidence] ?? 0;
  const scopeFactor = scopeFactorForCount(Math.max(1, affectedUrlCount || occurrenceCount), scopeType);
  const basePenalty = scoringConfig.severityPenalties[severity] || 0;
  const categoryFactor = scoringConfig.categoryPenaltyFactors[primary.categoryKey] || scoringConfig.categoryPenaltyFactors.other;
  const rawPenalty = round(basePenalty * scopeFactor * confidenceFactor * categoryFactor, 4);
  const optionalLow = severity === 'low' && members.every((row) => row.findingType !== 'core_issue');
  return {
    rootCauseId: rootCauseIdForKey(rootCauseKey),
    rootCauseKey,
    rootCauseFamily: primary.rootCauseFamily || familyForCheck(primary.checkId),
    category: primary.category || 'Uncategorized',
    categoryKey: primary.categoryKey,
    severity,
    severityVariants: [...new Set(members.map((row) => row.severity))].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a]),
    confidence,
    scopeType,
    occurrenceCount,
    affectedUrlCount,
    displayedSampleCount,
    primaryCheckId: primary.checkId,
    relatedCheckIds,
    memberFindingIds,
    deduplicationConfidence: members.reduce((current, row) => confidenceRank(row.deduplicationConfidence) < confidenceRank(current) ? row.deduplicationConfidence : current, 'high'),
    deduplicationReason: primary.deduplicationReason,
    deduplicatedFindingCount: Math.max(0, memberFindingIds.length - 1),
    basePenalty,
    scopeFactor,
    confidenceFactor,
    categoryFactor,
    rawPenalty,
    appliedPenalty: rawPenalty,
    optionalLow,
    capsApplied: [],
    reason: `${severity} severity × ${scopeFactor} scope × ${confidenceFactor} confidence × ${categoryFactor} category factor.`
  };
}

function applyCaps(rootCauses) {
  const output = rootCauses.map((root) => ({ ...root, capsApplied: [] }));
  const capsApplied = [];
  const optionalRoots = output.filter((root) => root.optionalLow);
  const optionalRaw = sum(optionalRoots, 'appliedPenalty');
  if (optionalRaw > scoringConfig.optionalLowPenaltyCap) {
    applyProportionalCap(optionalRoots, scoringConfig.optionalLowPenaltyCap, 'optional_low_global');
    capsApplied.push(capRecord('optional_low_global', scoringConfig.optionalLowPenaltyCap, optionalRaw));
  }
  const byCategory = groupBy(output, (root) => root.categoryKey);
  for (const [categoryKey, roots] of byCategory.entries()) {
    const cap = scoringConfig.categoryPenaltyCaps[categoryKey] || scoringConfig.categoryPenaltyCaps.other;
    const raw = sum(roots, 'appliedPenalty');
    if (raw <= cap) continue;
    applyProportionalCap(roots, cap, `category:${categoryKey}`);
    capsApplied.push(capRecord(`category:${categoryKey}`, cap, raw));
  }
  const rawPenalty = round(sum(output, 'rawPenalty'), 3);
  const appliedPenalty = round(sum(output, 'appliedPenalty'), 3);
  return {
    rootCauses: output.sort((a, b) => b.appliedPenalty - a.appliedPenalty || a.rootCauseKey.localeCompare(b.rootCauseKey)),
    rawPenalty,
    appliedPenalty,
    capsApplied
  };
}

function applyProportionalCap(rows, cap, type) {
  const total = sum(rows, 'appliedPenalty');
  const factor = total ? cap / total : 1;
  for (const row of rows) {
    const before = row.appliedPenalty;
    row.appliedPenalty = round(before * factor, 4);
    row.capsApplied.push({ type, before: round(before, 4), after: row.appliedPenalty });
  }
}

function capRecord(type, limit, raw) {
  return { type, limit, rawPenalty: round(raw, 3), appliedPenalty: round(limit, 3), reduction: round(raw - limit, 3) };
}

function categoryBreakdown(rows, rootCauses, coverageCategories) {
  const keys = new Set([...Object.keys(coverageCategories), ...rootCauses.map((root) => root.categoryKey)]);
  return [...keys].map((categoryKey) => {
    const roots = rootCauses.filter((root) => root.categoryKey === categoryKey);
    const coverage = coverageCategories[categoryKey] || { weightedCoverage: 0, scoreStatus: 'insufficient_coverage', eligibleWeight: 0, evaluatedWeight: 0, excludedWeight: 0 };
    const appliedPenalty = round(sum(roots, 'appliedPenalty'), 3);
    const rawPenalty = round(sum(roots, 'rawPenalty'), 3);
    const diagnosticScore = clamp(Math.round(100 - appliedPenalty), 0, 100);
    const score = coverage.scoreStatus === 'insufficient_coverage' ? null : diagnosticScore;
    const categoryName = roots[0]?.category || rows.find((row) => row.categoryKey === categoryKey)?.category || categoryKey;
    return {
      category: categoryName,
      categoryKey,
      score,
      diagnosticScore,
      scoreStatus: coverage.scoreStatus,
      weightedCoverage: coverage.weightedCoverage,
      eligibleWeight: coverage.eligibleWeight,
      evaluatedWeight: coverage.evaluatedWeight,
      excludedWeight: round(Math.max(0, coverage.eligibleWeight - coverage.evaluatedWeight), 3),
      rootCauseCount: roots.length,
      rawPenalty,
      appliedPenalty,
      weightedDeduction: appliedPenalty,
      checks: rows.filter((row) => row.categoryKey === categoryKey).length,
      weight: coverage.eligibleWeight
    };
  }).sort((a, b) => b.appliedPenalty - a.appliedPenalty || a.categoryKey.localeCompare(b.categoryKey));
}

function exclusionBreakdown(rows) {
  const buckets = {};
  const excluded = rows.filter((row) => !row.reliablyEvaluated);
  for (const row of excluded) {
    const reason = row.confidence === 'low' && EVALUATED_STATES.has(row.evaluationState) ? 'low_confidence' : row.evaluationState;
    const bucket = buckets[reason] || { count: 0, weight: 0, checkIds: [] };
    bucket.count += 1;
    bucket.weight += row.coverageWeight;
    bucket.checkIds.push(row.checkId);
    buckets[reason] = bucket;
  }
  for (const bucket of Object.values(buckets)) {
    bucket.weight = round(bucket.weight, 3);
    bucket.checkIds = [...new Set(bucket.checkIds)].sort();
  }
  return {
    byReason: buckets,
    rows: excluded.map((row) => ({
      checkId: row.checkId,
      evaluationState: row.evaluationState,
      reason: row.scoreExclusionReason || (row.confidence === 'low' ? 'Low-confidence result excluded from scoring.' : `Excluded because evaluation state is ${row.evaluationState}.`),
      weight: row.coverageWeight
    }))
  };
}

function coverageUnitKey(row) {
  if (row.explicitRootCauseKey) return `root:${row.explicitRootCauseKey}`;
  if (ARTICLE_CHECKS.has(row.checkId)) return 'root:structured_data.article_coverage';
  return `check:${row.checkId}`;
}

function coverageStatus(value) {
  if (value >= scoringConfig.coverageThresholds.final) return 'final';
  if (value >= scoringConfig.coverageThresholds.provisional) return 'provisional';
  return 'insufficient_coverage';
}

function rootAsDeduction(root) {
  return {
    rootCauseId: root.rootCauseId,
    rootCauseKey: root.rootCauseKey,
    checkId: root.primaryCheckId,
    category: root.category,
    severity: root.severity,
    confidence: root.confidence,
    scopeType: root.scopeType,
    affectedUrlCount: root.affectedUrlCount,
    rawPenalty: root.rawPenalty,
    appliedPenalty: root.appliedPenalty,
    weightedDeduction: root.appliedPenalty,
    relatedCheckIds: root.relatedCheckIds
  };
}

function comparePrimary(left, right) {
  return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    || (FINDING_TYPE_RANK[left.findingType] ?? 9) - (FINDING_TYPE_RANK[right.findingType] ?? 9)
    || confidenceRank(right.confidence) - confidenceRank(left.confidence)
    || left.checkId.localeCompare(right.checkId);
}

function maxAcrossCheckGroups(rows, field) {
  const groups = groupBy(rows, (row) => row.checkId);
  let maximum = 0;
  for (const values of groups.values()) {
    const aggregateRows = values.filter((row) => Number(row[field] || 0) > 1);
    const value = aggregateRows.length
      ? Math.max(...values.map((row) => Number(row[field] || 0)))
      : values.reduce((sumValue, row) => sumValue + Number(row[field] || 0), 0);
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function maxUniqueSamplesAcrossCheckGroups(rows) {
  const groups = groupBy(rows, (row) => row.checkId);
  let maximum = 0;
  for (const values of groups.values()) {
    maximum = Math.max(maximum, new Set(values.flatMap((row) => row.sampleUrls || [])).size);
  }
  return maximum;
}

function strongestScopeType(values) {
  const rank = { unknown: 0, external: 1, url: 2, resource: 2, template: 3, service: 3, sitewide: 4 };
  return [...values].map(normalizeScopeType).sort((a, b) => rank[b] - rank[a])[0] || 'unknown';
}

function inferScopeType(row, evidence) {
  const id = String(row.checkId || row.id || '').toLowerCase();
  if (id.startsWith('template.')) return 'template';
  if (/external/.test(id)) return 'external';
  if (/image|resource|css|javascript|large_js|large_css/.test(id)) return 'resource';
  if (/https_reachable|http_to_https|www_non_www|robots|sitemap|header|not_found|compression|hsts|content_security/.test(id)) return 'sitewide';
  if (Number(evidence.templateCount || 0) > 0) return 'template';
  return Number(row.affectedCount || 0) > 0 ? 'url' : 'unknown';
}

function familyForCheck(checkId) {
  const id = String(checkId || 'unknown');
  if (/article|blogposting/.test(id)) return 'structured_data.article';
  if (/duplicate_title/.test(id)) return 'html_meta.duplicate_title';
  if (/duplicate_meta/.test(id)) return 'html_meta.duplicate_description';
  if (/redirect_loop/.test(id)) return 'redirect.loop';
  if (/internal_links_to_3xx/.test(id)) return 'redirect.internal_alias';
  if (/redirect_pages/.test(id)) return 'redirect.public_page';
  if (/image/.test(id)) return `media.${cleanKey(id.split('.').pop())}`;
  if (/console|pageerror|requestfailed/.test(id)) return 'browser.runtime_error';
  return cleanKey(id.replace(/^(tech|geo|trust|template|llm)\./, '').split('.').slice(0, 2).join('.')) || 'unknown';
}

function categoryKeyFor(category, checkId, auditType) {
  const text = `${category || ''} ${checkId || ''}`.toLowerCase();
  if (/accessib/.test(text)) return 'accessibility';
  if (/security|hsts|content.security|frame|referrer|permissions/.test(text)) return 'security';
  if (/structured|schema|article|product|breadcrumb|faq/.test(text)) return 'structured_data';
  if (/performance|lighthouse|lcp|ttfb|javascript|render/.test(text)) return 'performance';
  if (/media|image|video/.test(text)) return 'media';
  if (/crawling|index|redirect|canonical|robots|sitemap/.test(text)) return 'crawling_indexing';
  if (/html head|meta|title|heading|h1/.test(text)) return 'html_meta';
  if (auditType === 'geo' || /geo|ai crawler|ai bot|llms|trust/.test(text)) return 'geo';
  if (/content/.test(text)) return 'content';
  if (/server|infrastructure|http/.test(text)) return 'technical_seo';
  return 'other';
}

function baseCoverageWeight(priority, findingType) {
  const priorityWeight = priority === 'High' ? 1.5 : priority === 'Low' ? 0.5 : 1;
  const typeWeight = findingType === 'core_issue' ? 1
    : findingType === 'best_practice' ? 0.5
      : findingType === 'opportunity' || findingType === 'llm_assisted' ? 0.3
        : 0.15;
  return priorityWeight * typeWeight;
}

function normalizeSeverity(value, status, priority) {
  const candidate = String(value || '').toLowerCase();
  if (candidate in SEVERITY_RANK) return candidate;
  const declaredPriority = String(priority || '').toLowerCase();
  if (declaredPriority in SEVERITY_RANK) return declaredPriority;
  if (status === 'Error') return 'high';
  if (status === 'Warning') return 'medium';
  return 'none';
}

function normalizeConfidence(value) {
  return ['high', 'medium', 'low'].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'high';
}

function confidenceRank(value) {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function normalizeScopeType(value) {
  const candidate = String(value || '').toLowerCase();
  return candidate in scoringConfig.scope.typeMultipliers ? candidate : 'unknown';
}

function objectValue(value, json) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function arrayValue(value, json) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanKey(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 300) || null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function sum(values, key) {
  return values.reduce((total, value) => total + Number(value[key] || 0), 0);
}

function percent(part, whole) {
  return whole ? round((part / whole) * 100, 1) : 0;
}

function roundObject(value) {
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, round(number, 3)]));
}

function round(value, places = 0) {
  const multiplier = 10 ** places;
  return Math.round(Number(value || 0) * multiplier) / multiplier;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Historical compatibility only. Old runs without persisted scoring-version
// metadata continue to use this exact aggregate and are never clustered by v2.
export function computeLegacyScores(results = []) {
  const prepared = results.map((row, index) => ({
    ...row,
    index,
    checkId: row.checkId || row.id || `check-${index}`,
    auditType: row.auditType || ((row.checkId || row.id || '').match(/^(geo|trust|llm)\./) ? 'geo' : 'tech'),
    findingType: row.findingType || row.normalizedFindingType || 'core_issue',
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    weight: originalLegacyWeight(row)
  }));
  const eligible = prepared.filter((row) => row.score !== null && row.score !== undefined);
  const excluded = prepared.filter((row) => row.score === null || row.score === undefined);
  const scoreFor = (predicate) => originalLegacyWeightedScore(eligible.filter(predicate));
  const configuredWeight = prepared.reduce((total, row) => total + row.weight, 0);
  const eligibleWeight = eligible.reduce((total, row) => total + row.weight, 0);
  const coverage = percent(eligibleWeight, configuredWeight);
  return {
    scoringVersion: null,
    deduplicationVersion: null,
    coverageModelVersion: null,
    checkLogicVersion: null,
    scoreStatus: 'historical_unknown',
    weightedCoverage: coverage,
    techScore: scoreFor((row) => row.auditType === 'tech'),
    geoScore: scoreFor((row) => row.auditType === 'geo'),
    overallScore: scoreFor(() => true),
    breakdown: {
      scoringModel: 'legacy-unversioned-original',
      historicalVersionUnknown: true,
      configuredChecks: prepared.length,
      eligibleChecks: eligible.length,
      excludedChecks: excluded.length,
      deduplicatedChecks: 0,
      dataCoveragePct: coverage,
      maximumScoreAtAvailableCoverage: coverage,
      normalizedMaximumScore: eligibleWeight ? 100 : null,
      eligibleWeight: round(eligibleWeight, 3),
      configuredWeight: round(configuredWeight, 3),
      categories: originalLegacyCategories(eligible),
      deductions: eligible.filter((row) => row.score < 10).map((row) => ({
        checkId: row.checkId,
        category: row.category,
        status: row.status,
        priority: row.priority,
        findingType: row.findingType,
        score: row.score,
        weight: row.weight,
        weightedDeduction: round((10 - row.score) * row.weight, 3),
        deduplicationKey: null
      })).sort((left, right) => right.weightedDeduction - left.weightedDeduction),
      excluded: excluded.map((row) => ({ checkId: row.checkId, evaluationState: 'historical_unknown', reason: 'Historical result has no numeric per-check score.' })),
      deduplicated: []
    }
  };
}

export function computeEvidenceGatedLegacyScores(results = []) {
  const prepared = results.map(legacyPrepareRow);
  const excluded = prepared.filter((row) => !row.eligible);
  const eligible = prepared.filter((row) => row.eligible);
  const { representatives, duplicates } = legacyDeduplicateRows(eligible);
  const scoreForAuditType = (auditType) => legacyWeightedScore(representatives.filter((row) => row.auditType === auditType));
  const totalConfiguredWeight = legacyConfiguredWeight(prepared);
  const eligibleWeight = representatives.reduce((total, row) => total + row.weight, 0);
  const coveragePct = totalConfiguredWeight ? round((eligibleWeight / totalConfiguredWeight) * 100, 1) : 0;
  return {
    scoringVersion: null,
    deduplicationVersion: null,
    coverageModelVersion: null,
    checkLogicVersion: null,
    scoreStatus: 'historical_unknown',
    weightedCoverage: coveragePct,
    techScore: scoreForAuditType('tech'),
    geoScore: scoreForAuditType('geo'),
    overallScore: legacyWeightedScore(representatives),
    breakdown: {
      scoringModel: 'legacy-unversioned',
      historicalVersionUnknown: true,
      configuredChecks: prepared.length,
      eligibleChecks: representatives.length,
      excludedChecks: excluded.length,
      deduplicatedChecks: duplicates.length,
      dataCoveragePct: coveragePct,
      maximumScoreAtAvailableCoverage: coveragePct,
      normalizedMaximumScore: eligibleWeight ? 100 : null,
      eligibleWeight: round(eligibleWeight, 3),
      configuredWeight: round(totalConfiguredWeight, 3),
      categories: legacyCategoryBreakdown(representatives),
      deductions: representatives.filter((row) => row.score < 10).map((row) => ({
        checkId: row.checkId,
        category: row.category,
        status: row.status,
        priority: row.priority,
        findingType: row.findingType,
        score: row.score,
        weight: round(row.weight, 3),
        weightedDeduction: round((10 - row.score) * row.weight, 3),
        deduplicationKey: row.deduplicationKey
      })).sort((left, right) => right.weightedDeduction - left.weightedDeduction),
      excluded: excluded.map((row) => ({ checkId: row.checkId, evaluationState: row.evaluationState, reason: row.scoreExclusionReason || `Excluded because evaluation state is ${row.evaluationState}.` })),
      deduplicated: duplicates.map(({ row, representative }) => ({ checkId: row.checkId, deduplicationKey: row.deduplicationKey, representedBy: representative.checkId }))
    }
  };
}

function originalLegacyWeightedScore(rows) {
  if (!rows.length) return null;
  const weightedTotal = rows.reduce((total, row) => total + row.score * row.weight, 0);
  const weightedMax = rows.reduce((total, row) => total + 10 * row.weight, 0);
  return weightedMax ? Math.round((weightedTotal / weightedMax) * 100) : null;
}

function originalLegacyWeight(row) {
  // Historical scoring used the persisted finding type. Display semantics are
  // additive UI fields and must not rewrite an old run's numeric aggregate.
  const type = row.findingType || row.normalizedFindingType || 'core_issue';
  const auditType = row.auditType || ((row.checkId || row.id || '').match(/^(geo|trust|llm)\./) ? 'geo' : 'tech');
  const text = `${row.checkId || row.id || ''} ${row.category || ''}`.toLowerCase();
  if (type === 'opportunity' || auditType === 'geo' || /geo|ai crawler|ai bot|speakable|llms|webmanifest|pwa/.test(text)) return 0.35;
  if (type === 'best_practice' || /security/.test(text)) return 0.5;
  if (type === 'info') return 0.2;
  return 1;
}

function originalLegacyCategories(rows) {
  const groups = groupBy(rows, (row) => row.category || 'Uncategorized');
  return [...groups.entries()].map(([category, values]) => {
    const weight = values.reduce((total, row) => total + row.weight, 0);
    const deduction = values.reduce((total, row) => total + (10 - row.score) * row.weight, 0);
    return {
      category,
      checks: values.length,
      weight: round(weight, 3),
      score: originalLegacyWeightedScore(values),
      weightedDeduction: round(deduction, 3)
    };
  }).sort((left, right) => right.weightedDeduction - left.weightedDeduction);
}

function legacyPrepareRow(row = {}, index) {
  const score = row.score ?? scoreForStatus(row.status);
  const evaluationState = row.evaluationState || (row.status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(row.status) ? 'fail' : 'insufficient_evidence');
  const scoreEligible = row.scoreEligible === undefined || row.scoreEligible === null ? EVALUATED_STATES.has(evaluationState) : Boolean(row.scoreEligible);
  return {
    ...row,
    index,
    checkId: row.checkId || row.id || `check-${index}`,
    score: score === null || score === undefined ? null : Number(score),
    evaluationState,
    eligible: scoreEligible && EVALUATED_STATES.has(evaluationState) && score !== null && score !== undefined,
    findingType: row.findingType || row.normalizedFindingType || 'core_issue',
    deduplicationKey: row.scoreDeduplicationKey || null,
    weight: legacyScoreWeight(row)
  };
}

function legacyDeduplicateRows(rows) {
  const representatives = [];
  const duplicates = [];
  const groups = new Map();
  for (const row of rows) {
    if (!row.deduplicationKey) { representatives.push(row); continue; }
    const key = `${row.auditType || 'unknown'}:${row.deduplicationKey}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const [representative, ...rest] = [...group].sort(legacyCompareRisk);
    representatives.push(representative);
    duplicates.push(...rest.map((row) => ({ row, representative })));
  }
  return { representatives, duplicates };
}

function legacyConfiguredWeight(rows) {
  let total = 0;
  const roots = new Map();
  for (const row of rows) {
    if (!row.deduplicationKey) { total += row.weight; continue; }
    const key = `${row.auditType || 'unknown'}:${row.deduplicationKey}`;
    roots.set(key, Math.max(roots.get(key) || 0, row.weight));
  }
  return total + [...roots.values()].reduce((sumValue, weight) => sumValue + weight, 0);
}

function legacyCompareRisk(left, right) {
  if (left.score !== right.score) return left.score - right.score;
  const priority = { High: 0, Medium: 1, Low: 2 };
  return (priority[left.priority] ?? 1) - (priority[right.priority] ?? 1);
}

function legacyWeightedScore(rows) {
  if (!rows.length) return null;
  let weightedTotal = 0;
  let weightedMax = 0;
  for (const row of rows) {
    weightedTotal += row.score * row.weight;
    weightedMax += 10 * row.weight;
  }
  return weightedMax ? Math.round((weightedTotal / weightedMax) * 100) : null;
}

function legacyScoreWeight(row) {
  const type = row.findingType || row.normalizedFindingType || 'core_issue';
  const text = `${row.checkId || row.id || ''} ${row.category || ''}`.toLowerCase();
  let baseWeight = 1;
  if (type === 'opportunity' || row.auditType === 'geo' || /geo|ai crawler|ai bot|speakable|llms|webmanifest|pwa/.test(text)) baseWeight = 0.25;
  else if (type === 'best_practice' || /security/.test(text)) baseWeight = 0.4;
  else if (type === 'info') baseWeight = 0.15;
  const priorityMultiplier = row.priority === 'High' ? 1.5 : row.priority === 'Low' ? 0.25 : 0.75;
  return baseWeight * priorityMultiplier;
}

function legacyCategoryBreakdown(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const name = row.category || 'Uncategorized';
    const bucket = buckets.get(name) || { category: name, checks: 0, weight: 0, weightedTotal: 0, deductions: 0 };
    bucket.checks += 1;
    bucket.weight += row.weight;
    bucket.weightedTotal += row.score * row.weight;
    bucket.deductions += (10 - row.score) * row.weight;
    buckets.set(name, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    category: bucket.category,
    checks: bucket.checks,
    weight: round(bucket.weight, 3),
    score: bucket.weight ? Math.round((bucket.weightedTotal / (bucket.weight * 10)) * 100) : null,
    weightedDeduction: round(bucket.deductions, 3)
  })).sort((left, right) => right.weightedDeduction - left.weightedDeduction);
}

export function statusFromAffected(affectedCount, warningOnly = false) {
  if (affectedCount > 0) return warningOnly ? 'Warning' : 'Error';
  return 'OK';
}
