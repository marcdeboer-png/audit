import { once } from 'node:events';
import { applyDisplaySemantics } from '../reviews/displaySemantics.js';
import { createRunScope, requireRunId, scopeSafeCheckResult } from '../scope/runScope.js';
import { loadResultsWithScores } from '../checks/checkEngine.js';

const EXPORTS = {
  findings: {
    filename: (runId) => `run-${runId}-findings.csv`,
    columns: [
      'checkId', 'title', 'category',
      'displayStatus', 'displayPriority', 'displayFindingType',
      'displayReviewStatus', 'displayActionStatus',
      'affectedCount', 'recommendation',
      'rawStatus', 'rawPriority', 'rawFindingType',
      'confidence', 'reportSection', 'reviewRecommended', 'evidenceJson', 'sampleUrls',
      'evaluationState', 'scoreEligible', 'scoreExclusionReason', 'requirementsJson',
      'evidenceClass', 'executionStatus', 'evidenceStatus', 'evaluationStatus',
      'coverageStatus', 'coverageUnitKey', 'coverageWeight', 'coverageReason', 'availabilitySemanticsVersion',
      'factsJson', 'assessmentJson', 'recommendationMetaJson', 'scoreDeduplicationKey',
      'rootCauseId', 'rootCauseKey', 'rootCauseFamily', 'scopeType',
      'occurrenceCount', 'affectedUrlCount', 'displayedSampleCount', 'primaryCheckId',
      'deduplicationConfidence', 'deduplicationReason', 'rootCauseMembershipsJson',
      'checkName', 'status', 'priority', 'effort', 'score',
      'finding', 'details', 'evidence',
      'reviewStatus', 'actionStatus', 'reviewerName', 'reviewNote',
      'manualStatus', 'manualPriority', 'manualEffort',
      'effectiveStatus', 'effectivePriority', 'effectiveEffort',
      'effectiveFinding', 'effectiveRecommendation',
      'findingType', 'reportGroupingKey',
      'isActionable', 'normalizedFindingType', 'displayReviewRecommended',
      'maturityImpact', 'dataBasis', 'evidenceLevel', 'reviewReason',
      'automationCoverage', 'interpretation', 'limitations',
      'checkVersion', 'provenanceJson',
      'standardVersion', 'standardStatus', 'standardUsage', 'standardSeverity',
      'standardScoreEffect', 'standardFindingType', 'diagnosticOnly', 'disabled',
      'standardApplicability', 'standardNotApplicableRule', 'standardReviewStatus',
      'standardRollupRole', 'standardPatternRole', 'standardScoreOwnerCheckId'
    ],
    sql: `
      SELECT
        cr.checkId,
        cr.category,
        cr.checkName,
        cr.status,
        cr.priority,
        cr.effort,
        cr.score,
        cr.finding,
        cr.details,
        cr.recommendation,
        cr.affectedCount,
        cr.sampleUrlsJson AS sampleUrls,
        cr.evidenceJson AS evidence,
        cr.factsJson,
        cr.assessmentJson,
        cr.recommendationMetaJson,
        cr.requirementsJson,
        cr.evaluationState,
        cr.evidenceClass,
        cr.executionStatus,
        cr.evidenceStatus,
        cr.evaluationStatus,
        cr.coverageStatus,
        cr.coverageUnitKey,
        cr.coverageWeight,
        cr.coverageReason,
        cr.availabilitySemanticsVersion,
        cr.scoreEligible,
        cr.scoreExclusionReason,
        cr.scoreDeduplicationKey,
        cr.rootCauseId,
        cr.rootCauseKey,
        cr.rootCauseFamily,
        cr.scopeType,
        cr.occurrenceCount,
        cr.affectedUrlCount,
        cr.displayedSampleCount,
        cr.primaryCheckId,
        cr.deduplicationConfidence,
        cr.deduplicationReason,
        cr.rootCauseMembershipsJson,
        COALESCE(fr.reviewStatus, 'unreviewed') AS reviewStatus,
        COALESCE(fr.actionStatus, 'open') AS actionStatus,
        fr.reviewerName,
        fr.note AS reviewNote,
        fr.manualStatus,
        fr.manualPriority,
        fr.manualEffort,
        COALESCE(fr.manualStatus, cr.status) AS effectiveStatus,
        COALESCE(fr.manualPriority, cr.priority) AS effectivePriority,
        COALESCE(fr.manualEffort, cr.effort) AS effectiveEffort,
        COALESCE(fr.manualFinding, cr.finding) AS effectiveFinding,
        COALESCE(fr.manualRecommendation, cr.recommendation) AS effectiveRecommendation,
        cr.confidence,
        cr.reviewRecommended,
        cr.findingType,
        cr.reportGroupingKey,
        cr.maturityImpact,
        cr.dataBasis,
        cr.evidenceLevel,
        cr.reviewReason,
        cr.automationCoverage,
        cr.interpretation,
        cr.limitations,
        cr.checkVersion,
        cr.provenanceJson
      FROM check_results cr
      LEFT JOIN finding_reviews fr ON fr.runId = cr.runId AND fr.checkResultId = cr.id
      WHERE cr.runId = ?
      ORDER BY
        CASE cr.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
        CASE cr.status WHEN 'Error' THEN 1 WHEN 'Warning' THEN 2 WHEN 'OK' THEN 3 ELSE 4 END,
        cr.checkId ASC
    `,
    transform: withDisplaySemantics
  },
  reviews: {
    filename: (runId) => `run-${runId}-reviews.csv`,
    columns: [
      'checkId', 'category', 'checkName',
      'displayStatus', 'displayPriority', 'displayFindingType',
      'originalStatus', 'originalPriority', 'originalEffort',
      'effectiveStatus', 'effectivePriority', 'effectiveEffort',
      'reviewStatus', 'actionStatus', 'reviewerName', 'note',
      'findingType', 'confidence', 'reviewRecommended',
      'affectedCount', 'sampleUrls',
      'displayReviewStatus', 'displayActionStatus',
      'isActionable', 'reportSection', 'normalizedFindingType', 'displayReviewRecommended',
      'standardVersion', 'standardStatus', 'standardUsage', 'standardSeverity',
      'standardScoreEffect', 'standardFindingType', 'diagnosticOnly', 'disabled',
      'standardApplicability', 'standardNotApplicableRule', 'standardReviewStatus',
      'standardRollupRole', 'standardPatternRole', 'standardScoreOwnerCheckId'
    ],
    sql: `
      SELECT
        cr.checkId,
        cr.category,
        cr.checkName,
        cr.status AS originalStatus,
        cr.priority AS originalPriority,
        cr.effort AS originalEffort,
        COALESCE(fr.manualStatus, cr.status) AS effectiveStatus,
        COALESCE(fr.manualPriority, cr.priority) AS effectivePriority,
        COALESCE(fr.manualEffort, cr.effort) AS effectiveEffort,
        COALESCE(fr.reviewStatus, 'unreviewed') AS reviewStatus,
        COALESCE(fr.actionStatus, 'open') AS actionStatus,
        fr.reviewerName,
        fr.note,
        cr.findingType,
        cr.confidence,
        cr.reviewRecommended,
        cr.affectedCount,
        cr.sampleUrlsJson AS sampleUrls
      FROM check_results cr
      LEFT JOIN finding_reviews fr ON fr.runId = cr.runId AND fr.checkResultId = cr.id
      WHERE cr.runId = ?
      ORDER BY
        CASE COALESCE(fr.reviewStatus, 'unreviewed')
          WHEN 'needs_fix' THEN 1
          WHEN 'confirmed' THEN 2
          WHEN 'unreviewed' THEN 3
          WHEN 'accepted_risk' THEN 4
          WHEN 'fixed' THEN 5
          WHEN 'false_positive' THEN 6
          ELSE 7
        END,
        CASE cr.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
        cr.checkId ASC
    `,
    transform: withDisplaySemantics
  },
  pages: {
    filename: (runId) => `run-${runId}-pages.csv`,
    columns: ['url', 'finalUrl', 'statusCode', 'indexable', 'pageType', 'title', 'titleLength', 'metaDescription', 'metaDescriptionLength', 'h1Count', 'canonical', 'htmlLang', 'viewport', 'metaCharset', 'hasHeaderUtf8', 'hasMetaCharsetUtf8', 'metaRobots', 'xRobotsTag', 'wordCountRaw', 'wordCountRendered', 'internalLinksCount', 'externalLinksCount', 'schemaTypes', 'imagesCount', 'imagesWithoutAltCount', 'hasTables', 'hasLists', 'hasFaqPattern', 'hasVisibleDate', 'hasAuthorPattern', 'externalSourceLinksCount', 'hasVideoEmbed', 'loadTimeMs', 'ttfbMs'],
    sql: `
      SELECT url, finalUrl, statusCode, indexable, pageType, title, titleLength,
        metaDescription, metaDescriptionLength, h1Count, canonical, htmlLang,
        viewport, metaCharset, hasHeaderUtf8, hasMetaCharsetUtf8,
        metaRobots, xRobotsTag, wordCountRaw, wordCountRendered,
        internalLinksCount, externalLinksCount, schemaTypesJson AS schemaTypes,
        imagesCount, imagesWithoutAltCount, hasTables, hasLists, hasFaqPattern,
        hasVisibleDate, hasAuthorPattern, externalSourceLinksCount, hasVideoEmbed,
        loadTimeMs, ttfbMs
      FROM pages
      WHERE runId = ?
      ORDER BY id ASC
    `,
    transform: normalizeSchemaTypes
  },
  links: {
    filename: (runId) => `run-${runId}-links.csv`,
    columns: ['sourceUrl', 'targetUrl', 'normalizedTargetUrl', 'linkType', 'anchorText', 'rel', 'statusCode'],
    sql: `
      SELECT sourceUrl, targetUrl, normalizedTargetUrl, linkType, anchorText, rel, statusCode
      FROM page_links
      WHERE runId = ?
      ORDER BY id ASC
    `
  },
  images: {
    filename: (runId) => `run-${runId}-images.csv`,
    columns: ['pageUrl', 'imageUrl', 'alt', 'hasAlt', 'loading', 'width', 'height', 'extension', 'sizeBytes'],
    sql: `
      SELECT pageUrl, imageUrl, alt, hasAlt, loading, width, height, extension, sizeBytes
      FROM page_images
      WHERE runId = ?
      ORDER BY id ASC
    `
  },
  resources: {
    filename: (runId) => `run-${runId}-resources.csv`,
    columns: ['pageUrl', 'resourceUrl', 'resourceType', 'statusCode', 'sizeBytes', 'contentType', 'isThirdParty'],
    sql: `
      SELECT pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty
      FROM resources
      WHERE runId = ?
      ORDER BY id ASC
    `
  },
  'render-runtime': {
    filename: (runId) => `run-${runId}-render-runtime.csv`,
    columns: [
      'url', 'pageType', 'rawContentClass', 'templateClusterKey', 'renderStrategy', 'renderNeed', 'renderDecision',
      'renderConfidence', 'resultingBrowserRun', 'rawFetchDurationMs', 'browserNavigationDurationMs',
      'settlingDurationMs', 'snapshotCount', 'extractionDurationMs', 'persistenceDurationMs',
      'totalUrlDurationMs', 'rawHtmlBytes', 'renderProvenanceBytes', 'networkRequestCount',
      'failedRequestCount', 'finalSettlingStatus', 'renderStatus', 'measurementError',
      'renderDecisionReasonJson', 'renderSignalsJson', 'renderNegativeSignalsJson',
      'renderSignalContributionsJson', 'renderRecommendationScore', 'renderRecommendationThreshold',
      'renderCheckRequirementsJson', 'renderUnmetPrerequisitesJson',
      'requestedCheckFamiliesJson', 'budgetStatusJson', 'metricsVersion'
    ],
    sql: `
      SELECT url,pageType,rawContentClass,templateClusterKey,renderStrategy,renderNeed,renderDecision,
        renderConfidence,resultingBrowserRun,rawFetchDurationMs,browserNavigationDurationMs,
        settlingDurationMs,snapshotCount,extractionDurationMs,persistenceDurationMs,
        totalUrlDurationMs,rawHtmlBytes,renderProvenanceBytes,networkRequestCount,
        failedRequestCount,finalSettlingStatus,renderStatus,measurementError,
        renderDecisionReasonJson,renderSignalsJson,renderNegativeSignalsJson,
        renderSignalContributionsJson,renderRecommendationScore,renderRecommendationThreshold,
        renderCheckRequirementsJson,renderUnmetPrerequisitesJson,
        requestedCheckFamiliesJson,budgetStatusJson,metricsVersion
      FROM url_runtime_metrics WHERE runId=? ORDER BY url
    `
  },
  schemas: {
    filename: (runId) => `run-${runId}-schemas.csv`,
    columns: ['pageUrl', 'schemaType', 'parseStatus', 'parseError'],
    sql: `
      SELECT pageUrl, schemaType, parseStatus, parseError
      FROM schemas
      WHERE runId = ?
      ORDER BY id ASC
    `
  },
  'geo-signals': {
    filename: (runId) => `run-${runId}-geo-signals.csv`,
    columns: ['url', 'pageType', 'hasTables', 'hasLists', 'hasFaqPattern', 'hasVisibleDate', 'hasAuthorPattern', 'externalSourceLinksCount', 'hasVideoEmbed', 'schemaTypes', 'hasOrganization', 'hasWebsite', 'hasBreadcrumbList', 'hasFAQPage', 'hasArticle', 'hasProduct', 'hasPerson', 'hasSpeakable'],
    sql: `
      SELECT
        url, pageType, hasTables, hasLists, hasFaqPattern, hasVisibleDate,
        hasAuthorPattern, externalSourceLinksCount, hasVideoEmbed,
        schemaTypesJson AS schemaTypes,
        CASE WHEN schemaTypesJson LIKE '%Organization%' THEN 1 ELSE 0 END AS hasOrganization,
        CASE WHEN schemaTypesJson LIKE '%WebSite%' THEN 1 ELSE 0 END AS hasWebsite,
        CASE WHEN schemaTypesJson LIKE '%BreadcrumbList%' THEN 1 ELSE 0 END AS hasBreadcrumbList,
        CASE WHEN schemaTypesJson LIKE '%FAQPage%' THEN 1 ELSE 0 END AS hasFAQPage,
        CASE WHEN schemaTypesJson LIKE '%Article%' THEN 1 ELSE 0 END AS hasArticle,
        CASE WHEN schemaTypesJson LIKE '%Product%' THEN 1 ELSE 0 END AS hasProduct,
        CASE WHEN schemaTypesJson LIKE '%Person%' THEN 1 ELSE 0 END AS hasPerson,
        CASE WHEN schemaTypesJson LIKE '%SpeakableSpecification%' THEN 1 ELSE 0 END AS hasSpeakable
      FROM pages
      WHERE runId = ?
      ORDER BY id ASC
    `,
    transform: normalizeSchemaTypes
  },
  'status-summary': {
    filename: (runId) => `run-${runId}-status-summary.csv`,
    columns: ['statusCode', 'count', 'percentage'],
    sql: `
      SELECT COALESCE(statusCode, 0) AS statusCode, COUNT(*) AS count
      FROM pages
      WHERE runId = ?
      GROUP BY COALESCE(statusCode, 0)
      ORDER BY statusCode ASC
    `,
    transform(row, context) {
      const total = context.totalPages || 0;
      return {
        ...row,
        percentage: total ? Number(((row.count / total) * 100).toFixed(2)) : 0
      };
    }
  },
  templates: {
    filename: (runId) => `run-${runId}-templates.csv`,
    columns: ['clusterKey', 'pageType', 'urlPattern', 'urlCount', 'indexableCount', 'nonIndexableCount', 'statusCodeSummary', 'schemaTypesSummary', 'avgWordCount', 'avgInternalLinks', 'avgExternalLinks', 'sampleUrls'],
    sql: `
      SELECT clusterKey, pageType, urlPattern, urlCount, indexableCount,
        nonIndexableCount, statusCodeSummaryJson AS statusCodeSummary,
        schemaTypesSummaryJson AS schemaTypesSummary, avgWordCount,
        avgInternalLinks, avgExternalLinks, sampleUrlsJson AS sampleUrls
      FROM template_clusters
      WHERE runId = ?
      ORDER BY urlCount DESC, clusterKey ASC
    `,
    transform: normalizeTemplateCluster
  },
  samples: {
    filename: (runId) => `run-${runId}-samples.csv`,
    columns: ['templateClusterKey', 'url', 'finalUrl', 'sampleReason', 'playwrightStatus', 'lighthouseStatus', 'errorMessage'],
    sql: `
      SELECT templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
      FROM template_sample_results
      WHERE runId = ?
      ORDER BY templateClusterKey ASC, id ASC
    `
  },
  'playwright-results': {
    filename: (runId) => `run-${runId}-playwright-results.csv`,
    columns: ['templateClusterKey', 'url', 'status', 'finalUrl', 'title', 'h1Count', 'renderedWordCount', 'renderedLinksCount', 'rawRenderedWordDelta', 'consoleErrorsCount', 'networkErrorsCount', 'jsRequiredLikely', 'loadTimeMs', 'settlingStatus', 'settlingDurationMs', 'renderSnapshotCount', 'renderFingerprint', 'renderProvenanceVersion', 'settlingPolicyVersion', 'initialRenderedStateJson', 'settledRenderedStateJson', 'renderProvenanceJson', 'browserEventsJson', 'screenshotPath'],
    sql: `
      SELECT templateClusterKey, url, status, finalUrl, title, h1Count,
        renderedWordCount, renderedLinksCount, rawRenderedWordDelta,
        consoleErrorsCount, networkErrorsCount, jsRequiredLikely,
        loadTimeMs, settlingStatus, settlingDurationMs, renderSnapshotCount,
        renderFingerprint, renderProvenanceVersion, settlingPolicyVersion,
        initialRenderedStateJson, settledRenderedStateJson, renderProvenanceJson,
        browserEventsJson, screenshotPath
      FROM playwright_results
      WHERE runId = ?
      ORDER BY templateClusterKey ASC, id ASC
    `
  },
  'render-provenance': {
    filename: (runId) => `run-${runId}-render-provenance.csv`,
    columns: ['url', 'renderStatus', 'settlingStatus', 'settlingDurationMs', 'renderSnapshotCount', 'renderFingerprint', 'renderProvenanceVersion', 'settlingPolicyVersion', 'metadataProvenanceComplete', 'effectiveTitle', 'effectiveMetaDescription', 'effectiveCanonical', 'effectiveHtmlLang', 'effectiveMetaRobots', 'effectiveH1Count', 'effectiveWordCount', 'effectiveMainWordCount', 'effectiveInternalLinksCount', 'effectiveOgJson', 'effectiveTwitterJson', 'effectiveHreflangJson', 'effectiveSchemaTypesJson', 'rawDocumentStateJson', 'initialRenderedStateJson', 'settledRenderedStateJson', 'effectiveDocumentStateJson', 'renderProvenanceJson', 'browserEventsJson'],
    sql: `
      SELECT url, renderStatus, settlingStatus, settlingDurationMs, renderSnapshotCount,
        renderFingerprint, renderProvenanceVersion, settlingPolicyVersion,
        metadataProvenanceComplete, effectiveTitle, effectiveMetaDescription,
        effectiveCanonical, effectiveHtmlLang, effectiveMetaRobots, effectiveH1Count,
        effectiveWordCount, effectiveMainWordCount, effectiveInternalLinksCount,
        effectiveOgJson, effectiveTwitterJson, effectiveHreflangJson,
        effectiveSchemaTypesJson, rawDocumentStateJson, initialRenderedStateJson,
        settledRenderedStateJson, effectiveDocumentStateJson, renderProvenanceJson,
        browserEventsJson
      FROM pages WHERE runId = ? ORDER BY id ASC
    `
  },
  'lighthouse-results': {
    filename: (runId) => `run-${runId}-lighthouse-results.csv`,
    columns: ['templateClusterKey', 'url', 'device', 'performanceScore', 'accessibilityScore', 'bestPracticesScore', 'seoScore', 'firstContentfulPaintMs', 'largestContentfulPaintMs', 'totalBlockingTimeMs', 'cumulativeLayoutShift', 'speedIndexMs', 'interactiveMs', 'totalByteWeight', 'domSize', 'errorMessage'],
    sql: `
      SELECT templateClusterKey, url, device, performanceScore, accessibilityScore,
        bestPracticesScore, seoScore, firstContentfulPaintMs, largestContentfulPaintMs,
        totalBlockingTimeMs, cumulativeLayoutShift, speedIndexMs, interactiveMs,
        totalByteWeight, domSize, errorMessage
      FROM lighthouse_results
      WHERE runId = ?
      ORDER BY templateClusterKey ASC, id ASC
    `
  },
  'template-performance': {
    filename: (runId) => `run-${runId}-template-performance.csv`,
    columns: ['templateClusterKey', 'sampleCount', 'playwrightSuccessCount', 'lighthouseSuccessCount', 'avgPerformanceScore', 'minPerformanceScore', 'avgSeoScore', 'minSeoScore', 'avgAccessibilityScore', 'avgBestPracticesScore', 'avgLcpMs', 'avgTbtMs', 'avgCls', 'jsRequiredCount', 'consoleErrorSampleCount', 'worstSampleUrls'],
    sql: `
      SELECT templateClusterKey, sampleCount, playwrightSuccessCount,
        lighthouseSuccessCount, avgPerformanceScore, minPerformanceScore,
        avgSeoScore, minSeoScore, avgAccessibilityScore, avgBestPracticesScore,
        avgLcpMs, avgTbtMs, avgCls, jsRequiredCount, consoleErrorSampleCount,
        worstSampleUrlsJson AS worstSampleUrls
      FROM template_performance_summary
      WHERE runId = ?
      ORDER BY
        CASE WHEN minPerformanceScore IS NULL THEN 1 ELSE 0 END,
        minPerformanceScore ASC,
        templateClusterKey ASC
    `,
    transform: normalizeTemplatePerformance
  },
  'score-root-causes': {
    filename: (runId) => `run-${runId}-score-root-causes.csv`,
    columns: [
      'scoringVersion', 'deduplicationVersion', 'coverageModelVersion', 'availabilitySemanticsVersion', 'checkLogicVersion',
      'scoreStatus', 'score', 'diagnosticScore', 'weightedCoverage', 'primaryCoverage',
      'diagnosticCoverage', 'inventoryCoverage', 'renderRequiredCoverage',
      'rawFindingCount', 'scoredFindingCount', 'rootCauseCount', 'deduplicatedFindingCount',
      'rawPenaltyTotal', 'appliedPenaltyTotal', 'capsAppliedJson',
      'rootCauseId', 'rootCauseKey', 'rootCauseFamily', 'category', 'severity', 'confidence',
      'scopeType', 'occurrenceCount', 'affectedUrlCount', 'displayedSampleCount',
      'primaryCheckId', 'relatedCheckIds', 'deduplicationConfidence', 'deduplicationReason',
      'basePenalty', 'scopeFactor', 'confidenceFactor', 'rawPenalty', 'appliedPenalty', 'rootCapsAppliedJson'
    ],
    rows: scoreRootCauseRows
  },
  'coverage-units': {
    filename: (runId) => `run-${runId}-coverage-units.csv`,
    columns: [
      'coverageModelVersion', 'availabilitySemanticsVersion', 'scoreStatus',
      'primaryCoverage', 'diagnosticCoverage', 'inventoryCoverage', 'weightedCoverage',
      'coverageUnitKey', 'evidenceClass', 'category', 'weight', 'coverageStatus',
      'checkIdsJson', 'reasonsJson'
    ],
    rows: coverageUnitRows
  }
};

export function listCsvExports() {
  return Object.keys(EXPORTS);
}

export function getCsvExportSpec(type, runId) {
  requireRunId(runId, 'get CSV export spec');
  const spec = EXPORTS[type];
  if (!spec) return null;
  return {
    ...spec,
    filename: spec.filename(runId)
  };
}

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function csvLine(columns, row) {
  return `${columns.map((column) => csvEscape(row[column])).join(',')}\n`;
}

export async function streamCsvExport(db, runId, type, writable) {
  const spec = getCsvExportSpec(type, runId);
  if (!spec) throw new Error(`Unknown CSV export: ${type}`);

  const context = {
    totalPages: db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count || 0,
    scope: exportRunScope(db, runId)
  };

  await write(writable, `${spec.columns.map(csvEscape).join(',')}\n`);
  const sourceRows = spec.rows ? spec.rows(db, runId) : db.prepare(spec.sql).iterate(runId);
  for (const rawRow of sourceRows) {
    const scopedRow = scopeSafeExportRow(rawRow, context.scope);
    const row = spec.transform ? spec.transform(scopedRow, context) : scopedRow;
    await write(writable, csvLine(spec.columns, row));
  }
}

export function collectCsvExport(db, runId, type) {
  requireRunId(runId, 'collect CSV export');
  const spec = getCsvExportSpec(type, runId);
  if (!spec) throw new Error(`Unknown CSV export: ${type}`);
  const context = {
    totalPages: db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count || 0,
    scope: exportRunScope(db, runId)
  };
  const lines = [`${spec.columns.map(csvEscape).join(',')}\n`];
  const sourceRows = spec.rows ? spec.rows(db, runId) : db.prepare(spec.sql).iterate(runId);
  for (const rawRow of sourceRows) {
    const scopedRow = scopeSafeExportRow(rawRow, context.scope);
    const row = spec.transform ? spec.transform(scopedRow, context) : scopedRow;
    lines.push(csvLine(spec.columns, row));
  }
  return lines.join('');
}

function scoreRootCauseRows(db, runId) {
  const scores = loadResultsWithScores(db, runId).scores;
  const breakdown = scores.breakdown || {};
  const common = {
    scoringVersion: scores.scoringVersion || '',
    deduplicationVersion: scores.deduplicationVersion || '',
    coverageModelVersion: scores.coverageModelVersion || '',
    availabilitySemanticsVersion: scores.availabilitySemanticsVersion || '',
    checkLogicVersion: scores.checkLogicVersion || '',
    scoreStatus: scores.scoreStatus || 'historical_unknown',
    score: scores.overallScore,
    diagnosticScore: scores.diagnosticOverallScore ?? breakdown.diagnosticScore ?? '',
    weightedCoverage: scores.weightedCoverage ?? breakdown.weightedCoverage ?? breakdown.dataCoveragePct ?? '',
    primaryCoverage: scores.primaryCoverage ?? breakdown.primaryCoverage ?? '',
    diagnosticCoverage: scores.diagnosticCoverage ?? breakdown.diagnosticCoverage ?? '',
    inventoryCoverage: scores.inventoryCoverage ?? breakdown.inventoryCoverage ?? '',
    renderRequiredCoverage: scores.renderRequiredCoverage ?? breakdown.renderRequiredCoverage ?? '',
    rawFindingCount: breakdown.rawFindingCount ?? breakdown.configuredChecks ?? 0,
    scoredFindingCount: breakdown.scoredFindingCount ?? breakdown.eligibleChecks ?? 0,
    rootCauseCount: breakdown.rootCauseCount ?? 0,
    deduplicatedFindingCount: breakdown.deduplicatedFindingCount ?? breakdown.deduplicatedChecks ?? 0,
    rawPenaltyTotal: breakdown.rawPenalty ?? '',
    appliedPenaltyTotal: breakdown.appliedPenalty ?? '',
    capsAppliedJson: JSON.stringify(breakdown.capsApplied || [])
  };
  const roots = breakdown.rootCauses || [];
  if (!roots.length) return [{ ...common }];
  return roots.map((root) => ({
    ...common,
    ...root,
    relatedCheckIds: JSON.stringify(root.relatedCheckIds || []),
    rootCapsAppliedJson: JSON.stringify(root.capsApplied || [])
  }));
}

function coverageUnitRows(db, runId) {
  const scores = loadResultsWithScores(db, runId).scores;
  const breakdown = scores.breakdown || {};
  const common = {
    coverageModelVersion: scores.coverageModelVersion || '',
    availabilitySemanticsVersion: scores.availabilitySemanticsVersion || '',
    scoreStatus: scores.scoreStatus || 'historical_unknown',
    primaryCoverage: scores.primaryCoverage ?? breakdown.primaryCoverage ?? '',
    diagnosticCoverage: scores.diagnosticCoverage ?? breakdown.diagnosticCoverage ?? '',
    inventoryCoverage: scores.inventoryCoverage ?? breakdown.inventoryCoverage ?? '',
    weightedCoverage: scores.weightedCoverage ?? breakdown.weightedCoverage ?? ''
  };
  const units = breakdown.coverageUnits || [];
  if (!units.length) return [{ ...common }];
  return units.map((unit) => ({
    ...common,
    ...unit,
    checkIdsJson: JSON.stringify(unit.checkIds || []),
    reasonsJson: JSON.stringify(unit.reasons || [])
  }));
}

function exportRunScope(db, runId) {
  const run = db.prepare(`
    SELECT r.*, p.inputDomain, p.finalDomain
    FROM runs r JOIN projects p ON p.id = r.projectId
    WHERE r.id = ?
  `).get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  return createRunScope(run, { id: run.projectId, inputDomain: run.inputDomain, finalDomain: run.finalDomain });
}

function scopeSafeExportRow(row, scope) {
  if (!row?.checkId) return row;
  const candidate = {
    ...row,
    sampleUrls: safeJson(row.sampleUrls, []),
    evidence: safeJson(row.evidence || row.evidenceJson, {}),
    provenance: safeJson(row.provenanceJson, {})
  };
  const safe = scopeSafeCheckResult(candidate, scope, { id: row.checkId });
  if (safe === candidate) return row;
  return {
    ...row,
    ...safe,
    sampleUrls: '[]',
    evidence: JSON.stringify(safe.evidence),
    requirementsJson: JSON.stringify(safe.requirements),
    effectiveStatus: 'NA',
    effectiveFinding: safe.finding
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function write(writable, chunk) {
  if (!writable.write(chunk)) {
    await once(writable, 'drain');
  }
}

function normalizeSchemaTypes(row) {
  return {
    ...row,
    schemaTypes: parseSchemaTypes(row.schemaTypes).join('|')
  };
}

function withDisplaySemantics(row) {
  const rawStatus = row.status || row.originalStatus || '';
  const rawPriority = row.priority || row.originalPriority || '';
  const rawFindingType = row.findingType || '';
  const enriched = applyDisplaySemantics(row);
  return {
    ...enriched,
    title: row.checkName || row.title || '',
    rawStatus,
    rawPriority,
    rawFindingType,
    evidenceJson: row.evidence || row.evidenceJson || '',
    displayFindingType: enriched.normalizedFindingType || rawFindingType || 'info'
  };
}

function parseSchemaTypes(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTemplateCluster(row) {
  return {
    ...row,
    statusCodeSummary: compactJson(row.statusCodeSummary),
    schemaTypesSummary: compactJson(row.schemaTypesSummary),
    sampleUrls: parseJson(row.sampleUrls, []).join('|')
  };
}

function normalizeTemplatePerformance(row) {
  return {
    ...row,
    worstSampleUrls: parseJson(row.worstSampleUrls, [])
      .map((sample) => sample.url || sample)
      .filter(Boolean)
      .join('|')
  };
}

function compactJson(value) {
  return JSON.stringify(parseJson(value, {}));
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
