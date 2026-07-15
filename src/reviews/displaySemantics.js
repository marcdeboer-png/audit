const REVIEW_BLOCKING_STATUSES = new Set(['false_positive', 'ignored']);
const ISSUE_STATUSES = new Set(['Warning', 'Error']);

export function applyDisplaySemantics(row = {}) {
  const status = row.effectiveStatus || row.manualStatus || row.status || row.originalStatus || 'NA';
  const priority = row.effectivePriority || row.manualPriority || row.priority || row.originalPriority || 'Medium';
  const originalType = row.findingType || row.normalizedFindingType || 'info';
  const normalizedFindingType = normalizeDisplayFindingType({ ...row, status, findingType: originalType });
  const originalReviewStatus = row.reviewStatus || 'unreviewed';
  const originalActionStatus = row.actionStatus || 'open';
  const ignored = REVIEW_BLOCKING_STATUSES.has(originalReviewStatus);
  const passed = status === 'OK';
  const notApplicable = status === 'NA';
  const issue = ISSUE_STATUSES.has(status);
  const opportunity = normalizedFindingType === 'opportunity' && issue;
  const manualNaDecision = notApplicable && Boolean(row.reviewRecommended) && normalizedFindingType !== 'info';
  const reviewable = !ignored && (issue || manualNaDecision);
  const displayReviewRecommended = reviewable && (
    Boolean(row.reviewRecommended) ||
    ['low', 'medium'].includes(row.confidence || '')
  );
  const displayReviewStatus = displayReviewStatusFor({
    originalReviewStatus,
    reviewable,
    passed,
    notApplicable
  });
  const displayActionStatus = displayActionStatusFor({
    originalActionStatus,
    reviewable,
    displayReviewStatus
  });
  const reportSection = reportSectionFor({
    row,
    status,
    normalizedFindingType,
    ignored
  });
  const isActionable = !ignored && [
    'action_items',
    'geo_opportunities',
    'security_best_practices',
    'media_findings',
    'template_performance'
  ].includes(reportSection);

  return {
    ...row,
    normalizedFindingType,
    displayStatus: opportunity ? 'Opportunity' : status,
    displayPriority: priority,
    displayReviewStatus,
    displayActionStatus,
    displayReviewRecommended: displayReviewRecommended ? 1 : 0,
    isActionable: isActionable ? 1 : 0,
    isReviewable: reviewable ? 1 : 0,
    reportSection
  };
}

export function buildDisplaySummary(rows = []) {
  const enrichedRows = rows.map((row) => row.reportSection ? row : applyDisplaySemantics(row));
  const summary = {
    totalFindings: enrichedRows.length,
    reviewableFindings: 0,
    reviewRecommendedCount: 0,
    actionableFindings: 0,
    actionItemCount: 0,
    opportunityCount: 0,
    securityBestPracticeCount: 0,
    mediaFindingCount: 0,
    templatePerformanceCount: 0,
    passedChecks: 0,
    notApplicableChecks: 0,
    notRequired: 0,
    lowConfidenceCount: 0,
    mediumConfidenceCount: 0
  };

  for (const row of enrichedRows) {
    if (row.isReviewable) summary.reviewableFindings += 1;
    if (row.displayReviewRecommended) summary.reviewRecommendedCount += 1;
    if (row.isActionable) summary.actionableFindings += 1;
    if (row.displayReviewStatus === 'not_required') summary.notRequired += 1;
    if (row.isReviewable && row.confidence === 'low') summary.lowConfidenceCount += 1;
    if (row.isReviewable && row.confidence === 'medium') summary.mediumConfidenceCount += 1;

    switch (row.reportSection) {
      case 'action_items':
        summary.actionItemCount += 1;
        break;
      case 'geo_opportunities':
        summary.opportunityCount += 1;
        break;
      case 'security_best_practices':
        summary.securityBestPracticeCount += 1;
        break;
      case 'media_findings':
        summary.mediaFindingCount += 1;
        break;
      case 'template_performance':
        summary.templatePerformanceCount += 1;
        break;
      case 'passed_checks':
        summary.passedChecks += 1;
        break;
      case 'not_applicable':
        summary.notApplicableChecks += 1;
        break;
      default:
        break;
    }
  }

  return summary;
}

export function normalizeDisplayFindingType(row = {}) {
  const input = row.findingType || 'info';
  if (row.status === 'OK' || row.status === 'NA') return 'info';
  if (isAiCrawlerPolicy(row)) return 'opportunity';
  if (isBrowserMetadataOpportunity(row)) return 'opportunity';
  if (/security/i.test(row.category || '')) return 'best_practice';
  if (input === 'llm_assisted') return 'llm_assisted';
  if (['core_issue', 'opportunity', 'best_practice', 'info'].includes(input)) return input;
  if (input === 'issue') return 'core_issue';
  return 'core_issue';
}

export function shouldAppearInNeedsReview(row = {}) {
  const enriched = row.reportSection ? row : applyDisplaySemantics(row);
  return Boolean(enriched.isReviewable) &&
    enriched.displayReviewStatus === 'unreviewed' &&
    enriched.displayStatus !== 'OK';
}

export function isCoreActionItem(row = {}) {
  const enriched = row.reportSection ? row : applyDisplaySemantics(row);
  if (enriched.reportSection !== 'action_items') return false;
  if (!ISSUE_STATUSES.has(enriched.effectiveStatus || enriched.status)) return false;
  if (!['High', 'Medium'].includes(enriched.effectivePriority || enriched.priority)) return false;
  if (!['high', 'medium'].includes(enriched.confidence || 'medium')) return false;
  if (Number(enriched.affectedCount || 0) <= 0) return false;
  return true;
}

function displayReviewStatusFor({ originalReviewStatus, reviewable, passed, notApplicable }) {
  if (originalReviewStatus && originalReviewStatus !== 'unreviewed') return originalReviewStatus;
  if (!reviewable || passed || notApplicable) return 'not_required';
  return 'unreviewed';
}

function displayActionStatusFor({ originalActionStatus, reviewable, displayReviewStatus }) {
  if (originalActionStatus && originalActionStatus !== 'open') return originalActionStatus;
  if (!reviewable || displayReviewStatus === 'not_required') return 'none';
  return 'open';
}

function reportSectionFor({ row, status, normalizedFindingType, ignored }) {
  if (ignored) return 'all_findings';
  if (status === 'OK') return 'passed_checks';
  if (status === 'NA') return 'not_applicable';

  const text = `${row.checkId || ''} ${row.category || ''} ${row.reportGroupingKey || ''}`.toLowerCase();
  if (/template performance|javascript & rendering|^template\./.test(text)) return 'template_performance';
  if (/media/.test(text)) return 'media_findings';
  if (/security/.test(text) || normalizedFindingType === 'best_practice') return 'security_best_practices';
  if (normalizedFindingType === 'llm_assisted') return 'geo_opportunities';
  if (row.auditType === 'geo' || normalizedFindingType === 'opportunity' || /geo|ai crawler policy|ai bot|speakable|llms|webmanifest|pwa/.test(text)) {
    return 'geo_opportunities';
  }
  if (normalizedFindingType === 'core_issue') return 'action_items';
  return 'technical_appendix';
}

function isAiCrawlerPolicy(row = {}) {
  const text = `${row.checkId || ''} ${row.category || ''}`.toLowerCase();
  return /geo\.robots_mentions_|geo\.ai_bots_policy_summary|ai bot robots|ai crawler policy/.test(text);
}

function isBrowserMetadataOpportunity(row = {}) {
  const text = `${row.checkId || ''} ${row.category || ''} ${row.reportGroupingKey || ''}`.toLowerCase();
  return /webmanifest|browser metadata opportunity|pwa/.test(text);
}
