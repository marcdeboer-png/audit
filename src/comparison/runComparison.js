import { computeScores } from '../utils/scoring.js';

const ISSUE_STATUSES = new Set(['Warning', 'Error']);
const STATUS_RANK = { OK: 0, NA: 1, Warning: 2, Error: 3 };
const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2 };
const PERFORMANCE_SCORE_THRESHOLD = 0.05;
const LCP_THRESHOLD_MS = 500;
const TBT_THRESHOLD_MS = 100;
const CLS_THRESHOLD = 0.05;

export function compareRuns(db, { baseRunId, compareRunId }) {
  const baseRun = getRun(db, Number(baseRunId));
  const compareRun = getRun(db, Number(compareRunId));
  if (!baseRun || !compareRun) {
    const error = new Error('Both baseRunId and compareRunId must reference existing runs.');
    error.statusCode = 404;
    throw error;
  }

  const warnings = [];
  const baseDomain = normalizedDomain(baseRun.finalDomain || baseRun.inputDomain);
  const compareDomain = normalizedDomain(compareRun.finalDomain || compareRun.inputDomain);
  if (baseDomain !== compareDomain) {
    const warning = 'Runs belong to different domains; finding, URL, template and performance deltas are not comparable.';
    return {
      status: 'not_comparable',
      baseRun,
      compareRun,
      scheduleContext: scheduleContextForRuns(baseRun, compareRun),
      baseRunId: baseRun.id,
      compareRunId: compareRun.id,
      baseDomain: baseRun.finalDomain || baseRun.inputDomain,
      compareDomain: compareRun.finalDomain || compareRun.inputDomain,
      comparisonWarning: warning,
      warnings: [warning],
      summary: {
        baseRunId: baseRun.id,
        compareRunId: compareRun.id,
        baseDomain: baseRun.finalDomain || baseRun.inputDomain,
        compareDomain: compareRun.finalDomain || compareRun.inputDomain,
        notComparableReason: 'different_domain'
      },
      findingsDelta: [],
      urlDelta: [],
      templateDelta: [],
      performanceDelta: [],
      regressionFindings: []
    };
  }
  if (baseRun.status !== 'completed' || compareRun.status !== 'completed') {
    warnings.push('One or both runs are not completed; comparison may be incomplete.');
  }
  if (baseRun.auditType !== compareRun.auditType) {
    warnings.push(`Audit types differ (${baseRun.auditType} vs ${compareRun.auditType}); finding coverage may not be comparable.`);
  }
  if (baseRun.maxUrls !== compareRun.maxUrls || baseRun.maxDepth !== compareRun.maxDepth) {
    warnings.push('Crawl configuration differs; URL and issue deltas may reflect crawl scope changes.');
  }
  if (
    baseRun.enablePlaywrightSampling !== compareRun.enablePlaywrightSampling ||
    baseRun.enableLighthouseSampling !== compareRun.enableLighthouseSampling ||
    baseRun.sampleUrlsPerTemplate !== compareRun.sampleUrlsPerTemplate
  ) {
    warnings.push('Sampling configuration differs; template performance deltas may be less comparable.');
  }

  const baseFindings = loadFindings(db, baseRun.id);
  const compareFindings = loadFindings(db, compareRun.id);
  const basePages = loadPages(db, baseRun.id);
  const comparePages = loadPages(db, compareRun.id);
  const baseTemplates = loadTemplates(db, baseRun.id);
  const compareTemplates = loadTemplates(db, compareRun.id);
  const basePerformance = loadPerformance(db, baseRun.id);
  const comparePerformance = loadPerformance(db, compareRun.id);
  const findingsDelta = compareFindingsDelta(baseFindings, compareFindings);
  const urlDelta = compareUrlDelta(basePages, comparePages);
  const templateDelta = compareTemplateDelta(baseTemplates, compareTemplates);
  const performanceDelta = comparePerformanceDelta(basePerformance, comparePerformance);
  const baseScores = computeScores(baseFindings);
  const compareScores = computeScores(compareFindings);
  const regressionFindings = buildRegressionFindings({ findingsDelta, urlDelta, performanceDelta, baseScores, compareScores });
  const summary = buildSummary({
    baseRun,
    compareRun,
    baseFindings,
    compareFindings,
    basePages,
    comparePages,
    findingsDelta,
    urlDelta,
    templateDelta,
    performanceDelta,
    baseScores,
    compareScores,
    regressionFindings
  });

  return {
    status: 'completed',
    baseRun,
    compareRun,
    scheduleContext: scheduleContextForRuns(baseRun, compareRun),
    baseRunId: baseRun.id,
    compareRunId: compareRun.id,
    baseDomain: baseRun.finalDomain || baseRun.inputDomain,
    compareDomain: compareRun.finalDomain || compareRun.inputDomain,
    comparisonWarning: warnings.length ? warnings.join(' ') : null,
    warnings,
    summary,
    findingsDelta,
    urlDelta,
    templateDelta,
    performanceDelta,
    regressionFindings
  };
}

export function compareFindingsDelta(baseRows, compareRows) {
  const baseMap = groupFindings(baseRows);
  const compareMap = groupFindings(compareRows);
  const keys = [...new Set([...baseMap.keys(), ...compareMap.keys()])].sort();

  return keys.map((key) => {
    const base = baseMap.get(key) || null;
    const compare = compareMap.get(key) || null;
    const sampleDiff = diffSamples(base?.sampleUrls || [], compare?.sampleUrls || []);
    const deltaType = findingDeltaType(base, compare);
    return {
      key,
      checkId: compare?.checkId || base?.checkId || '',
      category: compare?.category || base?.category || '',
      checkName: compare?.checkName || base?.checkName || '',
      reportGroupingKey: compare?.reportGroupingKey || base?.reportGroupingKey || '',
      findingType: compare?.findingType || base?.findingType || '',
      baseStatus: base?.status || 'missing',
      compareStatus: compare?.status || 'missing',
      basePriority: base?.priority || '',
      comparePriority: compare?.priority || '',
      baseScore: base?.score ?? null,
      compareScore: compare?.score ?? null,
      baseAffectedCount: base?.affectedCount || 0,
      compareAffectedCount: compare?.affectedCount || 0,
      affectedDelta: (compare?.affectedCount || 0) - (base?.affectedCount || 0),
      deltaType,
      baseFinding: base?.finding || '',
      compareFinding: compare?.finding || '',
      baseRecommendation: base?.recommendation || '',
      compareRecommendation: compare?.recommendation || '',
      baseEvidenceSummary: evidenceSummary(base?.evidence),
      compareEvidenceSummary: evidenceSummary(compare?.evidence),
      sampleUrlsAdded: sampleDiff.added,
      sampleUrlsRemoved: sampleDiff.removed,
      sampleUrlsStillAffected: sampleDiff.stillAffected,
      reviewRecommended: Boolean(compare?.reviewRecommended || base?.reviewRecommended),
      confidence: compare?.confidence || base?.confidence || '',
      compareReviewStatus: compare?.reviewStatus || 'unreviewed',
      baseReviewStatus: base?.reviewStatus || 'unreviewed',
      reviewChanged: Boolean(base && compare && (base.reviewStatus || 'unreviewed') !== (compare.reviewStatus || 'unreviewed'))
    };
  });
}

export function compareUrlDelta(baseRows, compareRows) {
  const baseMap = new Map(baseRows.map((row) => [row.normalizedUrl || row.url, row]));
  const compareMap = new Map(compareRows.map((row) => [row.normalizedUrl || row.url, row]));
  const keys = [...new Set([...baseMap.keys(), ...compareMap.keys()])].sort();
  return keys.map((key) => {
    const base = baseMap.get(key) || null;
    const compare = compareMap.get(key) || null;
    return {
      url: compare?.url || base?.url || key,
      deltaType: urlDeltaType(base, compare),
      baseStatusCode: base?.statusCode ?? null,
      compareStatusCode: compare?.statusCode ?? null,
      baseIndexable: boolValue(base?.indexable),
      compareIndexable: boolValue(compare?.indexable),
      baseTitle: base?.title || '',
      compareTitle: compare?.title || '',
      baseCanonical: base?.canonical || '',
      compareCanonical: compare?.canonical || '',
      basePageType: base?.pageType || '',
      comparePageType: compare?.pageType || ''
    };
  });
}

export function compareTemplateDelta(baseRows, compareRows) {
  const baseMap = new Map(baseRows.map((row) => [row.clusterKey, row]));
  const compareMap = new Map(compareRows.map((row) => [row.clusterKey, row]));
  const keys = [...new Set([...baseMap.keys(), ...compareMap.keys()])].sort();
  return keys.map((key) => {
    const base = baseMap.get(key) || null;
    const compare = compareMap.get(key) || null;
    const baseAvgWordCount = numberOrNull(base?.avgWordCount);
    const compareAvgWordCount = numberOrNull(compare?.avgWordCount);
    return {
      templateClusterKey: key,
      deltaType: templateDeltaType(base, compare),
      baseUrlCount: base?.urlCount || 0,
      compareUrlCount: compare?.urlCount || 0,
      urlCountDelta: (compare?.urlCount || 0) - (base?.urlCount || 0),
      baseIndexableCount: base?.indexableCount || 0,
      compareIndexableCount: compare?.indexableCount || 0,
      baseAvgWordCount,
      compareAvgWordCount,
      avgWordCountDelta: compareAvgWordCount !== null && baseAvgWordCount !== null ? Number((compareAvgWordCount - baseAvgWordCount).toFixed(2)) : null,
      baseSchemaTypesSummary: base?.schemaTypesSummaryJson || '',
      compareSchemaTypesSummary: compare?.schemaTypesSummaryJson || ''
    };
  });
}

export function comparePerformanceDelta(baseRows, compareRows) {
  const baseMap = new Map(baseRows.map((row) => [row.templateClusterKey, row]));
  const compareMap = new Map(compareRows.map((row) => [row.templateClusterKey, row]));
  const keys = [...new Set([...baseMap.keys(), ...compareMap.keys()])].sort();
  return keys.map((key) => {
    const base = baseMap.get(key) || null;
    const compare = compareMap.get(key) || null;
    const row = {
      templateClusterKey: key,
      baseAvgPerformanceScore: numberOrNull(base?.avgPerformanceScore),
      compareAvgPerformanceScore: numberOrNull(compare?.avgPerformanceScore),
      baseMinPerformanceScore: numberOrNull(base?.minPerformanceScore),
      compareMinPerformanceScore: numberOrNull(compare?.minPerformanceScore),
      baseAvgSeoScore: numberOrNull(base?.avgSeoScore),
      compareAvgSeoScore: numberOrNull(compare?.avgSeoScore),
      baseMinSeoScore: numberOrNull(base?.minSeoScore),
      compareMinSeoScore: numberOrNull(compare?.minSeoScore),
      baseAvgLcpMs: numberOrNull(base?.avgLcpMs),
      compareAvgLcpMs: numberOrNull(compare?.avgLcpMs),
      baseAvgTbtMs: numberOrNull(base?.avgTbtMs),
      compareAvgTbtMs: numberOrNull(compare?.avgTbtMs),
      baseAvgCls: numberOrNull(base?.avgCls),
      compareAvgCls: numberOrNull(compare?.avgCls),
      baseJsRequiredCount: base?.jsRequiredCount || 0,
      compareJsRequiredCount: compare?.jsRequiredCount || 0,
      baseConsoleErrorSampleCount: base?.consoleErrorSampleCount || 0,
      compareConsoleErrorSampleCount: compare?.consoleErrorSampleCount || 0,
      baseLighthouseSuccessCount: base?.lighthouseSuccessCount || 0,
      compareLighthouseSuccessCount: compare?.lighthouseSuccessCount || 0
    };
    row.performanceScoreDelta = nullableDelta(row.baseAvgPerformanceScore, row.compareAvgPerformanceScore);
    row.lcpDeltaMs = nullableDelta(row.baseAvgLcpMs, row.compareAvgLcpMs);
    row.tbtDeltaMs = nullableDelta(row.baseAvgTbtMs, row.compareAvgTbtMs);
    row.clsDelta = nullableDelta(row.baseAvgCls, row.compareAvgCls);
    row.deltaType = performanceDeltaType(base, compare, row);
    return row;
  });
}

function getRun(db, runId) {
  return db.prepare(`
    SELECT
      r.*,
      p.inputDomain,
      p.finalDomain,
      p.brandName,
      sr.name AS scheduleName,
      sr.baselineMode AS scheduleBaselineMode,
      sr.autoCompare AS scheduleAutoCompare
    FROM runs r
    JOIN projects p ON p.id = r.projectId
    LEFT JOIN scheduled_runs sr ON sr.id = r.scheduledRunId
    WHERE r.id = ?
  `).get(runId) || null;
}

function scheduleContextForRuns(baseRun, compareRun) {
  if (!baseRun?.scheduledRunId || !compareRun?.scheduledRunId) return null;
  if (baseRun.scheduledRunId !== compareRun.scheduledRunId) return null;
  return {
    scheduledRunId: baseRun.scheduledRunId,
    scheduleName: compareRun.scheduleName || baseRun.scheduleName || null,
    triggerType: compareRun.triggerType || null,
    baselineMode: compareRun.scheduleBaselineMode || null,
    autoCompare: Boolean(compareRun.scheduleAutoCompare)
  };
}

function loadFindings(db, runId) {
  return db.prepare(`
    SELECT
      cr.*,
      COALESCE(fr.reviewStatus, 'unreviewed') AS reviewStatus,
      COALESCE(fr.actionStatus, 'open') AS actionStatus
    FROM check_results cr
    LEFT JOIN finding_reviews fr ON fr.checkResultId = cr.id
    WHERE cr.runId = ?
    ORDER BY cr.checkId ASC
  `).all(runId).map((row) => ({
    ...row,
    auditType: row.checkId.startsWith('geo.') ? 'geo' : 'tech',
    sampleUrls: safeJson(row.sampleUrlsJson, []),
    evidence: safeJson(row.evidenceJson, {}),
    reviewRecommended: Boolean(row.reviewRecommended)
  }));
}

function loadPages(db, runId) {
  return db.prepare(`
    SELECT normalizedUrl, url, statusCode, indexable, title, canonical, pageType
    FROM pages
    WHERE runId = ?
    ORDER BY normalizedUrl ASC
  `).all(runId);
}

function loadTemplates(db, runId) {
  return db.prepare(`
    SELECT clusterKey, urlCount, indexableCount, avgWordCount, schemaTypesSummaryJson
    FROM template_clusters
    WHERE runId = ?
    ORDER BY clusterKey ASC
  `).all(runId);
}

function loadPerformance(db, runId) {
  return db.prepare(`
    SELECT *
    FROM template_performance_summary
    WHERE runId = ?
    ORDER BY templateClusterKey ASC
  `).all(runId);
}

function buildSummary({
  baseRun,
  compareRun,
  baseFindings,
  compareFindings,
  basePages,
  comparePages,
  findingsDelta,
  urlDelta,
  templateDelta,
  performanceDelta,
  baseScores,
  compareScores,
  regressionFindings
}) {
  const baseCounts = findingCounts(baseFindings);
  const compareCounts = findingCounts(compareFindings);
  const baseIndexableUrls = basePages.filter((row) => row.indexable).length;
  const compareIndexableUrls = comparePages.filter((row) => row.indexable).length;
  const deltaCounts = countBy(findingsDelta, 'deltaType');
  const urlDeltaCounts = countBy(urlDelta, 'deltaType');
  const templateDeltaCounts = countBy(templateDelta, 'deltaType');
  const performanceDeltaCounts = countBy(performanceDelta, 'deltaType');
  return {
    baseRunId: baseRun.id,
    compareRunId: compareRun.id,
    baseDomain: baseRun.finalDomain || baseRun.inputDomain,
    compareDomain: compareRun.finalDomain || compareRun.inputDomain,
    baseScores,
    compareScores,
    overallScoreDelta: nullableDelta(baseScores.overallScore, compareScores.overallScore),
    techScoreDelta: nullableDelta(baseScores.techScore, compareScores.techScore),
    geoScoreDelta: nullableDelta(baseScores.geoScore, compareScores.geoScore),
    processedUrlsDelta: Number(compareRun.processedUrls || 0) - Number(baseRun.processedUrls || 0),
    successfulUrlsDelta: Number(compareRun.successfulUrls || 0) - Number(baseRun.successfulUrls || 0),
    failedUrlsDelta: Number(compareRun.failedUrls || 0) - Number(baseRun.failedUrls || 0),
    indexableUrlsDelta: compareIndexableUrls - baseIndexableUrls,
    warningCountDelta: compareCounts.warningCount - baseCounts.warningCount,
    errorCountDelta: compareCounts.errorCount - baseCounts.errorCount,
    reviewRecommendedDelta: compareCounts.reviewRecommendedCount - baseCounts.reviewRecommendedCount,
    coreIssuesDelta: compareCounts.coreIssues - baseCounts.coreIssues,
    geoOpportunitiesDelta: compareCounts.geoOpportunities - baseCounts.geoOpportunities,
    securityBestPracticesDelta: compareCounts.securityBestPractices - baseCounts.securityBestPractices,
    mediaFindingsDelta: compareCounts.mediaFindings - baseCounts.mediaFindings,
    templatePerformanceFindingsDelta: compareCounts.templatePerformanceFindings - baseCounts.templatePerformanceFindings,
    findingDeltaCounts: deltaCounts,
    urlDeltaCounts,
    templateDeltaCounts,
    performanceDeltaCounts,
    regressionFindingCount: regressionFindings.length
  };
}

function findingCounts(rows) {
  const active = rows.filter((row) => ISSUE_STATUSES.has(row.status) && !['false_positive', 'ignored'].includes(row.reviewStatus));
  return {
    warningCount: active.filter((row) => row.status === 'Warning').length,
    errorCount: active.filter((row) => row.status === 'Error').length,
    reviewRecommendedCount: rows.filter((row) => row.reviewRecommended).length,
    coreIssues: active.filter((row) => (row.findingType || 'core_issue') === 'core_issue').length,
    geoOpportunities: active.filter((row) => row.auditType === 'geo' && (row.findingType === 'opportunity' || /geo/i.test(row.category))).length,
    securityBestPractices: active.filter((row) => /security/i.test(row.category) || row.findingType === 'best_practice').length,
    mediaFindings: active.filter((row) => /media/i.test(row.category)).length,
    templatePerformanceFindings: active.filter((row) => /template performance|javascript & rendering/i.test(row.category) || row.checkId.startsWith('template.')).length
  };
}

function buildRegressionFindings({ findingsDelta, urlDelta, performanceDelta, baseScores, compareScores }) {
  const findings = [];
  const newHigh = findingsDelta.filter((row) => row.deltaType === 'new' && row.comparePriority === 'High');
  if (newHigh.length) {
    findings.push(regressionFinding('regression.new_high_priority_issue', 'New high-priority issues', `${newHigh.length} new high-priority issue(s) detected.`, { count: newHigh.length, checkIds: newHigh.map((row) => row.checkId).slice(0, 20) }));
  }
  const scoreDelta = nullableDelta(baseScores.overallScore, compareScores.overallScore);
  if (scoreDelta !== null && scoreDelta <= -5) {
    findings.push(regressionFinding('regression.score_drop', 'Score drop', `Overall score dropped by ${Math.abs(scoreDelta)} point(s).`, { baseScore: baseScores.overallScore, compareScore: compareScores.overallScore, delta: scoreDelta }));
  }
  const perfDrops = performanceDelta.filter((row) => row.deltaType === 'performanceRegressed');
  if (perfDrops.length) {
    findings.push(regressionFinding('regression.template_performance_drop', 'Template performance drop', `${perfDrops.length} template performance regression(s) detected.`, { templates: perfDrops.map((row) => row.templateClusterKey).slice(0, 20) }));
  }
  const noindex = urlDelta.filter((row) => row.deltaType === 'becameNoindex');
  if (noindex.length) {
    findings.push(regressionFinding('regression.new_noindex_content_pages', 'New noindex URLs', `${noindex.length} URL(s) became non-indexable.`, { urls: noindex.map((row) => row.url).slice(0, 20) }));
  }
  const resolved = findingsDelta.filter((row) => row.deltaType === 'resolved');
  if (resolved.length) {
    findings.push(regressionFinding('regression.resolved_issues_summary', 'Resolved issues', `${resolved.length} issue(s) resolved.`, { count: resolved.length, checkIds: resolved.map((row) => row.checkId).slice(0, 20) }, 'info'));
  }
  const newServerErrors = urlDelta.filter((row) =>
    ['newUrl', 'statusChanged'].includes(row.deltaType) && Number(row.compareStatusCode || 0) >= 400
  );
  if (newServerErrors.length) {
    findings.push(regressionFinding('regression.new_4xx_or_5xx_pages', 'New 4xx/5xx pages', `${newServerErrors.length} new or changed URL(s) return 4xx/5xx.`, { urls: newServerErrors.map((row) => ({ url: row.url, statusCode: row.compareStatusCode })).slice(0, 20) }));
  }
  return findings;
}

function regressionFinding(id, name, finding, evidence, severity = 'warning') {
  return { id, name, finding, severity, evidence };
}

function groupFindings(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = findingKey(row);
    const existing = map.get(key);
    if (!existing || findingSort(row, existing) < 0) map.set(key, row);
  }
  return map;
}

function findingKey(row) {
  const evidence = row.evidence || {};
  const templateKey = evidence.templateClusterKey || evidence.templateCluster || null;
  return [row.reportGroupingKey || row.checkId, templateKey].filter(Boolean).join('::');
}

function findingSort(a, b) {
  return statusRank(b.status) - statusRank(a.status) ||
    priorityRank(b.priority) - priorityRank(a.priority) ||
    Number(a.score ?? 999) - Number(b.score ?? 999);
}

function findingDeltaType(base, compare) {
  const baseIssue = isIssue(base);
  const compareIssue = isIssue(compare);
  if (!base && !compare) return 'not_comparable';
  if (!baseIssue && compareIssue) return 'new';
  if (baseIssue && !compareIssue) return 'resolved';
  if (baseIssue && compareIssue) {
    const severityDelta = statusRank(compare.status) - statusRank(base.status);
    const priorityDelta = priorityRank(compare.priority) - priorityRank(base.priority);
    const scoreDelta = nullableDelta(base.score, compare.score);
    if (severityDelta > 0 || priorityDelta > 0 || (scoreDelta !== null && scoreDelta < 0)) return 'worsened';
    if (severityDelta < 0 || priorityDelta < 0 || (scoreDelta !== null && scoreDelta > 0)) return 'improved';
    return 'unchanged_issue';
  }
  return 'unchanged_ok';
}

function urlDeltaType(base, compare) {
  if (!base && compare) return 'newUrl';
  if (base && !compare) return 'removedUrl';
  if (!base || !compare) return 'notComparable';
  if (Number(base.statusCode || 0) !== Number(compare.statusCode || 0)) return 'statusChanged';
  if (!base.indexable && compare.indexable) return 'becameIndexable';
  if (base.indexable && !compare.indexable) return 'becameNoindex';
  if ((base.title || '') !== (compare.title || '')) return 'titleChanged';
  if ((base.canonical || '') !== (compare.canonical || '')) return 'canonicalChanged';
  if ((base.pageType || '') !== (compare.pageType || '')) return 'pageTypeChanged';
  return 'unchangedUrl';
}

function templateDeltaType(base, compare) {
  if (!base && compare) return 'newTemplate';
  if (base && !compare) return 'removedTemplate';
  if (!base || !compare) return 'notComparable';
  if (Number(base.urlCount || 0) !== Number(compare.urlCount || 0)) return 'urlCountChanged';
  if (Math.abs(Number(base.avgWordCount || 0) - Number(compare.avgWordCount || 0)) >= 50) return 'avgWordCountChanged';
  if ((base.schemaTypesSummaryJson || '') !== (compare.schemaTypesSummaryJson || '')) return 'schemaCoverageChanged';
  return 'unchangedTemplate';
}

function performanceDeltaType(base, compare, row) {
  if (!base || !compare) return 'notComparable';
  if (!row.baseLighthouseSuccessCount || !row.compareLighthouseSuccessCount) return 'lighthouseUnavailableInOneRun';
  if (row.baseConsoleErrorSampleCount === 0 && row.compareConsoleErrorSampleCount > 0) return 'consoleErrorsNew';
  if (row.baseConsoleErrorSampleCount > 0 && row.compareConsoleErrorSampleCount === 0) return 'consoleErrorsResolved';
  if (Number(row.compareJsRequiredCount || 0) > Number(row.baseJsRequiredCount || 0)) return 'renderingRegressed';
  if (row.performanceScoreDelta !== null && row.performanceScoreDelta <= -PERFORMANCE_SCORE_THRESHOLD) return 'performanceRegressed';
  if (row.performanceScoreDelta !== null && row.performanceScoreDelta >= PERFORMANCE_SCORE_THRESHOLD) return 'performanceImproved';
  if (row.lcpDeltaMs !== null && row.lcpDeltaMs >= LCP_THRESHOLD_MS) return 'performanceRegressed';
  if (row.tbtDeltaMs !== null && row.tbtDeltaMs >= TBT_THRESHOLD_MS) return 'performanceRegressed';
  if (row.clsDelta !== null && row.clsDelta >= CLS_THRESHOLD) return 'performanceRegressed';
  if (
    (row.lcpDeltaMs !== null && row.lcpDeltaMs <= -LCP_THRESHOLD_MS) ||
    (row.tbtDeltaMs !== null && row.tbtDeltaMs <= -TBT_THRESHOLD_MS) ||
    (row.clsDelta !== null && row.clsDelta <= -CLS_THRESHOLD)
  ) return 'performanceImproved';
  return 'notComparable';
}

function isIssue(row) {
  return row && ISSUE_STATUSES.has(row.status);
}

function statusRank(value) {
  return STATUS_RANK[value] ?? -1;
}

function priorityRank(value) {
  return PRIORITY_RANK[value] ?? -1;
}

function diffSamples(baseSamples, compareSamples) {
  const base = new Set((baseSamples || []).filter(Boolean));
  const compare = new Set((compareSamples || []).filter(Boolean));
  return {
    added: [...compare].filter((url) => !base.has(url)).slice(0, 50),
    removed: [...base].filter((url) => !compare.has(url)).slice(0, 50),
    stillAffected: [...compare].filter((url) => base.has(url)).slice(0, 50)
  };
}

function evidenceSummary(evidence = {}) {
  if (!evidence || typeof evidence !== 'object') return {};
  const keys = Object.keys(evidence);
  const summary = { keys };
  for (const key of keys.slice(0, 8)) {
    const value = evidence[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) summary[key] = value;
    else if (Array.isArray(value)) summary[key] = { items: value.length };
    else if (typeof value === 'object') summary[key] = { keys: Object.keys(value).slice(0, 10) };
  }
  return summary;
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = row[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function boolValue(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableDelta(base, compare) {
  if (base === null || base === undefined || compare === null || compare === undefined) return null;
  const baseNumber = Number(base);
  const compareNumber = Number(compare);
  if (!Number.isFinite(baseNumber) || !Number.isFinite(compareNumber)) return null;
  return Number((compareNumber - baseNumber).toFixed(3));
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizedDomain(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return input.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}
