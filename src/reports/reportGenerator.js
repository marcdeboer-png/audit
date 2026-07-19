import fs from 'node:fs';
import path from 'node:path';
import { getRunHealth, getRunWithProject, getLatestLogs, getReviewSummary, getSamplingSummary, listRunComparisons } from '../db/repositories.js';
import { loadResultsWithScores } from '../checks/checkEngine.js';
import { buildDisplaySummary, isCoreActionItem } from '../reviews/displaySemantics.js';
import { buildEnterpriseSummary } from '../analysis/enterpriseSummary.js';
import { assertRunStorageScope, createRunScope, requireRunId } from '../scope/runScope.js';

export function generateReport(db, runId) {
  requireRunId(runId, 'generate report');
  const run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  assertRunStorageScope(db, createRunScope(run, { id: run.projectId, inputDomain: run.inputDomain, finalDomain: run.finalDomain }));

  const { results, scores } = loadResultsWithScores(db, runId);
  const pages = db.prepare(`
    SELECT url, statusCode, title, indexable, h1Count, internalLinksCount, externalLinksCount,
      schemaTypesJson, pageType, hasTables, hasLists, hasFaqPattern, hasVisibleDate,
      hasAuthorPattern, externalSourceLinksCount, hasVideoEmbed
    FROM pages
    WHERE runId = ?
    ORDER BY id
    LIMIT 500
  `).all(runId);
  const renderProvenanceRows = db.prepare(`
    SELECT url, renderStatus, settlingStatus, settlingDurationMs, renderSnapshotCount,
      title AS rawTitle,
      CASE WHEN json_valid(initialRenderedStateJson) THEN json_extract(initialRenderedStateJson, '$.title') END AS initialTitle,
      CASE WHEN json_valid(settledRenderedStateJson) THEN json_extract(settledRenderedStateJson, '$.title') END AS settledTitle,
      effectiveTitle, effectiveCanonical, effectiveH1Count, effectiveMainWordCount,
      wordCountRaw AS rawWordCount,
      CASE WHEN json_valid(initialRenderedStateJson) THEN json_extract(initialRenderedStateJson, '$.visibleText.wordCount') END AS initialWordCount,
      CASE WHEN json_valid(settledRenderedStateJson) THEN json_extract(settledRenderedStateJson, '$.visibleText.wordCount') END AS settledWordCount,
      metadataProvenanceComplete, renderProvenanceVersion, settlingPolicyVersion
    FROM pages
    WHERE runId = ? AND (rawDocumentStateJson IS NOT NULL OR renderStatus IS NOT NULL)
    ORDER BY id
    LIMIT 200
  `).all(runId);
  const runtimeMetrics = db.prepare('SELECT * FROM run_runtime_metrics WHERE runId=?').get(runId) || null;
  const runtimeSummary = safeParse(runtimeMetrics?.summaryJson, {});
  const renderDecisionRows = db.prepare(`
    SELECT url,pageType,rawContentClass,templateClusterKey,renderStrategy,renderNeed,renderDecision,
      renderConfidence,resultingBrowserRun,rawFetchDurationMs,browserNavigationDurationMs,
      settlingDurationMs,snapshotCount,extractionDurationMs,persistenceDurationMs,
      totalUrlDurationMs,rawHtmlBytes,renderProvenanceBytes,networkRequestCount,
      failedRequestCount,finalSettlingStatus,renderStatus,measurementError,
      renderDecisionReasonJson,renderSignalsJson,renderNegativeSignalsJson,
      renderSignalContributionsJson,renderRecommendationScore,renderRecommendationThreshold,
      renderCheckRequirementsJson,budgetStatusJson
    FROM url_runtime_metrics WHERE runId=? ORDER BY url LIMIT 500
  `).all(runId).map((row) => ({
    ...row,
    reason: safeParse(row.renderDecisionReasonJson, {}).summary || '',
    signals: safeParse(row.renderSignalsJson, []).join(', '),
    negativeSignals: safeParse(row.renderNegativeSignalsJson, []).join(', '),
    contributions: safeParse(row.renderSignalContributionsJson, []).map((item) => `${item.signal}:${item.appliedContribution}`).join(', '),
    checkRequirements: safeParse(row.renderCheckRequirementsJson, []).map((item) => `${item.checkId}:${item.requirement}`).join(', '),
    budget: safeParse(row.budgetStatusJson, {}).reason || ''
  }));
  const statusDistribution = db.prepare(`
    SELECT COALESCE(statusCode, 0) AS statusCode, COUNT(*) AS count
    FROM pages
    WHERE runId = ?
    GROUP BY COALESCE(statusCode, 0)
    ORDER BY statusCode
  `).all(runId);
  const indexability = db.prepare(`
    SELECT indexable, COUNT(*) AS count
    FROM pages
    WHERE runId = ?
    GROUP BY indexable
  `).all(runId);
  const schemaCoverage = db.prepare(`
    SELECT schemaType, COUNT(DISTINCT pageUrl) AS pages
    FROM schemas
    WHERE runId = ? AND parseStatus = 'ok' AND schemaType IS NOT NULL
    GROUP BY schemaType
    ORDER BY pages DESC, schemaType ASC
  `).all(runId);
  const pageTypeSummary = db.prepare(`
    SELECT COALESCE(pageType, 'other') AS pageType, COUNT(*) AS pages
    FROM pages
    WHERE runId = ?
    GROUP BY COALESCE(pageType, 'other')
    ORDER BY pages DESC, pageType ASC
  `).all(runId);
  const structureSummary = db.prepare(`
    SELECT
      COUNT(*) AS pages,
      SUM(CASE WHEN hasTables = 1 THEN 1 ELSE 0 END) AS pagesWithTables,
      SUM(CASE WHEN hasLists = 1 THEN 1 ELSE 0 END) AS pagesWithLists,
      SUM(CASE WHEN hasFaqPattern = 1 THEN 1 ELSE 0 END) AS pagesWithFaqPattern,
      SUM(CASE WHEN hasVisibleDate = 1 THEN 1 ELSE 0 END) AS pagesWithVisibleDate,
      SUM(CASE WHEN hasAuthorPattern = 1 THEN 1 ELSE 0 END) AS pagesWithAuthorPattern,
      SUM(CASE WHEN externalSourceLinksCount > 0 THEN 1 ELSE 0 END) AS pagesWithSourceLinks,
      SUM(CASE WHEN hasVideoEmbed = 1 THEN 1 ELSE 0 END) AS pagesWithVideoEmbed
    FROM pages
    WHERE runId = ?
  `).get(runId);
  const schemaByPageType = db.prepare(`
    SELECT COALESCE(p.pageType, 'other') AS pageType, s.schemaType, COUNT(DISTINCT p.url) AS pages
    FROM pages p
    JOIN schemas s ON s.runId = p.runId AND s.pageUrl = p.finalUrl
    WHERE p.runId = ? AND s.parseStatus = 'ok' AND s.schemaType IS NOT NULL
    GROUP BY COALESCE(p.pageType, 'other'), s.schemaType
    ORDER BY pageType ASC, pages DESC, schemaType ASC
  `).all(runId);
  const templateClusters = db.prepare(`
    SELECT *
    FROM template_clusters
    WHERE runId = ?
    ORDER BY urlCount DESC, clusterKey ASC
    LIMIT 100
  `).all(runId);
  const samplingSummary = getSamplingSummary(db, runId);
  const sampleResults = db.prepare(`
    SELECT templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
    FROM template_sample_results
    WHERE runId = ?
    ORDER BY templateClusterKey ASC, id ASC
    LIMIT 200
  `).all(runId);
  const playwrightResults = db.prepare(`
    SELECT templateClusterKey, url, status, title, h1Count, renderedWordCount,
      renderedLinksCount, rawRenderedWordDelta, consoleErrorsCount, networkErrorsCount,
      jsRequiredLikely, loadTimeMs, settlingStatus, settlingDurationMs,
      renderSnapshotCount, renderFingerprint, renderProvenanceVersion,
      settlingPolicyVersion, screenshotPath
    FROM playwright_results
    WHERE runId = ?
    ORDER BY templateClusterKey ASC, id ASC
    LIMIT 200
  `).all(runId);
  const lighthouseResults = db.prepare(`
    SELECT templateClusterKey, url, device, performanceScore, accessibilityScore,
      bestPracticesScore, seoScore, largestContentfulPaintMs, totalBlockingTimeMs,
      cumulativeLayoutShift, speedIndexMs, totalByteWeight, domSize, errorMessage
    FROM lighthouse_results
    WHERE runId = ?
    ORDER BY
      CASE WHEN performanceScore IS NULL THEN 1 ELSE 0 END,
      performanceScore ASC,
      id ASC
    LIMIT 200
  `).all(runId);
  const templatePerformance = db.prepare(`
    SELECT *
    FROM template_performance_summary
    WHERE runId = ?
    ORDER BY
      CASE WHEN minPerformanceScore IS NULL THEN 1 ELSE 0 END,
      minPerformanceScore ASC,
      avgLcpMs DESC,
      templateClusterKey ASC
    LIMIT 100
  `).all(runId).map((row) => ({
    ...row,
    worstSampleUrls: safeParse(row.worstSampleUrlsJson, [])
  }));
  const robots = db.prepare("SELECT * FROM domain_assets WHERE runId = ? AND type = 'robots' ORDER BY id DESC LIMIT 1").get(runId);
  const llms = db.prepare("SELECT * FROM domain_assets WHERE runId = ? AND type IN ('llms', 'llms_full') ORDER BY type").all(runId);
  const logs = getLatestLogs(db, runId, 50);
  const health = getRunHealth(db, runId);
  const reviewSummary = getReviewSummary(db, runId);
  const displaySummary = buildDisplaySummary(results);
  const comparisons = listRunComparisons(db, runId);
  const enterpriseSummary = buildEnterpriseSummary(db, runId, run);
  const falsePositiveFindings = results.filter((row) => row.reviewStatus === 'false_positive');
  const ignoredReviewStatuses = new Set(['false_positive', 'ignored']);
  const activeFindings = results.filter((row) =>
    ['Error', 'Warning'].includes(row.effectiveStatus) && !ignoredReviewStatuses.has(row.reviewStatus)
  );
  const reviewRecommendedFindings = dedupeForReport(results.filter((row) =>
    row.displayReviewRecommended && !ignoredReviewStatuses.has(row.reviewStatus)
  ));
  const confirmedFindings = dedupeForReport(results.filter((row) =>
    ['confirmed', 'needs_fix'].includes(row.reviewStatus)
  ));
  const actionItems = dedupeForReport(activeFindings.filter(isCoreActionItem), compareCoreFindings);
  const geoOpportunities = dedupeForReport(results.filter((row) => row.reportSection === 'geo_opportunities'));
  const securityFindings = dedupeForReport(results.filter((row) => row.reportSection === 'security_best_practices'));
  const mediaFindings = dedupeForReport(results.filter((row) => row.reportSection === 'media_findings'));
  const renderingFindings = dedupeForReport(results.filter((row) => row.reportSection === 'template_performance'));
  const schemaFindings = dedupeForReport(activeFindings.filter((row) =>
    /structured data|schema/i.test(row.category) || row.reportGroupingKey?.startsWith('schema.')
  ));
  const passedChecks = results.filter((row) => row.reportSection === 'passed_checks');
  const notApplicableChecks = results.filter((row) => row.reportSection === 'not_applicable');
  const reportStats = {
    actionItemCount: displaySummary.actionItemCount,
    actionableCount: displaySummary.actionableFindings,
    geoOpportunityCount: displaySummary.opportunityCount,
    securityBestPracticeCount: displaySummary.securityBestPracticeCount,
    mediaFindingCount: displaySummary.mediaFindingCount,
    templatePerformanceCount: displaySummary.templatePerformanceCount,
    passedChecksCount: displaySummary.passedChecks,
    notApplicableChecksCount: displaySummary.notApplicableChecks,
    reviewRecommendedCount: reviewSummary.reviewRecommendedCount,
    reviewableCount: reviewSummary.reviewableFindings,
    highPriorityErrorCount: activeFindings.filter((row) =>
      (row.effectiveStatus || row.status) === 'Error' && (row.effectivePriority || row.priority) === 'High'
    ).length,
    mediumPriorityIssueCount: actionItems.filter((row) =>
      (row.effectivePriority || row.priority) === 'Medium'
    ).length,
    lowPriorityOpportunityCount: geoOpportunities.filter((row) =>
      (row.effectivePriority || row.priority) === 'Low'
    ).length
  };

  const reportDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `run-${runId}.html`);

  fs.writeFileSync(reportPath, renderHtml({
    run,
    scores,
    results,
    pages,
    renderProvenanceRows,
    runtimeMetrics,
    runtimeSummary,
    renderDecisionRows,
    actionItems,
    reportStats,
    schemaFindings,
    securityFindings,
    mediaFindings,
    statusDistribution,
    indexability,
    schemaCoverage,
    pageTypeSummary,
    structureSummary,
    schemaByPageType,
    templateClusters,
    samplingSummary,
    sampleResults,
    playwrightResults,
    lighthouseResults,
    templatePerformance,
    renderingFindings,
    geoOpportunities,
    reviewSummary,
    displaySummary,
    reviewRecommendedFindings,
    confirmedFindings,
    falsePositiveFindings,
    passedChecks,
    notApplicableChecks,
    comparisons,
    enterpriseSummary,
    health,
    robots,
    llms,
    logs
  }), 'utf8');

  return reportPath;
}

function renderHtml(data) {
  const {
    run,
    scores,
    results,
    pages,
    renderProvenanceRows,
    runtimeMetrics,
    runtimeSummary,
    renderDecisionRows,
    actionItems,
    reportStats,
    schemaFindings,
    securityFindings,
    mediaFindings,
    statusDistribution,
    indexability,
    schemaCoverage,
    pageTypeSummary,
    structureSummary,
    schemaByPageType,
    templateClusters,
    samplingSummary,
    sampleResults,
    playwrightResults,
    lighthouseResults,
    templatePerformance,
    renderingFindings,
    geoOpportunities,
    reviewSummary,
    displaySummary,
    reviewRecommendedFindings,
    confirmedFindings,
    falsePositiveFindings,
    passedChecks,
    notApplicableChecks,
    comparisons,
    enterpriseSummary,
    health,
    robots,
    llms,
    logs
  } = data;

  return `<!doctype html>
<html lang="de" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OMfire! Audit Report Run ${run.id}</title>
  <style>
    :root {
      color-scheme: light;
      --red:#E5001C; --red-hover:#C0001A; --red-light:#FFF0F2; --red-mid:#FFD6DB;
      --dark:#1C1C1C; --mid:#4A4A4A; --muted:#8A8A8A;
      --border:#E8E8E8; --bg:#F7F7F5; --surface:#FFFFFF; --row-hover:#FAFAFA; --thead-bg:#FAFAFA;
      --r-sm:4px; --r-md:8px; --r-lg:12px; --r-pill:999px;
      --shadow-sm:0 1px 2px rgba(0,0,0,.04);
      --rg-none:#E8E8E8; --rg-1:#E5001C; --rg-2:#D94500; --rg-3:#CC6600;
      --rg-4:#C4A000; --rg-5:#A8A800; --rg-6:#6EB030; --rg-7:#48A848;
      --rg-8:#2A9E2A; --rg-9:#1A8A2A; --rg-10:#0D7A1A;
      --ink:var(--dark); --line:var(--border); --panel:var(--thead-bg);
      --ok:var(--rg-8); --warn:var(--rg-4); --err:var(--red); --blue:var(--red); --soft:var(--red-light);
    }
    * { box-sizing:border-box; }
    body {
      margin:0; color:var(--ink); background:var(--bg);
      font-family:"DM Sans", Inter, Helvetica, Arial, sans-serif; font-size:14px; line-height:1.5;
      -webkit-font-smoothing:antialiased;
    }
    a { color:var(--red); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .site-header {
      height:72px; padding:0 40px; display:flex; align-items:center; justify-content:space-between; gap:18px;
      background:var(--surface); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:100;
    }
    .logo { display:flex; align-items:center; gap:12px; color:var(--dark); text-decoration:none; font-weight:700; }
    .logo img { height:34px; width:auto; display:block; }
    .logo .product-name { padding-left:12px; border-left:1px solid var(--border); color:var(--mid); font-size:13px; font-weight:600; }
    .header-right { display:flex; align-items:center; gap:14px; color:var(--muted); font-size:13px; }
    .header-tag {
      background:var(--red-light); color:var(--red); font-size:11px; font-weight:600;
      padding:4px 11px; border-radius:var(--r-pill); letter-spacing:0; text-transform:uppercase;
    }
    header.report-hero { padding:32px 40px 20px; border-bottom:1px solid var(--line); background:var(--surface); }
    main { padding:28px 40px 48px; max-width:1280px; }
    h1 { margin:0 0 8px; color:var(--dark); font-size:30px; font-weight:600; letter-spacing:0; line-height:1.15; }
    h2 { margin:30px 0 12px; color:var(--dark); font-size:20px; font-weight:600; letter-spacing:0; }
    h3 { margin:18px 0 8px; color:var(--dark); font-size:15px; font-weight:600; letter-spacing:0; }
    table { width:100%; border-collapse:collapse; margin:10px 0 24px; table-layout:fixed; background:var(--surface); }
    th, td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
    th { background:var(--thead-bg); color:var(--muted); font-size:11px; text-transform:uppercase; font-weight:600; letter-spacing:0; }
    tr:hover { background:var(--row-hover); }
    code, pre { font-family:"DM Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space:pre-wrap; background:var(--panel); border:1px solid var(--line); border-radius:var(--r-md); padding:10px; max-height:260px; overflow:auto; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin:18px 0 22px; }
    .card { border:1px solid var(--line); border-radius:var(--r-lg); padding:18px 20px; background:var(--surface); box-shadow:var(--shadow-sm); }
    .card.accent { border-left:3px solid var(--red); }
    .metric { color:var(--dark); font-size:28px; font-weight:600; margin-top:6px; line-height:1; }
    .summary { border:1px solid var(--line); border-radius:var(--r-lg); background:var(--surface); padding:16px; margin:18px 0 24px; box-shadow:var(--shadow-sm); }
    .summary-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:10px; margin-top:12px; }
    .summary-item { border:1px solid var(--line); border-radius:var(--r-md); padding:10px; background:var(--surface); }
    .summary-item strong { display:block; font-size:18px; margin-top:3px; }
    .notice { border:1px solid var(--line); border-left:3px solid var(--red); border-radius:var(--r-lg); padding:12px; background:var(--soft); margin:10px 0 18px; }
    .OK { color:var(--ok); font-weight:700; }
    .Warning { color:var(--warn); font-weight:700; }
    .Error { color:var(--err); font-weight:700; }
    .NA { color:var(--muted); font-weight:700; }
    .pill, .button {
      display:inline-flex; align-items:center; justify-content:center; min-height:36px;
      border:1px solid var(--line); border-radius:var(--r-pill); padding:0 12px; background:var(--surface);
      color:var(--mid); font-weight:600; margin:2px 4px 2px 0;
    }
    .button.primary { background:var(--red); border-color:var(--red); color:#fff; }
    .finding-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin:10px 0 24px; }
    .finding-card { border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:var(--r-lg); padding:12px; background:var(--surface); box-shadow:var(--shadow-sm); }
    .finding-card.Error { border-left-color:var(--err); }
    .badge { display:inline-block; border-radius:var(--r-pill); padding:2px 8px; font-size:12px; font-weight:600; background:var(--thead-bg); }
    .badge.OK { color:var(--ok); background:rgba(42,158,42,.12); }
    .badge.Warning { color:var(--warn); background:rgba(196,160,0,.16); }
    .badge.Error { color:var(--err); background:var(--red-light); }
    .badge.NA { color:var(--muted); background:var(--rg-none); }
    .badge.opportunity { color:var(--rg-6); background:rgba(110,176,48,.13); }
    .badge.best_practice { color:var(--mid); background:var(--thead-bg); }
    .badge.review, .badge.manual { color:var(--red); background:var(--red-light); }
    details { margin:4px 0; }
    summary { cursor:pointer; color:var(--red); font-weight:600; }
  </style>
</head>
<body>
  <div class="site-header">
    <a class="logo" href="#">
      <img src="/assets/omfire-logo-light.png" alt="OMfire!">
      <span class="product-name">SEO &amp; GEO Audit</span>
    </a>
    <div class="header-right">
      <span>Run ${run.id}</span>
      <span class="header-tag">Report</span>
    </div>
  </div>
  <header class="report-hero">
    <h1>Audit Report: ${escapeHtml(run.finalDomain || run.inputDomain)}</h1>
    <div class="muted">Run ${run.id} · ${escapeHtml(run.createdAt || run.startedAt || '')} · Status ${escapeHtml(reportStatusLabel(run))}</div>
    <div class="muted">This HTML report is a static technical export. The interactive audit workbench provides card details and per-check exports.</div>
  </header>
  <main>
    <section class="grid">
      ${scoreCard('Tech Score', scores.techScore, scores.techScoreStatus)}
      ${scoreCard('GEO Readiness Score', scores.geoScore, scores.geoScoreStatus)}
      ${scoreCard('Overall Score', scores.overallScore, scores.scoreStatus)}
      ${metricCard('Processed URLs', run.processedUrls)}
      ${metricCard('Successful URLs', run.successfulUrls)}
      ${metricCard('Failed URLs', run.failedUrls)}
    </section>

    <h2>Score Evidence &amp; Coverage</h2>
    ${scoreBreakdownSection(scores.breakdown)}

    <h2>Executive Summary</h2>
    ${executiveSummary({
      run,
      scores,
      reportStats,
      samplingSummary
    })}

    ${fullAuditDownloadSection(run.id)}

    ${enterpriseSummarySection(enterpriseSummary)}

    ${scheduleMetadataSection(run, comparisons)}

    <h2>Action Items</h2>
    <p class="muted">Core SEO Findings: only actionable technical SEO issues are listed here. GEO, security, media, schema opportunities, sampling availability and passed checks are separated below.</p>
    ${findingCards(actionItems, 'No core SEO action items detected.')}

    <h2>Confirmed / Needs Fix Findings</h2>
    ${findingsTable(confirmedFindings, { emptyMessage: 'No confirmed or needs-fix findings.' })}

    <h2>GEO Opportunities</h2>
    <p class="muted">Opportunities are optional improvements, not necessarily errors.</p>
    ${findingsTable(geoOpportunities, { emptyMessage: 'No GEO opportunities detected.' })}

    <h2>Security Best Practices</h2>
    ${findingsTable(securityFindings, { emptyMessage: 'No security best-practice findings.' })}

    <h2>Media Findings</h2>
    ${findingsTable(mediaFindings, { emptyMessage: 'No media findings.' })}

    <h2>Template Performance & Rendering</h2>
    ${templatePerformanceSection({
      renderingFindings,
      lighthouseResults,
      templatePerformance,
      sampleResults,
      samplingSummary
    })}

    <h2>Run Comparison</h2>
    ${runComparisonSection(comparisons)}

    <h2>Review Summary</h2>
    ${reviewSummarySection({
      reviewSummary,
      reviewRecommendedFindings,
      falsePositiveFindings
    })}

    <h2>Technical Appendix</h2>
    <div class="notice">Score methodology: Scores exclude optional unavailable sampling checks and weigh security best practices and GEO opportunities lower than core SEO issues.</div>
    <h3>Run Configuration</h3>
    <table>
      <tr><th>Input Domain</th><td>${escapeHtml(run.inputDomain)}</td><th>Final Domain</th><td>${escapeHtml(run.finalDomain || '')}</td></tr>
      <tr><th>Project ID</th><td>${escapeHtml(run.projectId)}</td><th>Primary Host</th><td>${escapeHtml(run.primaryHost || 'not recorded')}</td></tr>
      <tr><th>Git Commit</th><td>${escapeHtml(run.runtimeGitCommit || 'not recorded')}</td><th>Build Version</th><td>${escapeHtml(run.runtimeBuildVersion || 'not recorded')}</td></tr>
      <tr><th>Configuration Hash</th><td colspan="3"><code>${escapeHtml(run.runtimeConfigHash || 'not recorded')}</code></td></tr>
      <tr><th>Audit Type</th><td>${escapeHtml(run.auditType)}</td><th>Brand</th><td>${escapeHtml(run.brandName || '')}</td></tr>
      <tr><th>Trigger Type</th><td>${escapeHtml(run.triggerType || 'manual')}</td><th>Schedule</th><td>${escapeHtml(run.scheduleName || run.scheduledRunId || '')}</td></tr>
      <tr><th>Baseline Run</th><td>${escapeHtml(run.baselineRunId || '')}</td><th>Auto Comparison</th><td>${escapeHtml(run.comparisonId || '')}</td></tr>
      <tr><th>maxUrls</th><td>${run.maxUrls}</td><th>maxDepth</th><td>${run.maxDepth}</td></tr>
      <tr><th>Concurrency</th><td>${run.concurrency}</td><th>Respect robots.txt</th><td>${run.respectRobotsTxt ? 'true' : 'false'}</td></tr>
      <tr><th>crawlMode</th><td>${escapeHtml(run.crawlMode || 'hybrid')}</td><th>crawlDelayMs</th><td>${run.crawlDelayMs ?? 0}</td></tr>
      <tr><th>requestTimeoutMs</th><td>${run.requestTimeoutMs ?? 15000}</td><th>playwrightMode</th><td>${escapeHtml(run.playwrightMode || 'off')}</td></tr>
      <tr><th>playwrightSampleLimit</th><td>${run.playwrightSampleLimit ?? 50}</td><th>usePlaywright</th><td>${run.usePlaywright ? 'true' : 'false'}</td></tr>
      <tr><th>metricsMode</th><td>${escapeHtml(run.runtimeMetricsVersion ? run.metricsMode : 'historical / not recorded')}</td><th>Render planning</th><td>${escapeHtml(run.renderPlanningVersion || 'historical / not recorded')}</td></tr>
      <tr><th>Render budget (URLs / ms)</th><td>${escapeHtml(`${run.maxRenderedUrls ?? 'unlimited'} / ${run.maxTotalRenderTimeMs ?? 'unlimited'}`)}</td><th>Render budget (bytes / failures)</th><td>${escapeHtml(`${run.maxPersistedRenderBytes ?? 'unlimited'} / ${run.maxBrowserFailures ?? 'unlimited'}`)}</td></tr>
      <tr><th>renderSettlingMaxMs</th><td>${run.renderSettlingMaxMs ?? 6000}</td><th>renderSettlingIntervalMs</th><td>${run.renderSettlingIntervalMs ?? 500}</td></tr>
      <tr><th>renderSettlingMaxSnapshots</th><td>${run.renderSettlingMaxSnapshots ?? 13}</td><th>stableSnapshots / min observation</th><td>${run.renderSettlingStableSnapshots ?? 3} / ${run.renderSettlingMinimumObservationMs ?? 4000} ms</td></tr>
      <tr><th>maxConcurrentRenderedPages</th><td>${run.maxConcurrentRenderedPages ?? 1}</td><th>Settling policy</th><td>bounded semantic snapshots, no networkidle</td></tr>
      <tr><th>maxAttempts</th><td>${run.maxAttempts ?? 3}</td><th>maxConcurrentPerHost</th><td>${run.maxConcurrentPerHost ?? 2}</td></tr>
      <tr><th>retryBaseDelayMs</th><td>${run.retryBaseDelayMs ?? 1000}</td><th>retryMaxDelayMs</th><td>${run.retryMaxDelayMs ?? 30000}</td></tr>
      <tr><th>maxSitemapUrls</th><td>${run.maxSitemapUrls ?? ''}</td><th>maxSitemaps</th><td>${run.maxSitemaps ?? 100}</td></tr>
      <tr><th>sitemapBatchSize</th><td>${run.sitemapBatchSize ?? 1000}</td><th>sampleUrlsPerTemplate</th><td>${run.sampleUrlsPerTemplate ?? 5}</td></tr>
      <tr><th>includePatterns</th><td>${escapeHtml(formatPatternJson(run.includePatternsJson))}</td><th>excludePatterns</th><td>${escapeHtml(formatPatternJson(run.excludePatternsJson))}</td></tr>
    </table>
    <h3>CSV Exports</h3>
    <p>${csvExportLinks(run.id)}</p>
    <h3>Run Health</h3>
    ${simpleTable([health || {}], ['health', 'heartbeatAt', 'lockedAt', 'workerCount', 'waitingUrls', 'retryableFailures', 'permanentFailures', 'oldestProcessingAgeSeconds', 'oldestPendingAgeSeconds'])}
    <h3>Sitemap Progress</h3>
    ${simpleTable([{
      sitemapFilesProcessed: run.sitemapFilesProcessed || 0,
      sitemapUrlsDiscovered: run.sitemapUrlsDiscovered || 0,
      sitemapUrlsQueued: run.sitemapUrlsQueued || 0,
      currentSitemapUrl: run.currentSitemapUrl || ''
    }], ['sitemapFilesProcessed', 'sitemapUrlsDiscovered', 'sitemapUrlsQueued', 'currentSitemapUrl'])}
    <h3>Template Sampling / Rendering / Lighthouse Status</h3>
    <p class="muted">Template sampling measures representative sample URLs from URL clusters. It is not a full measurement of every crawled URL, and Lighthouse results are local lab data rather than CrUX/field data.</p>
    ${simpleTable([samplingSummary || {}], ['enableTemplateSampling', 'enablePlaywrightSampling', 'enableLighthouseSampling', 'renderingStatus', 'lighthouseStatus', 'samplesTotal', 'samplesProcessed', 'sampleRows', 'playwrightSuccessCount', 'playwrightIssueCount', 'lighthouseSuccessCount', 'lighthouseIssueCount', 'sampleErrorCount'])}
    ${samplingStatusNotice(samplingSummary)}
    <h3>Browser Runtime and Resource Metrics</h3>
    <p class="muted">Browser process RSS is reported only when a reliable platform-specific measurement exists. A blank value is unavailable, never an invented zero.</p>
    ${simpleTable(runtimeMetrics ? [{
      metricsMode: runtimeMetrics.metricsMode,
      metricsVersion: runtimeMetrics.metricsVersion,
      renderingStrategy: run.playwrightMode || 'off',
      avoidedRenderCount: runtimeSummary.avoidedRenderCount ?? null,
      budgetExcludedCount: runtimeSummary.budgetExcludedCount ?? null,
      renderUnavailableCount: runtimeSummary.renderUnavailableCount ?? null,
      totalDurationMs: runtimeMetrics.totalDurationMs,
      renderDurationMs: runtimeMetrics.renderDurationMs,
      renderRuntimeSharePct: runtimeMetrics.totalDurationMs ? Number(((runtimeMetrics.renderDurationMs / runtimeMetrics.totalDurationMs) * 100).toFixed(1)) : null,
      averageSettlingMs: runtimeSummary.settlingDuration?.mean ?? null,
      p90SettlingMs: runtimeSummary.settlingDuration?.p90 ?? null,
      renderedUrlCount: runtimeMetrics.renderedUrlCount,
      nonRenderedUrlCount: runtimeMetrics.nonRenderedUrlCount,
      browserLaunchCount: runtimeMetrics.browserLaunchCount,
      browserRestartCount: runtimeMetrics.browserRestartCount,
      browserFailureCount: runtimeMetrics.browserFailureCount,
      settlingTimeoutCount: runtimeMetrics.settlingTimeoutCount,
      renderingUnstableCount: runtimeMetrics.renderingUnstableCount,
      processRssPeak: runtimeMetrics.processRssPeak,
      heapUsedPeak: runtimeMetrics.heapUsedPeak,
      browserProcessRss: runtimeMetrics.browserProcessRss,
      cpuUserMs: runtimeMetrics.cpuUserMs,
      cpuSystemMs: runtimeMetrics.cpuSystemMs,
      renderProvenanceBytesTotal: runtimeMetrics.renderProvenanceBytesTotal,
      renderProvenanceBytesP90: runtimeMetrics.renderProvenanceBytesP90
    }] : [], ['metricsMode', 'metricsVersion', 'renderingStrategy', 'renderedUrlCount', 'avoidedRenderCount', 'budgetExcludedCount', 'renderUnavailableCount', 'totalDurationMs', 'renderDurationMs', 'renderRuntimeSharePct', 'averageSettlingMs', 'p90SettlingMs', 'browserLaunchCount', 'browserRestartCount', 'browserFailureCount', 'settlingTimeoutCount', 'renderingUnstableCount', 'processRssPeak', 'heapUsedPeak', 'browserProcessRss', 'cpuUserMs', 'cpuSystemMs', 'renderProvenanceBytesTotal', 'renderProvenanceBytesP90'])}
    <h4>Observed-cost projection (Concurrency 1)</h4>
    <p class="muted">These P50/P90 projections extrapolate this run's median raw fetch, observed render share, render costs and persisted bytes. They are planning ranges, not guarantees.</p>
    ${simpleTable((runtimeSummary.costForecasts || []).map((forecast) => ({
      urlCount: forecast.assumptions?.urlCount,
      expectedBrowserRuns: forecast.expectedBrowserRuns,
      expectedTotalDurationP50Ms: forecast.expectedTotalDurationP50Ms,
      expectedTotalDurationP90Ms: forecast.expectedTotalDurationP90Ms,
      expectedRenderDurationP50Ms: forecast.expectedRenderDurationP50Ms,
      expectedRenderDurationP90Ms: forecast.expectedRenderDurationP90Ms,
      expectedPersistedRenderBytes: forecast.expectedPersistedRenderBytes,
      warning: forecast.warning
    })), ['urlCount', 'expectedBrowserRuns', 'expectedTotalDurationP50Ms', 'expectedTotalDurationP90Ms', 'expectedRenderDurationP50Ms', 'expectedRenderDurationP90Ms', 'expectedPersistedRenderBytes', 'warning'])}
    <h3>URL Render Decisions and Costs</h3>
    ${simpleTable(renderDecisionRows, ['url', 'pageType', 'rawContentClass', 'templateClusterKey', 'renderStrategy', 'renderNeed', 'renderDecision', 'renderConfidence', 'resultingBrowserRun', 'reason', 'signals', 'negativeSignals', 'renderRecommendationScore', 'renderRecommendationThreshold', 'contributions', 'checkRequirements', 'budget', 'rawFetchDurationMs', 'browserNavigationDurationMs', 'settlingDurationMs', 'snapshotCount', 'extractionDurationMs', 'persistenceDurationMs', 'totalUrlDurationMs', 'rawHtmlBytes', 'renderProvenanceBytes', 'networkRequestCount', 'failedRequestCount', 'finalSettlingStatus', 'renderStatus', 'measurementError'])}
    <h3>Raw / Initial / Settled Document Provenance</h3>
    <p class="muted">Effective metadata uses a stable settled DOM when available. Unstable or failed rendering remains explicitly incomplete and is excluded from rendered-dependent pass/fail claims.</p>
    ${simpleTable(renderProvenanceRows, ['url', 'renderStatus', 'settlingStatus', 'settlingDurationMs', 'renderSnapshotCount', 'rawTitle', 'initialTitle', 'settledTitle', 'effectiveTitle', 'rawWordCount', 'initialWordCount', 'settledWordCount', 'effectiveMainWordCount', 'effectiveCanonical', 'effectiveH1Count', 'metadataProvenanceComplete', 'renderProvenanceVersion', 'settlingPolicyVersion'])}
    <h3>Schema Findings</h3>
    ${findingsTable(schemaFindings, { emptyMessage: 'No schema findings.' })}
    <h3>Template / URL Clusters</h3>
    ${simpleTable(templateClusters.map((cluster) => ({
      clusterKey: cluster.clusterKey,
      pageType: cluster.pageType,
      urlPattern: cluster.urlPattern,
      urlCount: cluster.urlCount,
      indexableCount: cluster.indexableCount,
      statusCodeSummary: formatSummaryJson(cluster.statusCodeSummaryJson),
      schemaTypesSummary: formatSummaryJson(cluster.schemaTypesSummaryJson),
      avgWordCount: cluster.avgWordCount,
      sampleUrls: safeParse(cluster.sampleUrlsJson, []).join('\\n')
    })), ['clusterKey', 'pageType', 'urlPattern', 'urlCount', 'indexableCount', 'statusCodeSummary', 'schemaTypesSummary', 'avgWordCount', 'sampleUrls'])}
    <h3>Page Types</h3>
    ${simpleTable(pageTypeSummary, ['pageType', 'pages'])}
    <h3>Structure Signals</h3>
    ${simpleTable([structureSummary || {}], ['pages', 'pagesWithTables', 'pagesWithLists', 'pagesWithFaqPattern', 'pagesWithVisibleDate', 'pagesWithAuthorPattern', 'pagesWithSourceLinks', 'pagesWithVideoEmbed'])}
    <h3>Schema Coverage</h3>
    ${simpleTable(schemaCoverage, ['schemaType', 'pages'])}
    <h3>Schema Coverage by Page Type</h3>
    ${simpleTable(schemaByPageType, ['pageType', 'schemaType', 'pages'])}
    <h3>URL Inventory Sample</h3>
    <h3>Status Code Distribution</h3>
    ${simpleTable(statusDistribution, ['statusCode', 'count'])}
    <h3>Indexability</h3>
    ${simpleTable(indexability.map((row) => ({ indexable: row.indexable ? 'indexable' : 'not indexable', count: row.count })), ['indexable', 'count'])}
    ${simpleTable(pages.map((page) => ({
      url: page.url,
      statusCode: page.statusCode,
      indexable: page.indexable ? 'yes' : 'no',
      title: page.title || '',
      pageType: page.pageType || 'other',
      h1Count: page.h1Count,
      internalLinks: page.internalLinksCount,
      externalLinks: page.externalLinksCount,
      structure: [
        page.hasTables ? 'tables' : '',
        page.hasLists ? 'lists' : '',
        page.hasFaqPattern ? 'faq' : '',
        page.hasVisibleDate ? 'date' : '',
        page.hasAuthorPattern ? 'author' : '',
        page.externalSourceLinksCount ? `sources:${page.externalSourceLinksCount}` : '',
        page.hasVideoEmbed ? 'video' : ''
      ].filter(Boolean).join(', '),
      schemaTypes: JSON.parse(page.schemaTypesJson || '[]').join(', ')
    })), ['url', 'statusCode', 'indexable', 'pageType', 'title', 'h1Count', 'internalLinks', 'externalLinks', 'structure', 'schemaTypes'])}
    <h3>robots.txt Summary</h3>
    <table>
      <tr><th>URL</th><td>${escapeHtml(robots?.url || '')}</td><th>Status</th><td>${robots?.statusCode ?? ''}</td></tr>
      <tr><th>Content Sample</th><td colspan="3"><pre>${escapeHtml((robots?.content || '').slice(0, 4000))}</pre></td></tr>
    </table>
    <h3>llms.txt Summary</h3>
    ${simpleTable(llms.map((asset) => ({ type: asset.type, url: asset.url, statusCode: asset.statusCode, bytes: (asset.content || '').length })), ['type', 'url', 'statusCode', 'bytes'])}
    <h3>Recent Logs</h3>
    ${simpleTable(logs.map((log) => ({ time: log.createdAt, level: log.level, message: log.message })), ['time', 'level', 'message'])}

    <h2>Passed Checks</h2>
    ${collapsibleFindings('Passed checks', passedChecks, 'No passed checks recorded.')}

    <h2>Not Applicable Checks</h2>
    ${collapsibleFindings('Not applicable checks', notApplicableChecks, 'No not-applicable checks recorded.')}

    <h2>All Findings</h2>
    ${findingsTable(results, { emptyMessage: 'No findings in this category.', includeAllRows: true })}
  </main>
</body>
</html>`;
}

function lighthouseSummaryTable(lighthouseResults, samplingSummary) {
  if (!lighthouseResults.length) {
    const message = samplingSummary?.lighthouseStatusMessage || 'No Template Lighthouse sampling data available.';
    return `<div class="notice">${escapeHtml(message)}</div>`;
  }
  return simpleTable(lighthouseResults.map((row) => ({
      templateClusterKey: row.templateClusterKey,
      url: row.url,
      device: row.device,
      performance: formatScore(row.performanceScore),
      accessibility: formatScore(row.accessibilityScore),
      bestPractices: formatScore(row.bestPracticesScore),
      seo: formatScore(row.seoScore),
      lcp: formatMs(row.largestContentfulPaintMs),
      tbt: formatMs(row.totalBlockingTimeMs),
      cls: row.cumulativeLayoutShift ?? '',
      error: row.errorMessage || ''
    })), ['templateClusterKey', 'url', 'device', 'performance', 'accessibility', 'bestPractices', 'seo', 'lcp', 'tbt', 'cls', 'error']);
}

function executiveSummary({ run, scores, reportStats, samplingSummary }) {
  const messages = [];
  if (scores.scoreStatus === 'insufficient_coverage') {
    messages.push(`No regular headline score is available because weighted evidence coverage is ${scores.weightedCoverage || 0}%.`);
  } else if (scores.scoreStatus === 'provisional') {
    messages.push(`The headline score is provisional at ${scores.weightedCoverage || 0}% weighted evidence coverage.`);
  }
  if (reportStats.highPriorityErrorCount) {
    messages.push(`${reportStats.highPriorityErrorCount} critical issue(s) require review.`);
  } else {
    messages.push('No critical issues detected.');
  }
  if (reportStats.mediumPriorityIssueCount) {
    messages.push(`${reportStats.mediumPriorityIssueCount} medium-priority action item(s) require review.`);
  }
  if (reportStats.reviewRecommendedCount) {
    messages.push(`${reportStats.reviewRecommendedCount} review-recommended finding(s) require review.`);
  }
  if (reportStats.lowPriorityOpportunityCount) {
    messages.push(`${reportStats.lowPriorityOpportunityCount} low-priority opportunit${reportStats.lowPriorityOpportunityCount === 1 ? 'y' : 'ies'} require review.`);
  }
  messages.push(`${reportStats.passedChecksCount || 0} checks passed.`);
  if (['unavailable', 'partial'].includes(samplingSummary?.renderingStatus) || ['unavailable', 'partial'].includes(samplingSummary?.lighthouseStatus)) {
    messages.push('Optional sampling is unavailable or partial; raw crawl data remains available.');
  }

  const items = [
    ['Domain', run.finalDomain || run.inputDomain],
    ['Run Status', reportStatusLabel(run)],
    ['Audit Type', run.auditType],
    ['Crawled URLs', run.processedUrls || 0],
    ['Overall Score', formatPercentScore(scores.overallScore)],
    ['Score Status', scores.scoreStatus || 'historical_unknown'],
    ['Weighted Coverage', scores.weightedCoverage === null || scores.weightedCoverage === undefined ? 'unknown' : `${scores.weightedCoverage}%`],
    ['Tech Score', formatPercentScore(scores.techScore)],
    ['GEO Score', formatPercentScore(scores.geoScore)],
    ['Action Items', reportStats.actionItemCount],
    ['Actionable Findings', reportStats.actionableCount],
    ['Review Recommended', reportStats.reviewRecommendedCount],
    ['Reviewable Findings', reportStats.reviewableCount],
    ['GEO Opportunities', reportStats.geoOpportunityCount],
    ['Security Best Practices', reportStats.securityBestPracticeCount],
    ['Media Findings', reportStats.mediaFindingCount],
    ['Passed Checks', reportStats.passedChecksCount],
    ['Not Applicable', reportStats.notApplicableChecksCount],
    ['Template Sampling', samplingSummary?.enableTemplateSampling ? 'enabled' : 'disabled'],
    ['Template Rendering / Playwright', samplingSummary?.renderingStatus || 'disabled'],
    ['Template Lighthouse', samplingSummary?.lighthouseStatus || 'disabled']
  ];

  return `<section class="summary">
    <div class="notice">${messages.map(escapeHtml).join(' ')}</div>
    <div class="summary-grid">
      ${items.map(([label, value]) => `<div class="summary-item"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(formatCell(value))}</strong></div>`).join('')}
    </div>
  </section>`;
}

function enterpriseSummarySection(summary = {}) {
  return `<section class="summary">
    <h3>Enterprise Summary</h3>
    <div class="summary-grid">
      <div class="summary-item"><span class="muted">Source</span><strong>${escapeHtml(summary.sourceType || 'crawl')}</strong></div>
      <div class="summary-item"><span class="muted">Storage</span><strong>${escapeHtml(summary.storageProfile || 'standard')}</strong></div>
      <div class="summary-item"><span class="muted">Scale</span><strong>${escapeHtml(summary.crawlScaleMode || '')}</strong></div>
      <div class="summary-item"><span class="muted">Active Findings</span><strong>${escapeHtml(summary.overview?.activeFindings || 0)}</strong></div>
    </div>
    <h3>Biggest Technical Risks</h3>
    ${simpleTable((summary.biggestTechnicalRisks || []).slice(0, 5), ['checkId', 'status', 'priority', 'affectedCount', 'finding'])}
    <h3>Biggest GEO / AI Risks</h3>
    ${simpleTable((summary.biggestGeoAiRisks || []).slice(0, 5), ['checkId', 'status', 'priority', 'affectedCount', 'finding'])}
    <h3>Biggest Template Problems</h3>
    ${simpleTable((summary.biggestTemplateProblems || []).slice(0, 5), ['checkId', 'status', 'priority', 'affectedCount', 'finding'])}
    <h3>Quick Wins</h3>
    ${simpleTable((summary.quickWins || []).slice(0, 5), ['checkId', 'priority', 'affectedCount', 'recommendation'])}
  </section>`;
}

function scheduleMetadataSection(run, comparisons = []) {
  if (!run.scheduledRunId && (run.triggerType || 'manual') === 'manual') return '';
  const autoComparison = run.comparisonId
    ? comparisons.find((comparison) => Number(comparison.id) === Number(run.comparisonId))
    : comparisons.find((comparison) => Number(comparison.compareRunId) === Number(run.id)) || null;
  const summary = autoComparison?.summary || {};
  return `<section class="summary">
    <h2>Schedule / Baseline</h2>
    <div class="summary-grid">
      <div class="summary-item"><span class="muted">Trigger Type</span><strong>${escapeHtml(run.triggerType || 'manual')}</strong></div>
      <div class="summary-item"><span class="muted">Schedule</span><strong>${escapeHtml(run.scheduleName || (run.scheduledRunId ? `Schedule ${run.scheduledRunId}` : 'none'))}</strong></div>
      <div class="summary-item"><span class="muted">Baseline Run</span><strong>${escapeHtml(run.baselineRunId || 'none')}</strong></div>
      <div class="summary-item"><span class="muted">Comparison</span><strong>${autoComparison ? `#${escapeHtml(autoComparison.id)}` : 'none'}</strong></div>
      <div class="summary-item"><span class="muted">Overall Score Delta</span><strong>${escapeHtml(formatSigned(summary.overallScoreDelta))}</strong></div>
      <div class="summary-item"><span class="muted">New Issues</span><strong>${escapeHtml(summary.findingDeltaCounts?.new || 0)}</strong></div>
      <div class="summary-item"><span class="muted">Resolved Issues</span><strong>${escapeHtml(summary.findingDeltaCounts?.resolved || 0)}</strong></div>
      <div class="summary-item"><span class="muted">Regression Findings</span><strong>${escapeHtml(autoComparison?.regressionFindings?.length || 0)}</strong></div>
    </div>
    ${autoComparison ? `<p><a class="pill" href="/api/audits/comparisons/${autoComparison.id}/report">Open comparison report</a></p>` : ''}
  </section>`;
}

function reportStatusLabel(run) {
  if (run.status === 'completed') return 'completed';
  return `${run.status || 'unknown'} (Live / Interim report)`;
}

function samplingStatusNotice(summary = {}) {
  const messages = [summary.renderingStatusMessage, summary.lighthouseStatusMessage].filter(Boolean);
  if (!messages.length) return '';
  return `<div class="notice">${escapeHtml(messages.join(' '))}</div>`;
}

function scoreCard(label, value, status = null) {
  return `<div class="card accent"><div class="muted">${escapeHtml(label)}</div><div class="metric">${value === null || value === undefined ? 'NA' : `${value}%`}</div>${status ? `<div class="muted">${escapeHtml(status)}</div>` : ''}</div>`;
}

function scoreBreakdownSection(breakdown = {}) {
  if (!breakdown || !breakdown.scoringModel) return '<p class="muted">No score breakdown is available.</p>';
  if (breakdown.scoringVersion) {
    const summary = [{
      scoringVersion: breakdown.scoringVersion,
      deduplicationVersion: breakdown.deduplicationVersion,
      coverageModelVersion: breakdown.coverageModelVersion,
      scoreStatus: breakdown.scoreStatus,
      score: breakdown.score,
      diagnosticScore: breakdown.diagnosticScore,
      weightedCoverage: `${breakdown.weightedCoverage}%`,
      rawFindings: breakdown.rawFindingCount,
      scoredFindings: breakdown.scoredFindingCount,
      rootCauses: breakdown.rootCauseCount,
      deduplicatedFindings: breakdown.deduplicatedFindingCount,
      rawPenalty: breakdown.rawPenalty,
      appliedPenalty: breakdown.appliedPenalty
    }];
    const notice = breakdown.scoreStatus === 'insufficient_coverage'
      ? 'Weighted evidence coverage is below 60%. No regular headline score is shown; the diagnostic value explains only the observed penalties.'
      : breakdown.scoreStatus === 'provisional'
        ? 'Weighted evidence coverage is between 60% and 80%. The score is provisional and may be biased by missing categories or measurements.'
        : 'Weighted evidence coverage is at least 80%. The score is final for the configured and collected audit scope.';
    return `<section class="summary">
      <div class="notice">${escapeHtml(notice)}</div>
      ${simpleTable(summary, ['scoringVersion', 'deduplicationVersion', 'coverageModelVersion', 'scoreStatus', 'score', 'diagnosticScore', 'weightedCoverage', 'rawFindings', 'scoredFindings', 'rootCauses', 'deduplicatedFindings', 'rawPenalty', 'appliedPenalty'])}
      <h3>Category Coverage and Penalties</h3>
      ${simpleTable((breakdown.categoryScores || []).slice(0, 30), ['category', 'scoreStatus', 'score', 'diagnosticScore', 'weightedCoverage', 'rootCauseCount', 'rawPenalty', 'appliedPenalty'], 'No category scores.')}
      <h3>Root-Cause Deductions</h3>
      ${simpleTable((breakdown.rootCauses || []).slice(0, 50), ['rootCauseId', 'rootCauseFamily', 'primaryCheckId', 'severity', 'confidence', 'scopeType', 'affectedUrlCount', 'relatedCheckIds', 'rawPenalty', 'appliedPenalty', 'deduplicationReason'], 'No score deductions.')}
      <h3>Applied Caps</h3>
      ${simpleTable((breakdown.capsApplied || []).slice(0, 30), ['type', 'limit', 'rawPenalty', 'appliedPenalty', 'reduction'], 'No caps were applied.')}
      <h3>Score-free Results</h3>
      ${simpleTable((breakdown.excluded || []).slice(0, 80), ['checkId', 'evaluationState', 'reason', 'weight'], 'No checks were excluded.')}
    </section>`;
  }
  const summary = [{
    model: breakdown.scoringModel,
    configuredChecks: breakdown.configuredChecks,
    scoredChecks: breakdown.eligibleChecks,
    excludedChecks: breakdown.excludedChecks,
    deduplicatedChecks: breakdown.deduplicatedChecks,
    dataCoverage: `${breakdown.dataCoveragePct}%`,
    coverageCeiling: `${breakdown.maximumScoreAtAvailableCoverage}%`
  }];
  return `<section class="summary">
    <div class="notice">Historical scoring metadata is unavailable. This report preserves the legacy aggregate and does not apply root-cause scoring v2.</div>
    ${simpleTable(summary, ['model', 'configuredChecks', 'scoredChecks', 'excludedChecks', 'deduplicatedChecks', 'dataCoverage', 'coverageCeiling'])}
    <h3>Weighted Deductions</h3>
    ${simpleTable((breakdown.deductions || []).slice(0, 30), ['checkId', 'category', 'status', 'priority', 'findingType', 'weightedDeduction', 'deduplicationKey'], 'No score deductions.')}
    <h3>Excluded Checks</h3>
    ${simpleTable((breakdown.excluded || []).slice(0, 50), ['checkId', 'evaluationState', 'reason'], 'No checks were excluded.')}
    <h3>Deduplicated Root Causes</h3>
    ${simpleTable((breakdown.deduplicated || []).slice(0, 50), ['checkId', 'deduplicationKey', 'representedBy'], 'No checks were deduplicated.')}
  </section>`;
}

function metricCard(label, value) {
  return `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${Number(value || 0).toLocaleString('en-US')}</div></div>`;
}

function reviewSummarySection({ reviewSummary = {}, reviewRecommendedFindings, confirmedFindings, falsePositiveFindings }) {
  const total = Number(reviewSummary.reviewableFindings || 0);
  const reviewed = Number(reviewSummary.reviewed || 0);
  const reviewProgress = total ? `${Math.round((reviewed / total) * 100)}%` : '0%';
  const hasManualReviews = reviewed > 0;
  const summaryRows = [{
    reviewProgress,
    reviewedTotal: `${reviewed}/${total}`,
    totalChecks: reviewSummary.totalFindings || 0,
    notRequired: reviewSummary.notRequired || 0,
    needsFix: reviewSummary.needsFix || 0,
    falsePositive: reviewSummary.falsePositive || 0,
    done: reviewSummary.done || 0,
    reviewRecommended: reviewSummary.reviewRecommendedCount || 0,
    unreviewed: reviewSummary.unreviewed || 0,
    confirmed: reviewSummary.confirmed || 0,
    acceptedRisk: reviewSummary.acceptedRisk || 0,
    ignored: reviewSummary.ignored || 0
  }];
  return `
    ${simpleTable(summaryRows, ['reviewProgress', 'reviewedTotal', 'totalChecks', 'notRequired', 'needsFix', 'falsePositive', 'done', 'reviewRecommended', 'unreviewed', 'confirmed', 'acceptedRisk', 'ignored'])}
    ${hasManualReviews ? '' : '<p class="muted">No manual reviews have been added yet.</p>'}
    <h3>Review Recommended</h3>
    ${findingsTable(reviewRecommendedFindings, { emptyMessage: 'No review recommended findings.' })}
    <h3>False Positives</h3>
    ${findingsTable(falsePositiveFindings, { emptyMessage: 'No false positives marked.' })}
  `;
}

function templatePerformanceSection({ renderingFindings, lighthouseResults, templatePerformance, sampleResults, samplingSummary }) {
  return `
    ${samplingStatusNotice(samplingSummary)}
    <h3>Rendering Findings</h3>
    ${findingsTable(renderingFindings, { emptyMessage: 'No findings in this category.' })}
    <h3>Template Lighthouse Summary</h3>
    ${lighthouseSummaryTable(lighthouseResults, samplingSummary)}
    <h3>Template Performance Summary</h3>
    ${templatePerformanceTable(templatePerformance, samplingSummary)}
    <h3>Sample URLs with Measurements</h3>
    ${simpleTable(sampleResults.map((row) => ({
      templateClusterKey: row.templateClusterKey,
      url: row.url,
      finalUrl: row.finalUrl,
      sampleReason: row.sampleReason,
      playwrightStatus: row.playwrightStatus,
      lighthouseStatus: row.lighthouseStatus
    })), ['templateClusterKey', 'url', 'finalUrl', 'sampleReason', 'playwrightStatus', 'lighthouseStatus'])}
    ${sampleErrorDebugDetails(sampleResults)}
  `;
}

function csvExportLinks(runId) {
  const exports = [
    ['Findings CSV', 'findings'],
    ['Score Root Causes CSV', 'score-root-causes'],
    ['URL Inventory CSV', 'pages'],
    ['Links CSV', 'links'],
    ['Images CSV', 'images'],
    ['Resources CSV', 'resources'],
    ['Schemas CSV', 'schemas'],
    ['GEO Signals CSV', 'geo-signals'],
    ['Reviews CSV', 'reviews'],
    ['Samples CSV', 'samples'],
    ['Playwright Results CSV', 'playwright-results'],
    ['Render Provenance CSV', 'render-provenance'],
    ['Render Runtime CSV', 'render-runtime'],
    ['Lighthouse Results CSV', 'lighthouse-results'],
    ['Template Performance CSV', 'template-performance'],
    ['Templates CSV', 'templates'],
    ['Status Summary CSV', 'status-summary']
  ];
  return exports
    .map(([label, type]) => `<a class="pill" href="/api/audits/${runId}/export/${type}.csv">${escapeHtml(label)}</a>`)
    .join(' ');
}

function fullAuditDownloadSection(runId) {
  return `
    <h2>Full Audit Downloads</h2>
    <div class="notice">
      Download links require the local audit server to be running. If this report is opened as a local file, use the Audit UI or open the report through http://localhost:3000.
    </div>
    <p>
      <a class="button primary" href="/api/audits/${runId}/export/full.zip" download="audit-${runId}-full-audit.zip">Full Audit ZIP</a>
      <a class="button" href="/api/audits/${runId}/export/full.json" download="audit-${runId}-full-audit.json">Full Audit JSON</a>
      <a class="button" href="/#maturity/${runId}">GEO Visibility Reifegrad</a>
    </p>
  `;
}

function runComparisonSection(comparisons = []) {
  if (!comparisons.length) return '<p class="muted">No saved run comparison is available for this run yet.</p>';
  return simpleTable(comparisons.slice(0, 10).map((comparison) => ({
    comparisonId: comparison.id,
    baseRunId: comparison.baseRunId,
    compareRunId: comparison.compareRunId,
    status: comparison.status,
    createdAt: comparison.createdAt,
    overallScoreDelta: comparison.summary?.overallScoreDelta ?? '',
    newIssues: comparison.summary?.findingDeltaCounts?.new ?? 0,
    resolvedIssues: comparison.summary?.findingDeltaCounts?.resolved ?? 0,
    report: `/api/audits/comparisons/${comparison.id}/report`
  })), ['comparisonId', 'baseRunId', 'compareRunId', 'status', 'createdAt', 'overallScoreDelta', 'newIssues', 'resolvedIssues', 'report']);
}

function collapsibleFindings(label, rows, emptyMessage) {
  if (!rows.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<details><summary>${escapeHtml(label)} (${rows.length})</summary>${findingsTable(rows, { emptyMessage })}</details>`;
}

function findingCards(rows, emptyMessage = 'No top findings.') {
  if (!rows.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<section class="finding-grid">
    ${rows.slice(0, 12).map((row) => `<article class="finding-card ${escapeHtml(row.effectiveStatus || row.status)}">
      <div>${findingBadges(row).join(' ')}</div>
      <h3>${escapeHtml(row.checkName || row.checkId)}</h3>
      <p>${escapeHtml(row.effectiveFinding || row.finding || '')}</p>
      <p class="muted">Affected: ${row.affectedCount || 0} · Score: ${row.score ?? 'NA'}${row.hasManualOverride ? ' · manual override applied' : ''}</p>
    </article>`).join('')}
  </section>`;
}

function findingsTable(rows, { emptyMessage = 'No findings in this category.' } = {}) {
  if (!rows.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<table>
    <thead>
      <tr>
        <th>Check ID</th><th>Category</th><th>Status / Priority</th><th>Review</th><th>Finding</th><th>Details</th><th>Recommendation</th><th>Affected</th><th>Samples</th><th>Evidence</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td><code>${escapeHtml(row.checkId)}</code></td>
        <td>${escapeHtml(row.category)}</td>
        <td>${findingBadges(row).join(' ')}<div class="muted">Evaluation: ${escapeHtml(row.evaluationState || '')} · Score: ${escapeHtml(formatCell(row.score))}${row.scoreEligible ? '' : ' · excluded'}</div></td>
        <td>${badge(row.displayReviewStatus || row.reviewStatus || 'unreviewed', 'review')} ${badge(row.displayActionStatus || row.actionStatus || 'open', 'review')}</td>
        <td>${escapeHtml(row.effectiveFinding || row.finding || '')}<div class="muted">Original: ${escapeHtml(row.status)} / ${escapeHtml(row.priority)}</div></td>
        <td>${escapeHtml(row.details || '')}${row.scoreExclusionReason ? `<div class="muted">${escapeHtml(row.scoreExclusionReason)}</div>` : ''}</td>
        <td>${escapeHtml(row.effectiveRecommendation || row.recommendation || '')}</td>
        <td>${row.affectedCount || 0}</td>
        <td>${samplesDetails(row.sampleUrls || safeParse(row.sampleUrlsJson, []))}</td>
        <td>${evidenceDetails(row.facts || safeParse(row.factsJson, {}), 'Facts')}${evidenceDetails(row.evidence || safeParse(row.evidenceJson, {}), 'Evidence')}${evidenceDetails(row.assessment || safeParse(row.assessmentJson, {}), 'Assessment')}${evidenceDetails(row.recommendationMeta || safeParse(row.recommendationMetaJson, {}), 'Recommendation')}${evidenceDetails(row.requirements || safeParse(row.requirementsJson, {}), 'Requirements')}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function templatePerformanceTable(rows, samplingSummary = {}) {
  const hasLighthouseMetric = rows.some((row) =>
    row.avgPerformanceScore !== null ||
    row.minPerformanceScore !== null ||
    row.avgLcpMs !== null ||
    row.avgTbtMs !== null ||
    row.avgCls !== null
  );
  if (samplingSummary.lighthouseStatus === 'unavailable' && !hasLighthouseMetric) {
    return '<div class="notice">Template samples were selected successfully, but performance metrics were not collected because Template Lighthouse sampling was unavailable.</div>';
  }
  if (samplingSummary.renderingStatus === 'unavailable' && !rows.length) {
    return '<div class="notice">Template rendering sampling unavailable. Raw HTML fallback was used for checks that do not need rendered measurements.</div>';
  }
  if (!rows.length) {
    const hint = ['unavailable', 'disabled'].includes(samplingSummary.lighthouseStatus)
      ? ` ${samplingSummary.lighthouseStatusMessage || 'Template Lighthouse sampling unavailable.'}`
      : '';
    return `<p class="muted">No template performance data.${escapeHtml(hint)}</p>`;
  }
  return simpleTable(rows.map((row) => ({
    templateClusterKey: row.templateClusterKey,
    sampleCount: row.sampleCount,
    avgPerformanceScore: formatScore(row.avgPerformanceScore),
    minPerformanceScore: formatScore(row.minPerformanceScore),
    avgLcpMs: formatMs(row.avgLcpMs),
    avgTbtMs: formatMs(row.avgTbtMs),
    avgCls: row.avgCls ?? '',
    jsRequiredCount: row.jsRequiredCount,
    consoleErrorSampleCount: row.consoleErrorSampleCount,
    worstSampleUrls: (row.worstSampleUrls || []).map((sample) => sample.url || sample).join('\n')
  })), ['templateClusterKey', 'sampleCount', 'avgPerformanceScore', 'minPerformanceScore', 'avgLcpMs', 'avgTbtMs', 'avgCls', 'jsRequiredCount', 'consoleErrorSampleCount', 'worstSampleUrls']);
}

function sampleErrorDebugDetails(sampleResults = []) {
  const errors = sampleResults.filter((row) => row.errorMessage).map((row) => ({
    templateClusterKey: row.templateClusterKey,
    url: row.url,
    errorMessage: row.errorMessage
  }));
  if (!errors.length) return '';
  return `<details><summary>Debug sample errors</summary><pre>${escapeHtml(formatJson(errors))}</pre></details>`;
}

function simpleTable(rows, columns, emptyMessage = 'No data collected.') {
  if (!rows.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<table>
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join('')}</tr>`).join('')}
    </tbody>
  </table>`;
}

function badge(label, className = '') {
  return `<span class="badge ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function findingBadges(row) {
  const status = row.effectiveStatus || row.status;
  const statusLabel = row.displayStatus || (row.normalizedFindingType === 'opportunity' && status === 'Warning' ? 'Opportunity' : status);
  const badges = [
    badge(statusLabel || 'NA', status || 'NA'),
    badge(row.effectivePriority || row.priority || 'Medium'),
    badge(row.normalizedFindingType || row.findingType || 'info', row.normalizedFindingType || row.findingType || 'info')
  ];
  if (row.confidence) badges.push(badge(`confidence: ${row.confidence}`));
  if (row.displayReviewRecommended) badges.push(badge('review recommended', 'review'));
  if (row.hasManualOverride) badges.push(badge('manual override applied', 'manual'));
  return badges;
}

function samplesDetails(samples = []) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  if (!safeSamples.length) return '<span class="muted">No samples.</span>';
  const summary = safeSamples.length === 1 ? '1 sample' : `${safeSamples.length} samples`;
  return `<details><summary>${escapeHtml(summary)}</summary><pre>${escapeHtml(formatJson(safeSamples))}</pre></details>`;
}

function evidenceDetails(evidence = {}, label = 'Evidence') {
  const keys = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? Object.keys(evidence) : [];
  const summary = keys.length ? `${label}: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''}` : label;
  return `<details><summary>${escapeHtml(summary)}</summary><pre>${escapeHtml(formatJson(evidence))}</pre></details>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatJson(value) {
  return (JSON.stringify(value ?? {}, null, 2) || '').slice(0, 8000);
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatPercentScore(value) {
  if (value === null || value === undefined || value === '') return 'NA';
  return `${value}%`;
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function formatPatternJson(value) {
  const parsed = safeParse(value, []);
  return Array.isArray(parsed) ? parsed.join(', ') : '';
}

function formatSummaryJson(value) {
  const parsed = safeParse(value, {});
  return Object.entries(parsed).map(([key, count]) => `${key}:${count}`).join(', ');
}

function formatSigned(value) {
  if (value === null || value === undefined || value === '') return 'NA';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number > 0 ? `+${number}` : String(number);
}

function formatScore(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '';
}

function formatMs(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}ms` : '';
}

function dedupeForReport(rows, comparator = compareReportFindings) {
  const output = [];
  const seen = new Set();
  const sorted = [...rows].sort(comparator);
  for (const row of sorted) {
    const key = row.reportGroupingKey || row.checkId;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function compareReportFindings(a, b) {
  return severityRank(a) - severityRank(b) ||
    priorityRank(a) - priorityRank(b) ||
    String(a.checkId).localeCompare(String(b.checkId));
}

function compareCoreFindings(a, b) {
  return severityRank(a) - severityRank(b) ||
    priorityRank(a) - priorityRank(b) ||
    findingTypeRank(a) - findingTypeRank(b) ||
    Number(b.affectedCount || 0) - Number(a.affectedCount || 0) ||
    Number(a.score ?? 999) - Number(b.score ?? 999) ||
    String(a.checkId).localeCompare(String(b.checkId));
}

function severityRank(row) {
  const severity = { Error: 0, Warning: 1, OK: 2, NA: 3 };
  return severity[row.effectiveStatus || row.status] ?? 9;
}

function priorityRank(row) {
  const priority = { High: 0, Medium: 1, Low: 2 };
  return priority[row.effectivePriority || row.priority] ?? 9;
}

function findingTypeRank(row) {
  const types = { core_issue: 0, issue: 0, best_practice: 1, opportunity: 2, info: 3 };
  return types[row.findingType || 'core_issue'] ?? 9;
}

function isCoreFindingCandidate(row) {
  const status = row.effectiveStatus || row.status;
  const priority = row.effectivePriority || row.priority;
  if (!['Error', 'Warning'].includes(status)) return false;
  if (!['High', 'Medium'].includes(priority)) return false;
  if (!['core_issue', 'issue'].includes(row.findingType || 'core_issue')) return false;
  if (!['high', 'medium'].includes(row.confidence || 'medium')) return false;
  if (Number(row.affectedCount || 0) <= 0) return false;
  if (row.auditType === 'geo') return false;

  const text = `${row.checkId || ''} ${row.category || ''} ${row.reportGroupingKey || ''}`.toLowerCase();
  if (/security|media seo|template performance|javascript & rendering|structured data|schema|geo|pwa|webmanifest|browser metadata/.test(text)) return false;
  if (/speakable|faqpage_missing_low_coverage|webmanifest_missing/.test(text)) return false;
  return true;
}
