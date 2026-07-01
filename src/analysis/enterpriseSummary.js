import { loadResultsWithScores } from '../checks/checkEngine.js';

export function buildEnterpriseSummary(db, runId, run = null) {
  const { results, scores } = loadResultsWithScores(db, runId);
  const active = results.filter((row) => ['Warning', 'Error'].includes(row.effectiveStatus || row.status));
  const pageTypeReach = db.prepare(`
    SELECT COALESCE(pageType, 'other') AS pageType, COUNT(*) AS urls
    FROM pages
    WHERE runId = ?
    GROUP BY COALESCE(pageType, 'other')
    ORDER BY urls DESC, pageType ASC
  `).all(runId);
  const templateProblems = active
    .filter((row) => String(row.checkId || '').startsWith('template.'))
    .sort(compareFindings)
    .slice(0, 10)
    .map(findingSummary);
  const geoRisks = active
    .filter((row) => row.auditType === 'geo' || /geo|ai|llm|schema|structured/i.test(`${row.category} ${row.checkId}`))
    .sort(compareFindings)
    .slice(0, 10)
    .map(findingSummary);
  const technicalRisks = active
    .filter((row) => row.auditType !== 'geo' && !String(row.checkId || '').startsWith('template.'))
    .sort(compareFindings)
    .slice(0, 10)
    .map(findingSummary);
  const quickWins = active
    .filter((row) => (row.effort || row.effectiveEffort) === 'S' || row.priority === 'Low')
    .sort(compareFindings)
    .slice(0, 10)
    .map(findingSummary);
  const strategicMeasures = active
    .filter((row) => ['High', 'Medium'].includes(row.effectivePriority || row.priority || 'Medium'))
    .sort(compareFindings)
    .slice(0, 8)
    .map((row) => ({
      area: row.category,
      checkId: row.checkId,
      recommendation: row.effectiveRecommendation || row.recommendation || '',
      affectedCount: row.affectedCount || 0
    }));
  const templateReach = db.prepare(`
    SELECT clusterKey, pageType, urlPattern, urlCount, sampleUrlsJson
    FROM template_clusters
    WHERE runId = ?
    ORDER BY urlCount DESC, clusterKey ASC
    LIMIT 20
  `).all(runId).map((row) => ({
    ...row,
    sampleUrls: safeJson(row.sampleUrlsJson, [])
  }));

  return {
    runId,
    domain: run?.finalDomain || run?.inputDomain || null,
    sourceType: run?.sourceType || 'crawl',
    crawlScaleMode: run?.crawlScaleMode || null,
    storageProfile: run?.storageProfile || null,
    scores,
    overview: {
      processedUrls: run?.processedUrls || null,
      successfulUrls: run?.successfulUrls || null,
      activeFindings: active.length,
      highPriorityFindings: active.filter((row) => (row.effectivePriority || row.priority) === 'High').length
    },
    biggestTechnicalRisks: technicalRisks,
    biggestGeoAiRisks: geoRisks,
    biggestTemplateProblems: templateProblems,
    biggestPotentials: active
      .filter((row) => row.normalizedFindingType === 'opportunity' || row.findingType === 'opportunity')
      .sort(compareFindings)
      .slice(0, 10)
      .map(findingSummary),
    quickWins,
    strategicMeasures,
    reachByPageType: pageTypeReach,
    reachByTemplate: templateReach,
    summaryMode: 'pattern_first_large_crawl_ready'
  };
}

function compareFindings(a, b) {
  return priorityRank(a) - priorityRank(b) ||
    statusRank(a) - statusRank(b) ||
    Number(b.affectedCount || 0) - Number(a.affectedCount || 0) ||
    String(a.checkId).localeCompare(String(b.checkId));
}

function priorityRank(row) {
  const value = row.effectivePriority || row.priority;
  if (value === 'High') return 1;
  if (value === 'Medium') return 2;
  return 3;
}

function statusRank(row) {
  const value = row.effectiveStatus || row.status;
  if (value === 'Error') return 1;
  if (value === 'Warning') return 2;
  return 3;
}

function findingSummary(row) {
  return {
    checkId: row.checkId,
    title: row.checkName,
    status: row.effectiveStatus || row.status,
    priority: row.effectivePriority || row.priority,
    findingType: row.normalizedFindingType || row.findingType,
    affectedCount: row.affectedCount || 0,
    sampleUrls: row.sampleUrls || [],
    finding: row.effectiveFinding || row.finding || '',
    recommendation: row.effectiveRecommendation || row.recommendation || ''
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
