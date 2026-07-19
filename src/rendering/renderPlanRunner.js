import { performance } from 'node:perf_hooks';
import { launchBrowser, renderPage } from '../extractors/renderExtractor.js';
import { buildEffectiveDocumentState, RENDER_PROVENANCE_VERSION, SETTLING_POLICY_VERSION } from '../extractors/documentState.js';
import { isInternalUrl } from '../utils/url.js';
import { logRun } from '../db/repositories.js';
import { activeRenderCheckIdsForAuditType, buildDeterministicRenderPlan, classifierForRenderPlanningVersion, RENDER_NEEDS } from './renderPlanner.js';
import { serializedRenderProvenanceBytes } from '../runtime/renderMetrics.js';

export async function runDeterministicRenderPlan(db, run, runtimeMetrics = null, dependencies = {}) {
  const launchBrowserFn = dependencies.launchBrowserFn || launchBrowser;
  const renderPageFn = dependencies.renderPageFn || renderPage;
  if (!run.usePlaywright || run.playwrightMode !== 'gate') return { skipped: true, reason: 'strategy_not_gate' };
  const classifyRenderNeed = classifierForRenderPlanningVersion(run.renderPlanningVersion);
  const pages = loadEligiblePages(db, run.id).map((page) => ({
    ...page,
    classification: classifyRenderNeed(page, {
      scriptCount: page.scriptCount,
      hydrationBytes: page.hydrationBytes,
      activeCheckIds: activeRenderCheckIdsForAuditType(run.auditType)
    })
  }));
  const observed = priorRenderObservations(db, run.id);
  const plan = buildDeterministicRenderPlan(pages, {
    maxRenderedUrls: run.maxRenderedUrls,
    maxTotalRenderTimeMs: run.maxTotalRenderTimeMs,
    maxPersistedRenderBytes: run.maxPersistedRenderBytes,
    maxBrowserFailures: run.maxBrowserFailures,
    estimatedRenderTimeMs: observed.medianDurationMs || 5000,
    estimatedPersistedBytes: observed.medianBytes || 30000
  });

  for (const row of plan.rows) {
    runtimeMetrics?.recordUrl(metricForPlanRow(row, run));
    if (row.executionDecision === 'render_budget_exhausted') markEvidenceIncomplete(db, run.id, row.url);
  }
  const executable = plan.rows.filter((row) => row.plannedBrowserRun);
  if (!executable.length) return { ...plan.summary, skipped: true, plan };

  runtimeMetrics?.startPhase('browser_launch');
  const browser = await launchBrowserFn((level, message, data) => logRun(db, run.id, level, message, data));
  runtimeMetrics?.endPhase('browser_launch');
  runtimeMetrics?.recordBrowserLaunch({ success: Boolean(browser) });
  if (!browser) {
    for (const row of executable) {
      markEvidenceIncomplete(db, run.id, row.url);
      runtimeMetrics?.recordUrl({ ...metricForPlanRow(row, run), renderDecision: 'render_unavailable', measurementError: 'Playwright browser unavailable.' });
    }
    return { ...plan.summary, renderedUrls: 0, unavailableUrls: executable.length, plan };
  }

  let renderedUrls = 0;
  let browserFailures = 0;
  try {
    for (const row of executable) {
      const actualBudget = actualBudgetStatus(db, run, browserFailures);
      if (!actualBudget.allowed) {
        markEvidenceIncomplete(db, run.id, row.url);
        runtimeMetrics?.recordUrl({ ...metricForPlanRow(row, run), renderDecision: 'render_budget_exhausted', budgetStatus: actualBudget });
        continue;
      }
      const page = pages.find((candidate) => candidate.url === row.url);
      const priorMetric = db.prepare('SELECT persistenceDurationMs,totalUrlDurationMs FROM url_runtime_metrics WHERE runId=? AND url=?').get(run.id, row.url) || {};
      const startedAt = performance.now();
      let render;
      try {
        render = await renderPageFn(browser, page.finalUrl || page.url, run.finalDomain, run.requestTimeoutMs || 15000, run.userAgent, {
          captureHtml: Boolean(run.storeRenderedHtml),
          settling: {
            maxDurationMs: Math.min(run.renderSettlingMaxMs || 6000, run.maxSettlingTimeMsPerUrl || run.renderSettlingMaxMs || 6000),
            intervalMs: run.renderSettlingIntervalMs,
            maxSnapshots: run.renderSettlingMaxSnapshots,
            stableSnapshots: run.renderSettlingStableSnapshots,
            minimumObservationMs: run.renderSettlingMinimumObservationMs
          },
          shouldAbort: () => {
            const current = db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id);
            return !current || !['running', 'pending'].includes(current.status);
          }
        });
      } catch (error) {
        const renderDurationMs = performance.now() - startedAt;
        const message = String(error?.message || error || 'Unknown browser rendering failure.').slice(0, 2000);
        renderedUrls += 1;
        browserFailures += 1;
        db.prepare('UPDATE runs SET renderedPagesCount=renderedPagesCount+1 WHERE id=?').run(run.id);
        markTechnicalRenderFailure(db, run.id, row.url, message);
        runtimeMetrics?.recordRenderUsage({ durationMs: renderDurationMs, failure: true });
        runtimeMetrics?.recordUrl({
          ...metricForPlanRow(row, run),
          budgetStatus: actualBudget,
          resultingBrowserRun: true,
          totalUrlDurationMs: Number(priorMetric.totalUrlDurationMs || 0) + renderDurationMs,
          finalSettlingStatus: 'technical_error',
          renderStatus: 'technical_error',
          measurementError: message
        });
        continue;
      }
      const renderDurationMs = performance.now() - startedAt;
      const persistenceStartedAt = performance.now();
      const persisted = applyRenderResult(db, run, page, render);
      const persistenceDurationMs = performance.now() - persistenceStartedAt;
      renderedUrls += 1;
      db.prepare('UPDATE runs SET renderedPagesCount=renderedPagesCount+1 WHERE id=?').run(run.id);
      if (render.renderStatus === 'technical_error') browserFailures += 1;
      runtimeMetrics?.recordRenderUsage({ durationMs: renderDurationMs, failure: render.renderStatus === 'technical_error' });
      runtimeMetrics?.recordUrl({
        ...metricForPlanRow(row, run),
        budgetStatus: actualBudget,
        resultingBrowserRun: true,
        browserNavigationDurationMs: render.browserNavigationDurationMs,
        settlingDurationMs: render.settlingDurationMs,
        snapshotCount: render.renderSnapshotCount,
        persistenceDurationMs: Number(priorMetric.persistenceDurationMs || 0) + persistenceDurationMs,
        totalUrlDurationMs: Number(priorMetric.totalUrlDurationMs || 0) + renderDurationMs + persistenceDurationMs,
        renderProvenanceBytes: persisted.provenanceBytes,
        networkRequestCount: render.networkRequestCount,
        failedRequestCount: render.failedRequestCount,
        finalSettlingStatus: render.settlingStatus,
        renderStatus: render.renderStatus,
        measurementError: render.navigationError
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { ...plan.summary, renderedUrls, browserFailures, plan };
}

function loadEligiblePages(db, runId) {
  return db.prepare(`
    SELECT p.*, tc.clusterKey AS templateClusterKey,
      COALESCE((SELECT COUNT(*) FROM resources r WHERE r.runId=p.runId AND r.pageUrl=p.finalUrl AND r.resourceType='script'), 0) AS scriptCount,
      0 AS hydrationBytes
    FROM pages p
    LEFT JOIN template_clusters tc ON tc.runId=p.runId AND tc.id=p.templateClusterId
    WHERE p.runId=? AND p.statusCode BETWEEN 200 AND 299
      AND (LOWER(COALESCE(p.contentType,'')) LIKE 'text/html%' OR LOWER(COALESCE(p.contentType,'')) LIKE 'application/xhtml+xml%')
    ORDER BY p.url
  `).all(runId);
}

function priorRenderObservations(db, runId) {
  const rows = db.prepare('SELECT settlingDurationMs, renderProvenanceBytes FROM url_runtime_metrics WHERE runId=? AND resultingBrowserRun=1').all(runId);
  return { medianDurationMs: median(rows.map((row) => row.settlingDurationMs)), medianBytes: median(rows.map((row) => row.renderProvenanceBytes)) };
}

function metricForPlanRow(row, run) {
  return {
    url: row.url,
    pageType: row.pageType,
    rawContentClass: row.classification.rawClass,
    templateClusterKey: row.templateClusterKey,
    renderStrategy: 'deterministic_gate',
    renderNeed: row.classification.decision,
    renderDecision: row.executionDecision,
    reason: { summary: row.classification.reason, priorityKey: row.priorityKey },
    renderSignals: row.classification.signals,
    renderNegativeSignals: row.classification.negativeSignals,
    renderSignalContributions: row.classification.signalContributions,
    renderRecommendationScore: row.classification.recommendationScore,
    renderRecommendationThreshold: row.classification.recommendationThreshold,
    renderCheckRequirements: row.classification.checkRequirements,
    renderUnmetPrerequisites: row.classification.unmetPrerequisites,
    renderConfidence: row.classification.confidence,
    requestedCheckFamilies: row.classification.requestedCheckFamilies,
    budgetStatus: { reason: row.budgetReason, configured: budgetConfiguration(run) },
    resultingBrowserRun: false
  };
}

function actualBudgetStatus(db, run, browserFailures) {
  const usage = db.prepare(`SELECT COUNT(*) AS renderedUrls,
    COALESCE((SELECT renderDurationMs FROM run_runtime_metrics WHERE runId=?),
      SUM(COALESCE(browserNavigationDurationMs,0) + COALESCE(settlingDurationMs,0)),0) AS renderTimeMs,
    COALESCE(SUM(renderProvenanceBytes),0) AS persistedBytes
    FROM url_runtime_metrics WHERE runId=? AND resultingBrowserRun=1`).get(run.id, run.id);
  return evaluateRuntimeRenderBudget(run, { ...usage, browserFailures });
}

export function evaluateRuntimeRenderBudget(run, usage = {}) {
  const tests = [
    ['max_rendered_urls', run.maxRenderedUrls, usage.renderedUrls],
    ['max_total_render_time_ms', run.maxTotalRenderTimeMs, usage.renderTimeMs],
    ['max_persisted_render_bytes', run.maxPersistedRenderBytes, usage.persistedBytes],
    ['max_browser_failures', run.maxBrowserFailures, usage.browserFailures]
  ];
  const exhausted = tests.find(([name, limit, used]) => limit !== null && limit !== undefined
    && (name === 'max_browser_failures' ? Number(used) > 0 && Number(used) >= Number(limit) : Number(used) >= Number(limit)));
  return { allowed: !exhausted, reason: exhausted?.[0] || null, usage, configured: budgetConfiguration(run) };
}

function budgetConfiguration(run) {
  return {
    maxRenderedUrls: run.maxRenderedUrls ?? null,
    maxTotalRenderTimeMs: run.maxTotalRenderTimeMs ?? null,
    maxSettlingTimeMsPerUrl: run.maxSettlingTimeMsPerUrl ?? null,
    maxBrowserFailures: run.maxBrowserFailures ?? null,
    maxPersistedRenderBytes: run.maxPersistedRenderBytes ?? null
  };
}

function applyRenderResult(db, run, page, render) {
  const raw = safeJson(page.rawDocumentStateJson, null);
  const initial = safeJson(render.initialRenderedStateJson, null);
  const settled = safeJson(render.settledRenderedStateJson, null);
  const effectiveDocumentState = buildEffectiveDocumentState(raw, initial, settled, render);
  const effective = Object.fromEntries(Object.entries(effectiveDocumentState.fields || {}).map(([key, value]) => [key, value.effective]));
  const complete = ['settled', 'content_remained_empty'].includes(render.settlingStatus) ? 1 : 0;
  const textFacts = safeJson(page.textFactsJson, {});
  textFacts.rendered_visible_text = render.renderStatus === 'success'
    ? { length: render.renderedVisibleTextLength, hash: render.renderedVisibleTextHash }
    : null;
  const fields = {
    wordCountRendered: render.wordCountRendered,
    renderedTextLength: render.renderedTextLength,
    renderedVisibleTextLength: render.renderedVisibleTextLength,
    textFactsJson: JSON.stringify(textFacts),
    renderedH1Json: render.renderedH1Json,
    renderedH1Count: render.renderedH1Count,
    renderedLinksCount: render.renderedLinksCount,
    consoleErrorsJson: render.consoleErrorsJson,
    pageErrorsJson: render.pageErrorsJson,
    requestFailuresJson: render.requestFailuresJson,
    cspViolationsJson: render.cspViolationsJson,
    navigationError: render.navigationError,
    renderStatus: render.renderStatus,
    settlingStatus: render.settlingStatus,
    settlingDurationMs: render.settlingDurationMs,
    renderSnapshotCount: render.renderSnapshotCount,
    renderFingerprint: render.renderFingerprint,
    initialRenderedStateJson: render.initialRenderedStateJson,
    settledRenderedStateJson: render.settledRenderedStateJson,
    effectiveDocumentStateJson: JSON.stringify(effectiveDocumentState),
    renderProvenanceJson: render.renderProvenanceJson,
    browserEventsJson: render.browserEventsJson,
    renderProvenanceVersion: RENDER_PROVENANCE_VERSION,
    settlingPolicyVersion: SETTLING_POLICY_VERSION,
    metadataProvenanceComplete: complete,
    effectiveTitle: effective.title ?? null,
    effectiveMetaDescription: effective.metaDescription ?? null,
    effectiveCanonical: effective.canonical ?? null,
    effectiveHtmlLang: effective.htmlLang ?? null,
    effectiveMetaRobots: Array.isArray(effective.robots) ? effective.robots.join(', ') : null,
    effectiveH1Json: JSON.stringify(effective.h1 || []),
    effectiveH1Count: Array.isArray(effective.h1) ? effective.h1.length : null,
    effectiveWordCount: effective.visibleText?.wordCount ?? null,
    effectiveMainWordCount: effective.mainText?.wordCount ?? null,
    effectiveInternalLinksCount: Array.isArray(effective.internalLinks) ? effective.internalLinks.filter((link) => isInternalUrl(link, run.finalDomain)).length : null,
    effectiveOgJson: JSON.stringify(effective.openGraph || {}),
    effectiveTwitterJson: JSON.stringify(effective.twitter || {}),
    effectiveHreflangJson: JSON.stringify(effective.hreflang || []),
    effectiveSchemaTypesJson: JSON.stringify(effective.structuredData?.types || [])
  };
  const names = Object.keys(fields);
  db.prepare(`UPDATE pages SET ${names.map((name) => `${name}=@${name}`).join(', ')} WHERE runId=@runId AND id=@id`).run({ ...fields, runId: run.id, id: page.id });
  mergeRenderedResources(db, run.id, page.finalUrl || page.url, render.resources || []);
  return { provenanceBytes: serializedRenderProvenanceBytes(fields), complete };
}

function mergeRenderedResources(db, runId, pageUrl, resources) {
  const insert = db.prepare(`INSERT INTO resources (
    runId,pageUrl,resourceUrl,resourceType,statusCode,sizeBytes,contentType,isThirdParty,responseHeadersJson,sizeMeasurementKind,sizeMeasurementError
  ) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (
    SELECT 1 FROM resources WHERE runId=? AND pageUrl=? AND resourceUrl=? AND resourceType=?
  )`);
  const tx = db.transaction(() => {
    for (const resource of resources) insert.run(
      runId, pageUrl, resource.resourceUrl, resource.resourceType, resource.statusCode ?? null,
      resource.sizeBytes ?? null, resource.contentType || null, resource.isThirdParty ? 1 : 0,
      resource.responseHeadersJson || null, resource.sizeMeasurementKind || null, resource.sizeMeasurementError || null,
      runId, pageUrl, resource.resourceUrl, resource.resourceType
    );
  });
  tx();
}

function markEvidenceIncomplete(db, runId, url) {
  db.prepare('UPDATE pages SET metadataProvenanceComplete=0 WHERE runId=? AND (url=? OR finalUrl=? OR normalizedUrl=?)').run(runId, url, url, url);
}

function markTechnicalRenderFailure(db, runId, url, message) {
  db.prepare(`UPDATE pages SET metadataProvenanceComplete=0, renderStatus='technical_error',
    settlingStatus='technical_error', navigationError=?
    WHERE runId=? AND (url=? OR finalUrl=? OR normalizedUrl=?)`).run(message, runId, url, url, url);
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
