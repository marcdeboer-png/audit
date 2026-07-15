export function scoreForStatus(status) {
  if (status === 'OK') return 10;
  if (status === 'Warning') return 5;
  if (status === 'Error') return 1;
  return null;
}

export function computeScores(results = []) {
  const prepared = results.map(prepareRow);
  const excluded = prepared.filter((row) => !row.eligible);
  const eligible = prepared.filter((row) => row.eligible);
  const { representatives, duplicates } = deduplicateRows(eligible);
  const scoreForAuditType = (auditType) => weightedScore(representatives.filter((row) => row.auditType === auditType));
  const techScore = scoreForAuditType('tech');
  const geoScore = scoreForAuditType('geo');
  const overallScore = weightedScore(representatives);
  const totalConfiguredWeight = configuredWeight(prepared);
  const eligibleWeight = representatives.reduce((total, row) => total + row.weight, 0);
  const coveragePct = totalConfiguredWeight ? round((eligibleWeight / totalConfiguredWeight) * 100, 1) : 0;

  return {
    techScore,
    geoScore,
    overallScore,
    breakdown: {
      scoringModel: 'evidence-gated-weighted-v2',
      configuredChecks: prepared.length,
      eligibleChecks: representatives.length,
      excludedChecks: excluded.length,
      deduplicatedChecks: duplicates.length,
      dataCoveragePct: coveragePct,
      maximumScoreAtAvailableCoverage: coveragePct,
      normalizedMaximumScore: eligibleWeight ? 100 : null,
      eligibleWeight: round(eligibleWeight, 3),
      configuredWeight: round(totalConfiguredWeight, 3),
      categories: categoryBreakdown(representatives),
      deductions: representatives
        .filter((row) => row.score < 10)
        .map((row) => ({
          checkId: row.checkId,
          category: row.category,
          status: row.status,
          priority: row.priority,
          findingType: row.findingType,
          score: row.score,
          weight: round(row.weight, 3),
          weightedDeduction: round((10 - row.score) * row.weight, 3),
          deduplicationKey: row.deduplicationKey
        }))
        .sort((left, right) => right.weightedDeduction - left.weightedDeduction),
      excluded: excluded.map((row) => ({
        checkId: row.checkId,
        evaluationState: row.evaluationState,
        reason: row.scoreExclusionReason || `Excluded because evaluation state is ${row.evaluationState}.`
      })),
      deduplicated: duplicates.map(({ row, representative }) => ({
        checkId: row.checkId,
        deduplicationKey: row.deduplicationKey,
        representedBy: representative.checkId
      }))
    }
  };
}

function prepareRow(row = {}, index) {
  const score = row.score ?? scoreForStatus(row.status);
  const evaluationState = row.evaluationState || (row.status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(row.status) ? 'fail' : 'insufficient_evidence');
  const scoreEligible = row.scoreEligible === undefined || row.scoreEligible === null
    ? ['pass', 'fail'].includes(evaluationState)
    : Boolean(row.scoreEligible);
  const eligible = scoreEligible && ['pass', 'fail'].includes(evaluationState) && score !== null && score !== undefined;
  return {
    ...row,
    index,
    checkId: row.checkId || row.id || `check-${index}`,
    score: score === null || score === undefined ? null : Number(score),
    evaluationState,
    eligible,
    findingType: row.findingType || row.normalizedFindingType || 'core_issue',
    deduplicationKey: row.scoreDeduplicationKey || null,
    weight: scoreWeight(row)
  };
}

function deduplicateRows(rows) {
  const representatives = [];
  const duplicates = [];
  const groups = new Map();
  for (const row of rows) {
    if (!row.deduplicationKey) {
      representatives.push(row);
      continue;
    }
    const key = `${row.auditType || 'unknown'}:${row.deduplicationKey}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const [representative, ...rest] = [...group].sort(compareRisk);
    representatives.push(representative);
    duplicates.push(...rest.map((row) => ({ row, representative })));
  }
  return { representatives, duplicates };
}

function configuredWeight(rows) {
  let total = 0;
  const roots = new Map();
  for (const row of rows) {
    if (!row.deduplicationKey) {
      total += row.weight;
      continue;
    }
    const key = `${row.auditType || 'unknown'}:${row.deduplicationKey}`;
    roots.set(key, Math.max(roots.get(key) || 0, row.weight));
  }
  return total + [...roots.values()].reduce((sum, weight) => sum + weight, 0);
}

function compareRisk(left, right) {
  if (left.score !== right.score) return left.score - right.score;
  const priority = { High: 0, Medium: 1, Low: 2 };
  return (priority[left.priority] ?? 1) - (priority[right.priority] ?? 1);
}

function weightedScore(rows) {
  if (!rows.length) return null;
  let weightedTotal = 0;
  let weightedMax = 0;
  for (const row of rows) {
    weightedTotal += row.score * row.weight;
    weightedMax += 10 * row.weight;
  }
  return weightedMax ? Math.round((weightedTotal / weightedMax) * 100) : null;
}

function scoreWeight(row) {
  const type = row.findingType || row.normalizedFindingType || 'core_issue';
  const text = `${row.checkId || row.id || ''} ${row.category || ''}`.toLowerCase();
  let baseWeight = 1;
  if (type === 'opportunity' || row.auditType === 'geo' || /geo|ai crawler|ai bot|speakable|llms|webmanifest|pwa/.test(text)) baseWeight = 0.25;
  else if (type === 'best_practice' || /security/.test(text)) baseWeight = 0.4;
  else if (type === 'info') baseWeight = 0.15;

  const priorityMultiplier = row.priority === 'High' ? 1.5 : row.priority === 'Low' ? 0.25 : 0.75;
  return baseWeight * priorityMultiplier;
}

function categoryBreakdown(rows) {
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

function round(value, places = 0) {
  const multiplier = 10 ** places;
  return Math.round(Number(value || 0) * multiplier) / multiplier;
}

export function statusFromAffected(affectedCount, warningOnly = false) {
  if (affectedCount > 0) return warningOnly ? 'Warning' : 'Error';
  return 'OK';
}
