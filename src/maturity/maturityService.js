import { loadResultsWithScores } from '../checks/checkEngine.js';
import { getRunWithProject, getSamplingSummary } from '../db/repositories.js';
import {
  getMaturityCategoryDefinitions,
  getMaturityCategoryForCheck,
  maturityCategoryWeights,
  UNCATEGORIZED_CATEGORY_ID
} from './maturityCategories.js';

const EXCLUDED_UNAVAILABLE_CHECKS = new Set([
  'template.lighthouse_unavailable',
  'template.playwright_unavailable'
]);

const LOW_AVAILABILITY_GEO_CHECKS = new Set([
  'geo.llms_txt_present',
  'geo.llms_txt_http_status',
  'geo.llms_full_txt_present',
  'geo.markdown_twin_homepage',
  'geo.markdown_twin_coverage'
]);

const IMPLICIT_AI_POLICY_CHECKS = new Set([
  'geo.ai_bots_policy_summary',
  'geo.robots_mentions_gptbot',
  'geo.robots_mentions_oai_searchbot',
  'geo.robots_mentions_claudebot',
  'geo.robots_mentions_perplexitybot',
  'geo.robots_mentions_google_extended'
]);

const MATURITY_LABELS = [
  { min: 0, max: 1.9, label: 'Kritisch' },
  { min: 2, max: 3.9, label: 'Unausgereift' },
  { min: 4, max: 5.4, label: 'Basis vorhanden' },
  { min: 5.5, max: 6.9, label: 'Fortgeschritten' },
  { min: 7, max: 8.4, label: 'Stark' },
  { min: 8.5, max: 10, label: 'Top' }
];

const STRATEGIC_CATEGORY_IDS = new Set([
  'technical-seo',
  'structure-quality',
  'structured-data',
  'geo-readiness',
  'trust-entity',
  'media-performance',
  'template-rendering'
]);

export function buildMaturityModel(db, runId) {
  const run = getRunWithProject(db, runId);
  if (!run) return null;

  const { scores, results } = loadResultsWithScores(db, run.id);
  const samplingSummary = getSamplingSummary(db, run.id);
  const categoryDefinitions = getMaturityCategoryDefinitions();
  const buckets = new Map(categoryDefinitions.map((category) => [category.id, {
    ...category,
    maxScore: 10,
    scoreTotal: 0,
    scoreWeight: 0,
    checkCount: 0,
    evaluatedCount: 0,
    passedCount: 0,
    warningCount: 0,
    errorCount: 0,
    opportunityCount: 0,
    bestPracticeCount: 0,
    naCount: 0,
    excludedCount: 0,
    items: [],
    keyFindings: [],
    unclearCheckIds: []
  }]));

  let checkScoreTotal = 0;
  let checkScoreWeight = 0;
  let passedChecks = 0;
  let actionItems = 0;
  let opportunities = 0;
  let bestPracticeWarnings = 0;
  let excludedChecks = 0;

  for (const row of results) {
    const categoryId = getMaturityCategoryForCheck(row);
    const bucket = buckets.get(categoryId) || buckets.get(UNCATEGORIZED_CATEGORY_ID);
    bucket.checkCount += 1;
    if (categoryId === UNCATEGORIZED_CATEGORY_ID) bucket.unclearCheckIds.push(row.checkId);

    const point = maturityPointForResult(row);
    const statusLabel = maturityStatusForResult(row, point);
    bucket.items.push(maturityItemForResult(row, point, statusLabel, bucket));
    if (statusLabel === 'OK') passedChecks += 1;
    if (isActionItem(row)) actionItems += 1;
    if (isOpenOpportunity(row)) opportunities += 1;
    if (isBestPracticeWarning(row)) bestPracticeWarnings += 1;

    if (point.excluded) {
      bucket.naCount += 1;
      bucket.excludedCount += 1;
      excludedChecks += 1;
      continue;
    }

    bucket.evaluatedCount += 1;
    bucket.scoreTotal += point.score * point.weight;
    bucket.scoreWeight += point.weight;
    checkScoreTotal += point.score * point.weight;
    checkScoreWeight += point.weight;

    if (statusLabel === 'OK') bucket.passedCount += 1;
    else if (statusLabel === 'Error') bucket.errorCount += 1;
    else if (statusLabel === 'Warning') bucket.warningCount += 1;
    else if (statusLabel === 'Opportunity') bucket.opportunityCount += 1;
    else if (statusLabel === 'NA') bucket.naCount += 1;
    if (isBestPracticeWarning(row)) bucket.bestPracticeCount += 1;

    if (statusLabel !== 'OK' && statusLabel !== 'NA' && bucket.keyFindings.length < 5) {
      bucket.keyFindings.push({
        checkId: row.checkId,
        title: row.checkName || row.name || row.checkId,
        status: statusLabel,
        priority: row.effectivePriority || row.priority || 'Low',
        findingType: row.normalizedFindingType || row.findingType || 'info',
        effort: row.effectiveEffort || row.effort || 'unknown',
        confidence: row.confidence || 'unknown',
        affectedCount: Number(row.affectedCount || 0),
        finding: row.effectiveFinding || row.finding || '',
        recommendation: row.effectiveRecommendation || row.recommendation || categoryRecommendation(bucket)
      });
    }
  }

  const baseCategories = [...buckets.values()]
    .filter((category) => category.checkCount > 0 || category.id !== UNCATEGORIZED_CATEGORY_ID)
    .map(finalizeCategory)
    .filter((category) => category.checkCount > 0 || category.id !== UNCATEGORIZED_CATEGORY_ID);

  const scoredBaseCategories = baseCategories.filter((category) => category.evaluatedCount > 0 && category.score !== null);
  const weightedCategoryWeight = scoredBaseCategories.reduce((sum, category) => sum + Number(category.weight || 1), 0);
  const weightedScore = weightedCategoryWeight
    ? round1(scoredBaseCategories.reduce((sum, category) => sum + category.score * Number(category.weight || 1), 0) / weightedCategoryWeight)
    : null;
  const unweightedScore = scoredBaseCategories.length
    ? round1(scoredBaseCategories.reduce((sum, category) => sum + category.score, 0) / scoredBaseCategories.length)
    : null;
  const checkAverageScore = checkScoreWeight ? round1(checkScoreTotal / checkScoreWeight) : null;
  const categories = baseCategories.map((category) => addWeightedCategoryMeta(category, weightedCategoryWeight));
  const scoredCategories = categories.filter((category) => category.evaluatedCount > 0 && category.score !== null);
  const bestCategory = [...scoredCategories].sort((a, b) => b.score - a.score || b.weight - a.weight || b.evaluatedCount - a.evaluatedCount)[0] || null;
  const weakestCategory = [...scoredCategories].sort((a, b) => a.score - b.score || b.weight - a.weight || b.errorCount - a.errorCount)[0] || null;
  const topStrengths = buildTopStrengths(scoredCategories);
  const topWeaknesses = buildTopWeaknesses(scoredCategories);
  const quickWins = buildQuickWins(scoredCategories);
  const strategicNextSteps = buildStrategicNextSteps(scoredCategories);
  const managementSummary = buildManagementSummary({
    weightedScore,
    unweightedScore,
    scoredCategories,
    bestCategory,
    weakestCategory,
    topStrengths,
    topWeaknesses,
    quickWins,
    strategicNextSteps,
    actionItems,
    opportunities
  });

  return {
    runId: run.id,
    domain: run.finalDomain || run.inputDomain,
    generatedAt: new Date().toISOString(),
    overallScore: scores.overallScore,
    techScore: scores.techScore,
    geoScore: scores.geoScore,
    maturityScore: weightedScore,
    weightedScore,
    unweightedScore,
    checkAverageScore,
    maturityLabel: maturityLabel(weightedScore),
    scoreScale: '0-10',
    scoringModel: {
      method: 'weighted_category_average',
      description: 'Each check is scored inside its category first; the overall maturity score is then the weighted average of category scores.',
      OK: 10,
      Opportunity: 6,
      MissingOrUnavailableSignal: 1,
      MissingGeoAvailability: 1,
      ImplicitAiCrawlerPolicy: 1,
      BestPracticeWarning: 6,
      Warning: 4,
      Error: 1,
      NA: 'excluded',
      unavailableTooling: 'excluded unless explicitly Error',
      categoryWeights: maturityCategoryWeights,
      labels: MATURITY_LABELS,
      unweightedScore: 'Plain average of evaluated category scores.',
      checkAverageScore: 'Legacy-style average across evaluated checks; included for transparency only.',
      labelSource: 'MVP fallback labels because no unambiguous OMfire! maturity-label scale was available in the design reference.',
      note: 'Derived from existing display status, finding type and maturity category weights; no LLM scoring and no new checks.'
    },
    visualization: {
      sunburst: {
      segmentSource: 'maturity.categories',
      segmentSize: 'category.items.length',
      segmentColor: 'category.score',
      unavailableCategoryHandling: 'visible_neutral'
      }
    },
    totalChecks: results.length,
    evaluatedChecks: scoredCategories.reduce((sum, category) => sum + category.evaluatedCount, 0),
    excludedChecks,
    passedChecks,
    actionItems,
    opportunities,
    bestPracticeWarnings,
    bestCategory: bestCategory ? compactCategorySummary(bestCategory) : null,
    weakestCategory: weakestCategory ? compactCategorySummary(weakestCategory) : null,
    managementSummary,
    categories,
    topStrengths,
    topWeaknesses,
    quickWins,
    strategicNextSteps,
    strengths: topStrengths,
    weaknesses: topWeaknesses,
    nextSteps: strategicNextSteps,
    uncategorizedCheckIds: categories.find((category) => category.id === UNCATEGORIZED_CATEGORY_ID)?.unclearCheckIds || [],
    samplingSummary: {
      enableTemplateSampling: Boolean(samplingSummary?.enableTemplateSampling),
      enablePlaywrightSampling: Boolean(samplingSummary?.enablePlaywrightSampling),
      enableLighthouseSampling: Boolean(samplingSummary?.enableLighthouseSampling),
      renderingStatus: samplingSummary?.renderingStatus || 'disabled',
      lighthouseStatus: samplingSummary?.lighthouseStatus || 'disabled',
      playwrightSuccessCount: samplingSummary?.playwrightSuccessCount || 0,
      lighthouseSuccessCount: samplingSummary?.lighthouseSuccessCount || 0
    }
  };
}

export function maturityPointForResult(row = {}) {
  const status = displayStatus(row);
  const type = String(row.normalizedFindingType || row.findingType || '').toLowerCase();
  if (shouldExcludeFromMaturity(row, status)) return { score: null, weight: 0, excluded: true, reason: 'not_applicable' };
  if (hasContradictoryFailureEvidence(row, status)) return { score: 1, weight: 1, excluded: false, reason: 'contradictory_missing_evidence' };
  const checkSpecificPoint = checkSpecificMaturityPoint(row, status);
  if (checkSpecificPoint) return checkSpecificPoint;
  if (isMissingOrUnavailableSignal(row, status)) return { score: 1, weight: 1, excluded: false, reason: 'missing_or_unavailable_signal' };
  if (status === 'OK') return { score: 10, weight: 1, excluded: false };
  if (status === 'Opportunity' || type === 'opportunity') return { score: 6, weight: 1, excluded: false };
  if (type === 'best_practice') return { score: 6, weight: 1, excluded: false };
  if (status === 'Warning') return { score: 4, weight: 1, excluded: false };
  if (status === 'Error') return { score: 1, weight: 1, excluded: false };
  return { score: null, weight: 0, excluded: true, reason: 'unknown_status' };
}

function checkSpecificMaturityPoint(row, status) {
  const checkId = String(row.checkId || row.id || '');
  if (LOW_AVAILABILITY_GEO_CHECKS.has(checkId)) {
    if (status === 'OK') return { score: 10, weight: 1, excluded: false, reason: 'available_geo_signal' };
    return { score: 1, weight: 1, excluded: false, reason: 'missing_geo_availability' };
  }
  if (IMPLICIT_AI_POLICY_CHECKS.has(checkId)) {
    if (status === 'OK') return { score: 10, weight: 1, excluded: false, reason: 'explicit_ai_policy' };
    return { score: 1, weight: 1, excluded: false, reason: 'implicit_ai_policy' };
  }
  return null;
}

function maturityStatusForResult(row, point = {}) {
  const status = displayStatus(row);
  if (point.reason !== 'contradictory_missing_evidence') return status;
  return isOpportunity(row) ? 'Opportunity' : 'Warning';
}

function hasContradictoryFailureEvidence(row, status) {
  if (status !== 'OK') return false;
  const text = [
    row.finding,
    row.effectiveFinding,
    row.details,
    row.evidenceJson
  ].filter(Boolean).join(' ').toLowerCase();
  if (!text) return false;
  return (
    /\bstatus recorded:\s*(?:4\d\d|5\d\d)\b/.test(text) ||
    /\breturned\s+(?:4\d\d|5\d\d|fetch failed)\b/.test(text) ||
    /\bdid not return\b/.test(text) ||
    /\bnot found\b/.test(text) ||
    /\bnot available\b/.test(text) ||
    /\bunavailable\b/.test(text) ||
    /\bnot explicitly mentioned\b/.test(text) ||
    /\bdoes not explicitly mention\b/.test(text)
  );
}

function isMissingOrUnavailableSignal(row, status) {
  if (status === 'OK' || status === 'NA') return false;
  const text = [
    row.checkId,
    row.id,
    row.checkName,
    row.name,
    row.finding,
    row.effectiveFinding,
    row.details
  ].filter(Boolean).join(' ').toLowerCase();
  if (!text) return false;
  return (
    /\bmissing\b/.test(text) ||
    /\blacks?\b/.test(text) ||
    /\bwithout\b/.test(text) ||
    /\bnot found\b/.test(text) ||
    /\bnot detected\b/.test(text) ||
    /\bnot present\b/.test(text) ||
    /\bnot available\b/.test(text) ||
    /\bunavailable\b/.test(text) ||
    /\bdid not return\b/.test(text) ||
    /\bnot return\b/.test(text) ||
    /\breturned\s+(?:4\d\d|5\d\d|fetch failed)\b/.test(text) ||
    /\bno checked\b.*\breturned\b/.test(text) ||
    /\bdoes not explicitly mention\b/.test(text) ||
    /\bnot explicitly mentioned\b/.test(text) ||
    /_missing\b/.test(text) ||
    /present_missing/.test(text)
  );
}

function shouldExcludeFromMaturity(row, status) {
  if (status === 'NA') return true;
  if (EXCLUDED_UNAVAILABLE_CHECKS.has(row.checkId) && status !== 'Error') return true;
  if (row.reportSection === 'not_applicable') return true;
  return false;
}

function finalizeCategory(category) {
  const score = category.scoreWeight ? round1(category.scoreTotal / category.scoreWeight) : null;
  const keyFindings = [...category.keyFindings]
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.affectedCount - a.affectedCount)
    .slice(0, 5);
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    managementDescription: category.managementDescription,
    businessImportance: category.businessImportance,
    scoreInterpretation: category.scoreInterpretation,
    weight: Number(category.weight || 1),
    score,
    maxScore: category.maxScore,
    normalizedScore: score === null ? null : Math.round((score / category.maxScore) * 100),
    maturityLabel: maturityLabel(score),
    checkCount: category.checkCount,
    evaluatedCount: category.evaluatedCount,
    passedCount: category.passedCount,
    warningCount: category.warningCount,
    errorCount: category.errorCount,
    opportunityCount: category.opportunityCount,
    bestPracticeCount: category.bestPracticeCount,
    naCount: category.naCount,
    excludedCount: category.excludedCount,
    statusDistribution: {
      OK: category.passedCount,
      Warning: category.warningCount,
      Error: category.errorCount,
      Opportunity: category.opportunityCount,
      NA: category.naCount
    },
    items: category.items.map(compactMaturityItem),
    keyFindings,
    recommendation: category.recommendation,
    unclearCheckIds: [...new Set(category.unclearCheckIds)]
  };
}

function maturityItemForResult(row, point, statusLabel, category) {
  const label = row.checkName || row.name || row.checkId || 'Check';
  return {
    id: row.checkId || String(row.id || row.checkResultId || label),
    checkResultId: row.id || row.checkResultId || null,
    label,
    shortLabel: shortenLabel(label, 28),
    score: point.excluded ? null : point.score,
    status: statusLabel,
    findingType: row.normalizedFindingType || row.findingType || 'info',
    weight: point.weight || 0,
    priority: row.effectivePriority || row.priority || 'Low',
    effort: row.effectiveEffort || row.effort || null,
    affectedCount: Number(row.affectedCount || 0),
    recommendation: row.effectiveRecommendation || row.recommendation || categoryRecommendation(category),
    finding: row.effectiveFinding || row.finding || '',
    confidence: row.confidence || 'unknown',
    reviewRecommended: Boolean(row.reviewRecommended)
  };
}

function compactMaturityItem(item) {
  return {
    id: item.id,
    checkResultId: item.checkResultId,
    label: item.label,
    shortLabel: item.shortLabel,
    score: item.score,
    status: item.status,
    findingType: item.findingType,
    weight: item.weight,
    priority: item.priority,
    effort: item.effort,
    affectedCount: item.affectedCount,
    recommendation: item.recommendation,
    finding: item.finding,
    confidence: item.confidence,
    reviewRecommended: item.reviewRecommended
  };
}

function addWeightedCategoryMeta(category, totalWeight) {
  if (!category.evaluatedCount || category.score === null || !totalWeight) {
    return {
      ...category,
      weightShare: 0,
      weightedContribution: 0
    };
  }
  const weight = Number(category.weight || 1);
  return {
    ...category,
    weightShare: round1((weight / totalWeight) * 100),
    weightedContribution: round2((category.score * weight) / totalWeight)
  };
}

function displayStatus(row) {
  if ((row.effectiveStatus || row.status) === 'NA') return 'NA';
  if ((row.effectiveStatus || row.status) === 'OK') return 'OK';
  if (row.displayStatus === 'Opportunity') return 'Opportunity';
  return row.effectiveStatus || row.displayStatus || row.status || 'NA';
}

function isOpportunity(row) {
  return displayStatus(row) === 'Opportunity' ||
    String(row.normalizedFindingType || row.findingType || '').toLowerCase() === 'opportunity';
}

function isOpenOpportunity(row) {
  return isOpportunity(row) && !['OK', 'NA'].includes(displayStatus(row));
}

function isBestPracticeWarning(row) {
  return ['Warning', 'Error'].includes(displayStatus(row)) &&
    String(row.normalizedFindingType || row.findingType || '').toLowerCase() === 'best_practice';
}

function isActionItem(row) {
  return row.reportSection === 'action_items' || (
    ['Warning', 'Error'].includes(displayStatus(row)) &&
    !isOpportunity(row) &&
    !isBestPracticeWarning(row)
  );
}

function maturityLabel(score) {
  if (score === null || score === undefined) return 'Nicht bewertet';
  if (score < 2) return 'Kritisch';
  if (score < 4) return 'Unausgereift';
  if (score < 5.5) return 'Basis vorhanden';
  if (score < 7) return 'Fortgeschritten';
  if (score < 8.5) return 'Stark';
  return 'Top';
}

function compactCategorySummary(category) {
  return {
    id: category.id,
    name: category.name,
    score: category.score,
    weight: category.weight,
    maturityLabel: category.maturityLabel,
    checkCount: category.checkCount,
    evaluatedCount: category.evaluatedCount
  };
}

function buildTopStrengths(categories) {
  return categories
    .filter((category) => category.score !== null && category.score >= 7)
    .sort((a, b) => b.score - a.score || b.weight - a.weight || b.passedCount - a.passedCount)
    .slice(0, 5)
    .map((category) => ({
      categoryId: category.id,
      title: category.name,
      score: category.score,
      weight: category.weight,
      description: `${category.passedCount} von ${category.evaluatedCount} bewerteten Checks sind OK. ${category.managementDescription || category.description}`
    }));
}

function buildTopWeaknesses(categories) {
  return categories
    .filter((category) => category.score !== null && (category.score < 7 || category.keyFindings.length))
    .sort((a, b) => a.score - b.score || b.weight - a.weight || b.errorCount - a.errorCount || b.warningCount - a.warningCount)
    .slice(0, 5)
    .map((category) => ({
      categoryId: category.id,
      title: category.name,
      score: category.score,
      weight: category.weight,
      description: category.keyFindings[0]?.finding || category.recommendation,
      keyFindings: category.keyFindings.slice(0, 3)
    }));
}

function buildQuickWins(categories) {
  const candidates = [];
  for (const category of categories) {
    for (const finding of category.keyFindings) {
      const effort = normalizeEffort(finding.effort, finding);
      const estimated = !['S', 'M', 'L'].includes(finding.effort || '');
      if (!isQuickWinCandidate(finding, effort)) continue;
      candidates.push({
        categoryId: category.id,
        checkId: finding.checkId,
        title: finding.title,
        score: category.score,
        priority: finding.priority,
        effort,
        effortSource: estimated ? 'estimated' : 'stored',
        findingType: finding.findingType,
        affectedCount: finding.affectedCount,
        description: finding.finding,
        recommendation: finding.recommendation || category.recommendation
      });
    }
  }
  return candidates
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort) || priorityRank(a.priority) - priorityRank(b.priority) || b.affectedCount - a.affectedCount)
    .slice(0, 5);
}

function buildStrategicNextSteps(categories) {
  return [...categories]
    .filter((category) => category.score !== null && STRATEGIC_CATEGORY_IDS.has(category.id) && category.score < 8.5)
    .sort((a, b) => a.score - b.score || b.weight - a.weight || b.errorCount - a.errorCount)
    .slice(0, 5)
    .map((category) => ({
      categoryId: category.id,
      title: category.name,
      score: category.score,
      weight: category.weight,
      description: category.managementDescription || category.description,
      recommendation: category.keyFindings[0]?.recommendation || category.recommendation,
      keyFindings: category.keyFindings.slice(0, 3)
    }));
}

function buildManagementSummary({
  weightedScore,
  unweightedScore,
  scoredCategories,
  bestCategory,
  weakestCategory,
  quickWins,
  strategicNextSteps,
  actionItems,
  opportunities
}) {
  if (weightedScore === null || !scoredCategories.length) {
    return {
      headline: 'Reifegrad nicht bewertet',
      summaryText: 'Es liegen keine bewertbaren Reifegrad-Kategorien vor. Der Audit Workspace bleibt die Quelle für Rohdaten und Findings.',
      riskLevel: 'unknown',
      mainStrength: null,
      mainWeakness: null,
      recommendationFocus: null
    };
  }

  const categoryById = new Map(scoredCategories.map((category) => [category.id, category]));
  const technical = categoryById.get('technical-seo');
  const structured = categoryById.get('structured-data');
  const geo = categoryById.get('geo-readiness');
  const security = categoryById.get('security-server');
  let summaryText = `Der Reifegrad ist eine gewichtete Management-Sicht auf ${scoredCategories.length} bewertete Kategorien. Der ungewichtete Kategorie-Durchschnitt liegt bei ${formatScore(unweightedScore)}/10.`;

  if (technical?.score >= 7 && structured?.score < 6) {
    summaryText = 'Die technische Grundlage ist solide, die maschinenlesbare Auszeichnung bleibt jedoch der größte Hebel für GEO- und AI-Search-Sichtbarkeit.';
  } else if (geo?.score < 6) {
    summaryText = 'Die Website ist technisch auswertbar, aber noch nicht konsequent auf maschinenlesbare Antwortfähigkeit und AI-Search-Zitierbarkeit vorbereitet.';
  } else if (technical?.score >= 7 && structured?.score >= 7 && geo?.score >= 7) {
    summaryText = 'Die Website zeigt eine starke technische und maschinenlesbare Grundlage. Die nächsten Hebel liegen in der Priorisierung einzelner Kategorien und offener Findings.';
  } else if (weakestCategory) {
    summaryText = `${weakestCategory.name} ist aktuell der wichtigste Hebel im gewichteten Reifegrad. ${weakestCategory.scoreInterpretation || weakestCategory.recommendation}`;
  }

  if (security?.score !== null && security?.score < 6 && weakestCategory?.id !== 'security-server') {
    summaryText += ' Server-Header bieten zusätzliches Best-Practice-Potenzial, sind aber kein primärer GEO-Hebel.';
  }

  const recommendationFocus = quickWins[0]?.recommendation ||
    strategicNextSteps[0]?.recommendation ||
    weakestCategory?.recommendation ||
    null;

  return {
    headline: `${maturityLabel(weightedScore)}: ${formatScore(weightedScore)}/10 gewichteter Reifegrad`,
    summaryText,
    riskLevel: riskLevelForScore(weightedScore),
    mainStrength: bestCategory ? {
      categoryId: bestCategory.id,
      title: bestCategory.name,
      score: bestCategory.score,
      description: `${bestCategory.name} ist die stärkste bewertete Kategorie.`
    } : null,
    mainWeakness: weakestCategory ? {
      categoryId: weakestCategory.id,
      title: weakestCategory.name,
      score: weakestCategory.score,
      description: weakestCategory.keyFindings[0]?.finding || weakestCategory.recommendation
    } : null,
    recommendationFocus,
    actionItems,
    opportunities
  };
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function priorityRank(priority) {
  return { High: 1, Medium: 2, Low: 3 }[priority] || 4;
}

function effortRank(effort) {
  return { S: 1, M: 2, L: 3, unknown: 4 }[effort] || 4;
}

function normalizeEffort(effort, finding) {
  if (['S', 'M', 'L'].includes(effort)) return effort;
  const text = `${finding.checkId || ''} ${finding.title || ''}`.toLowerCase();
  if (/robots_mentions|ai_bots|open_graph|webmanifest|favicon|html_lang|viewport|security|header|llms/.test(text)) return 'S';
  if (/schema|structured|breadcrumb|title|meta|h1/.test(text)) return 'M';
  return 'unknown';
}

function isQuickWinCandidate(finding, effort) {
  if (effort === 'S') return true;
  if (effort === 'M' && finding.priority !== 'High') return true;
  if (['opportunity', 'best_practice'].includes(String(finding.findingType || '').toLowerCase())) return true;
  return false;
}

function riskLevelForScore(score) {
  if (score === null || score === undefined) return 'unknown';
  if (score < 2) return 'critical';
  if (score < 4) return 'high';
  if (score < 5.5) return 'elevated';
  if (score < 7) return 'medium';
  if (score < 8.5) return 'low';
  return 'very_low';
}

function categoryRecommendation(category) {
  return category?.recommendation || 'Prüfe die betroffenen Findings im Audit Workspace.';
}

function shortenLabel(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatScore(score) {
  return score === null || score === undefined ? 'NA' : String(score);
}
