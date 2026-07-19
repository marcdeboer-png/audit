import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { estimateRenderCost, percentile, RUNTIME_METRICS_VERSION } from '../rendering/renderPlanner.js';

export function createRuntimeMetricsTracker(db, run) {
  const mode = run.metricsMode || 'basic';
  const enabled = mode !== 'off';
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const memoryBefore = enabled ? process.memoryUsage() : null;
  const cpuBefore = enabled ? process.cpuUsage() : null;
  const databaseBytesBefore = enabled ? databaseSizeBytes(db) : null;
  let rssPeak = memoryBefore?.rss ?? null;
  let heapPeak = memoryBefore?.heapUsed ?? null;
  let sampler = null;
  const phases = new Map();

  if (enabled) {
    db.prepare(`
      INSERT INTO run_runtime_metrics (
        runId, metricsMode, metricsVersion, runStartedAt,
        processRssBefore, heapUsedBefore, databaseBytesBefore
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runId) DO UPDATE SET
        metricsMode=excluded.metricsMode, metricsVersion=excluded.metricsVersion,
        runStartedAt=excluded.runStartedAt, processRssBefore=excluded.processRssBefore,
        heapUsedBefore=excluded.heapUsedBefore, databaseBytesBefore=excluded.databaseBytesBefore
    `).run(run.id, mode, RUNTIME_METRICS_VERSION, startedAt, memoryBefore?.rss ?? null, memoryBefore?.heapUsed ?? null, databaseBytesBefore);
  }
  if (mode === 'profiling') {
    sampler = setInterval(() => observeProcess(), 250);
    sampler.unref?.();
  }

  function observeProcess() {
    if (!enabled) return null;
    const memory = process.memoryUsage();
    rssPeak = Math.max(rssPeak ?? memory.rss, memory.rss);
    heapPeak = Math.max(heapPeak ?? memory.heapUsed, memory.heapUsed);
    return memory;
  }

  function startPhase(name) {
    if (!enabled) return;
    phases.set(name, performance.now());
  }

  function endPhase(name) {
    if (!enabled || !phases.has(name)) return null;
    const duration = Math.max(0, performance.now() - phases.get(name));
    phases.delete(name);
    const column = {
      checks: 'checkExecutionDurationMs',
      report: 'reportGenerationDurationMs',
      browser_launch: 'browserLaunchDurationMs'
    }[name];
    if (column) db.prepare(`UPDATE run_runtime_metrics SET ${column} = COALESCE(${column}, 0) + ? WHERE runId = ?`).run(Math.round(duration), run.id);
    observeProcess();
    return duration;
  }

  function recordBrowserLaunch({ success, restart = false } = {}) {
    if (!enabled) return;
    db.prepare(`
      UPDATE run_runtime_metrics
      SET browserLaunchCount = browserLaunchCount + 1,
          browserRestartCount = browserRestartCount + ?,
          browserFailureCount = browserFailureCount + ?
      WHERE runId = ?
    `).run(restart ? 1 : 0, success ? 0 : 1, run.id);
    observeProcess();
  }

  function recordUrl(metric = {}) {
    if (!enabled) return;
    upsertUrlRuntimeMetric(db, run.id, metric);
    observeProcess();
  }

  function recordRenderUsage({ durationMs = 0, failure = false } = {}) {
    if (!enabled) return;
    db.prepare(`
      UPDATE run_runtime_metrics
      SET renderDurationMs = renderDurationMs + ?,
          browserFailureCount = browserFailureCount + ?
      WHERE runId = ?
    `).run(Math.max(0, Math.round(durationMs || 0)), failure ? 1 : 0, run.id);
    observeProcess();
  }

  function finish({ status = 'completed' } = {}) {
    if (sampler) clearInterval(sampler);
    if (!enabled) return null;
    const memoryAfter = observeProcess();
    const cpu = process.cpuUsage(cpuBefore);
    const finishedAtMs = Date.now();
    const summary = summarizeRuntimeMetrics(db, run.id);
    const databaseBytesAfter = databaseSizeBytes(db);
    db.prepare(`
      UPDATE run_runtime_metrics SET
        runFinishedAt=?, totalDurationMs=?, processRssPeak=?, processRssAfter=?,
        heapUsedPeak=?, heapUsedAfter=?, cpuUserMs=?, cpuSystemMs=?,
        databaseBytesAfter=?, databaseBytesDelta=?, renderedUrlCount=?, nonRenderedUrlCount=?,
        rawFetchDurationMs=?,
        settlingTimeoutCount=?, renderingUnstableCount=?, navigationFailureCount=?,
        renderProvenanceRecordCount=?, renderProvenanceBytesTotal=?,
        renderProvenanceBytesAverage=?, renderProvenanceBytesMedian=?,
        renderProvenanceBytesP90=?, renderProvenanceBytesP95=?, renderProvenanceBytesMaximum=?,
        summaryJson=?, completionStatus=?
      WHERE runId=?
    `).run(
      new Date(finishedAtMs).toISOString(), finishedAtMs - startedAtMs,
      rssPeak, memoryAfter?.rss ?? null, heapPeak, memoryAfter?.heapUsed ?? null,
      cpu?.user === undefined ? null : Math.round(cpu.user / 1000),
      cpu?.system === undefined ? null : Math.round(cpu.system / 1000),
      databaseBytesAfter,
      databaseBytesAfter === null || databaseBytesBefore === null ? null : databaseBytesAfter - databaseBytesBefore,
      summary.renderedUrlCount, summary.nonRenderedUrlCount,
      summary.rawFetchDurationMs,
      summary.settlingTimeoutCount, summary.renderingUnstableCount, summary.navigationFailureCount,
      summary.renderProvenanceRecordCount, summary.renderProvenanceBytesTotal,
      summary.renderProvenanceBytesAverage, summary.renderProvenanceBytesMedian,
      summary.renderProvenanceBytesP90, summary.renderProvenanceBytesP95, summary.renderProvenanceBytesMaximum,
      JSON.stringify(summary), status, run.id
    );
    return db.prepare('SELECT * FROM run_runtime_metrics WHERE runId = ?').get(run.id);
  }

  return { enabled, mode, startPhase, endPhase, observeProcess, recordBrowserLaunch, recordUrl, recordRenderUsage, finish };
}

export function upsertUrlRuntimeMetric(db, runId, metric = {}) {
  const values = {
    runId,
    url: metric.url,
    pageType: metric.pageType || 'other',
    rawContentClass: metric.rawContentClass || null,
    templateClusterKey: metric.templateClusterKey || null,
    renderStrategy: metric.renderStrategy || 'raw_only',
    renderNeed: metric.renderNeed || null,
    renderDecision: metric.renderDecision || null,
    renderDecisionReasonJson: json(metric.renderDecisionReason || metric.reason || {}),
    renderSignalsJson: json(metric.renderSignals || []),
    renderUnmetPrerequisitesJson: json(metric.renderUnmetPrerequisites || []),
    renderConfidence: metric.renderConfidence || null,
    requestedCheckFamiliesJson: json(metric.requestedCheckFamilies || []),
    budgetStatusJson: json(metric.budgetStatus || {}),
    resultingBrowserRun: metric.resultingBrowserRun ? 1 : 0,
    rawFetchDurationMs: finite(metric.rawFetchDurationMs),
    browserNavigationDurationMs: finite(metric.browserNavigationDurationMs),
    settlingDurationMs: finite(metric.settlingDurationMs),
    snapshotCount: finite(metric.snapshotCount),
    extractionDurationMs: finite(metric.extractionDurationMs),
    persistenceDurationMs: finite(metric.persistenceDurationMs),
    totalUrlDurationMs: finite(metric.totalUrlDurationMs),
    rawHtmlBytes: finite(metric.rawHtmlBytes),
    renderProvenanceBytes: finite(metric.renderProvenanceBytes),
    networkRequestCount: finite(metric.networkRequestCount),
    failedRequestCount: finite(metric.failedRequestCount),
    finalSettlingStatus: metric.finalSettlingStatus || null,
    renderStatus: metric.renderStatus || null,
    measurementError: metric.measurementError || null,
    metricsVersion: RUNTIME_METRICS_VERSION
  };
  db.prepare(`
    INSERT INTO url_runtime_metrics (
      runId,url,pageType,rawContentClass,templateClusterKey,renderStrategy,renderNeed,renderDecision,
      renderDecisionReasonJson,renderSignalsJson,renderUnmetPrerequisitesJson,
      renderConfidence,requestedCheckFamiliesJson,budgetStatusJson,resultingBrowserRun,
      rawFetchDurationMs,browserNavigationDurationMs,settlingDurationMs,snapshotCount,
      extractionDurationMs,persistenceDurationMs,totalUrlDurationMs,rawHtmlBytes,
      renderProvenanceBytes,networkRequestCount,failedRequestCount,finalSettlingStatus,
      renderStatus,measurementError,metricsVersion
    ) VALUES (
      @runId,@url,@pageType,@rawContentClass,@templateClusterKey,@renderStrategy,@renderNeed,@renderDecision,
      @renderDecisionReasonJson,@renderSignalsJson,@renderUnmetPrerequisitesJson,
      @renderConfidence,@requestedCheckFamiliesJson,@budgetStatusJson,@resultingBrowserRun,
      @rawFetchDurationMs,@browserNavigationDurationMs,@settlingDurationMs,@snapshotCount,
      @extractionDurationMs,@persistenceDurationMs,@totalUrlDurationMs,@rawHtmlBytes,
      @renderProvenanceBytes,@networkRequestCount,@failedRequestCount,@finalSettlingStatus,
      @renderStatus,@measurementError,@metricsVersion
    ) ON CONFLICT(runId,url) DO UPDATE SET
      pageType=excluded.pageType, rawContentClass=COALESCE(excluded.rawContentClass,url_runtime_metrics.rawContentClass),
      templateClusterKey=COALESCE(excluded.templateClusterKey,url_runtime_metrics.templateClusterKey),
      renderStrategy=excluded.renderStrategy, renderNeed=excluded.renderNeed,
      renderDecision=excluded.renderDecision, renderDecisionReasonJson=excluded.renderDecisionReasonJson,
      renderSignalsJson=excluded.renderSignalsJson, renderUnmetPrerequisitesJson=excluded.renderUnmetPrerequisitesJson,
      renderConfidence=excluded.renderConfidence, requestedCheckFamiliesJson=excluded.requestedCheckFamiliesJson,
      budgetStatusJson=excluded.budgetStatusJson, resultingBrowserRun=excluded.resultingBrowserRun,
      rawFetchDurationMs=COALESCE(excluded.rawFetchDurationMs,url_runtime_metrics.rawFetchDurationMs),
      browserNavigationDurationMs=COALESCE(excluded.browserNavigationDurationMs,url_runtime_metrics.browserNavigationDurationMs),
      settlingDurationMs=COALESCE(excluded.settlingDurationMs,url_runtime_metrics.settlingDurationMs),
      snapshotCount=COALESCE(excluded.snapshotCount,url_runtime_metrics.snapshotCount),
      extractionDurationMs=COALESCE(excluded.extractionDurationMs,url_runtime_metrics.extractionDurationMs),
      persistenceDurationMs=COALESCE(excluded.persistenceDurationMs,url_runtime_metrics.persistenceDurationMs),
      totalUrlDurationMs=COALESCE(excluded.totalUrlDurationMs,url_runtime_metrics.totalUrlDurationMs),
      rawHtmlBytes=COALESCE(excluded.rawHtmlBytes,url_runtime_metrics.rawHtmlBytes),
      renderProvenanceBytes=COALESCE(excluded.renderProvenanceBytes,url_runtime_metrics.renderProvenanceBytes),
      networkRequestCount=COALESCE(excluded.networkRequestCount,url_runtime_metrics.networkRequestCount),
      failedRequestCount=COALESCE(excluded.failedRequestCount,url_runtime_metrics.failedRequestCount),
      finalSettlingStatus=COALESCE(excluded.finalSettlingStatus,url_runtime_metrics.finalSettlingStatus),
      renderStatus=COALESCE(excluded.renderStatus,url_runtime_metrics.renderStatus),
      measurementError=COALESCE(excluded.measurementError,url_runtime_metrics.measurementError),
      metricsVersion=excluded.metricsVersion, updatedAt=CURRENT_TIMESTAMP
  `).run(values);
}

export function summarizeRuntimeMetrics(db, runId) {
  const rows = db.prepare('SELECT * FROM url_runtime_metrics WHERE runId = ? ORDER BY url').all(runId);
  const runMetric = db.prepare('SELECT browserLaunchDurationMs FROM run_runtime_metrics WHERE runId = ?').get(runId) || {};
  const settling = rows.map((row) => row.settlingDurationMs).filter(Number.isFinite);
  const snapshots = rows.map((row) => row.snapshotCount).filter(Number.isFinite);
  const bytes = rows.filter((row) => row.resultingBrowserRun && Number.isFinite(row.renderProvenanceBytes)).map((row) => row.renderProvenanceBytes);
  const rendered = rows.filter((row) => row.resultingBrowserRun);
  const rawFetch = rows.map((row) => row.rawFetchDurationMs).filter(Number.isFinite);
  const renderCost = rendered.map((row) => {
    const parts = [row.browserNavigationDurationMs, row.settlingDurationMs].filter(Number.isFinite);
    return parts.length ? sum(parts) : null;
  }).filter(Number.isFinite);
  const changedAfter = changeTimingDistribution(db, runId);
  const stabilityShape = semanticStabilityShape(db, runId);
  const forecastInput = {
    renderShare: rows.length ? rendered.length / rows.length : 0,
    rawFetchMs: percentile(rawFetch, 0.5) || 0,
    browserLaunchMs: Number(runMetric.browserLaunchDurationMs || 0),
    p50RenderMs: percentile(renderCost, 0.5) || 0,
    p90RenderMs: percentile(renderCost, 0.9) || 0,
    bytesPerRender: average(bytes) || 0,
    concurrency: 1
  };
  const forecastMissing = [];
  if (!rows.length) forecastMissing.push('url_measurements');
  if (rawFetch.length !== rows.length) forecastMissing.push('raw_fetch_duration');
  if (rendered.length && renderCost.length !== rendered.length) forecastMissing.push('render_duration');
  if (rendered.length && bytes.length !== rendered.length) forecastMissing.push('render_provenance_bytes');
  if (rendered.length && !Number.isFinite(runMetric.browserLaunchDurationMs)) forecastMissing.push('browser_launch_duration');
  return {
    metricsVersion: RUNTIME_METRICS_VERSION,
    urlCount: rows.length,
    renderedUrlCount: rendered.length,
    nonRenderedUrlCount: rows.length - rendered.length,
    avoidedRenderCount: rows.filter((row) => !row.resultingBrowserRun && row.renderDecision === 'render_not_required').length,
    budgetExcludedCount: rows.filter((row) => row.renderDecision === 'render_budget_exhausted').length,
    renderUnavailableCount: rows.filter((row) => row.renderDecision === 'render_unavailable').length,
    settlingTimeoutCount: rows.filter((row) => row.finalSettlingStatus === 'settling_timeout').length,
    renderingUnstableCount: rows.filter((row) => row.finalSettlingStatus === 'rendering_unstable').length,
    navigationFailureCount: rows.filter((row) => row.finalSettlingStatus === 'navigation_failed').length,
    rawFetchDurationMs: sum(rows.map((row) => row.rawFetchDurationMs).filter(Number.isFinite)),
    extractionDurationMs: sum(rows.map((row) => row.extractionDurationMs).filter(Number.isFinite)),
    persistenceDurationMs: sum(rows.map((row) => row.persistenceDurationMs).filter(Number.isFinite)),
    totalUrlDurationMs: sum(rows.map((row) => row.totalUrlDurationMs).filter(Number.isFinite)),
    settlingDuration: distribution(settling),
    snapshotCount: distribution(snapshots),
    byPageType: groupedDistribution(rows, 'pageType'),
    byRawContentClass: groupedDistribution(rows, 'rawContentClass'),
    byRenderDecision: groupedDistribution(rows, 'renderDecision'),
    bySettlingStatus: groupedDistribution(rows, 'finalSettlingStatus'),
    changeTiming: changedAfter,
    semanticStability: stabilityShape,
    renderProvenanceRecordCount: bytes.length,
    renderProvenanceBytesTotal: sum(bytes),
    renderProvenanceBytesAverage: average(bytes),
    renderProvenanceBytesMedian: percentile(bytes, 0.5),
    renderProvenanceBytesP90: percentile(bytes, 0.9),
    renderProvenanceBytesP95: percentile(bytes, 0.95),
    renderProvenanceBytesMaximum: bytes.length ? Math.max(...bytes) : null,
    costForecastStatus: forecastMissing.length ? 'unavailable_incomplete_measurements' : 'available',
    costForecastMissing: forecastMissing,
    costForecasts: forecastMissing.length ? [] : [10, 100, 1000, 10000].map((urlCount) => estimateRenderCost({ ...forecastInput, urlCount }))
  };
}

function semanticStabilityShape(db, runId) {
  const rows = db.prepare('SELECT renderProvenanceJson FROM pages WHERE runId=? AND renderProvenanceJson IS NOT NULL').all(runId);
  let measured = 0;
  let stableWithoutSemanticChange = 0;
  for (const row of rows) {
    const snapshots = safeJson(row.renderProvenanceJson, {}).snapshots || [];
    if (!snapshots.length) continue;
    measured += 1;
    const fingerprints = new Set(snapshots.map((snapshot) => snapshot.semanticFingerprint).filter(Boolean));
    if (fingerprints.size === 1) stableWithoutSemanticChange += 1;
  }
  return {
    measured,
    stableWithoutSemanticChange,
    stableWithoutSemanticChangeRate: measured ? stableWithoutSemanticChange / measured : null
  };
}

export function serializedRenderProvenanceBytes(values = {}) {
  const fields = ['initialRenderedStateJson', 'settledRenderedStateJson', 'effectiveDocumentStateJson', 'renderProvenanceJson', 'browserEventsJson'];
  const present = fields.map((field) => values[field]).filter((value) => typeof value === 'string');
  return present.length ? present.reduce((total, value) => total + Buffer.byteLength(value), 0) : null;
}

function changeTimingDistribution(db, runId) {
  const rows = db.prepare('SELECT renderProvenanceJson FROM pages WHERE runId = ? AND renderProvenanceJson IS NOT NULL').all(runId);
  const thresholds = [1000, 2000, 3000, 4000, 5000, 6000];
  const counts = Object.fromEntries(thresholds.map((value) => [String(value), 0]));
  let measured = 0;
  for (const row of rows) {
    const provenance = safeJson(row.renderProvenanceJson, {});
    const snapshots = provenance.snapshots || [];
    if (snapshots.length < 2) continue;
    measured += 1;
    const first = snapshots[0];
    for (const threshold of thresholds) {
      const timed = snapshots.map((snapshot) => ({
        snapshot,
        elapsed: Date.parse(snapshot.observedAt) - Date.parse(first.observedAt)
      })).filter((item) => Number.isFinite(item.elapsed));
      const baseline = timed.filter((item) => item.elapsed <= threshold).at(-1)?.snapshot || first;
      const changed = timed.some((item) => item.elapsed > threshold && item.snapshot.semanticFingerprint !== baseline.semanticFingerprint);
      if (changed) counts[String(threshold)] += 1;
    }
  }
  return { measured, changedAfterMs: counts };
}

function groupedDistribution(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field] || 'unknown';
    const values = groups.get(key) || [];
    if (Number.isFinite(row.settlingDurationMs)) values.push(row.settlingDurationMs);
    groups.set(key, values);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, { count: rows.filter((row) => (row[field] || 'unknown') === key).length, settlingDuration: distribution(values) }]));
}

function distribution(values) {
  return {
    count: values.length,
    mean: average(values),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    maximum: values.length ? Math.max(...values) : null
  };
}

function databaseSizeBytes(db) {
  try {
    const row = db.prepare('PRAGMA database_list').all().find((item) => item.name === 'main');
    if (!row?.file || row.file === ':memory:') return null;
    const mainBytes = fs.statSync(row.file).size;
    const walBytes = fs.existsSync(`${row.file}-wal`) ? fs.statSync(`${row.file}-wal`).size : 0;
    return mainBytes + walBytes;
  } catch {
    return null;
  }
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values) {
  return values.length ? sum(values) / values.length : null;
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
