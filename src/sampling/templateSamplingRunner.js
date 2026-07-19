import path from 'node:path';
import { clearSamplingArtifacts, getRunWithProject, logRun, updateRun } from '../db/repositories.js';
import { crawlerDefaults } from '../crawler/defaults.js';
import { createPlaywrightSampler } from './playwrightSampler.js';
import { createLighthouseSampler } from './lighthouseSampler.js';
import { aggregateTemplatePerformance } from './templatePerformanceAggregator.js';

export async function runTemplateSampling(db, runId, runtimeMetrics = null) {
  const run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  clearSamplingArtifacts(db, runId);

  if (!run.enableTemplateSampling) {
    logRun(db, runId, 'info', 'Template sampling disabled');
    aggregateTemplatePerformance(db, runId);
    return { samples: 0, skipped: true };
  }

  updateRun(db, runId, {
    currentPhase: 'sampling',
    samplesTotal: 0,
    samplesProcessed: 0,
    currentSampleUrl: null
  });

  const samples = loadTemplateSamples(db, runId, {
    maxTemplateSamplesTotal: run.maxTemplateSamplesTotal || crawlerDefaults.maxTemplateSamplesTotal,
    sampleOnlyIndexable: Boolean(run.sampleOnlyIndexable)
  });

  updateRun(db, runId, { samplesTotal: samples.length, samplesProcessed: 0 });
  logRun(db, runId, 'info', 'Template sampling prepared', {
    samples: samples.length,
    enablePlaywrightSampling: Boolean(run.enablePlaywrightSampling),
    enableLighthouseSampling: Boolean(run.enableLighthouseSampling)
  });

  let playwrightSampler = null;
  let lighthouseSampler = null;
  try {
    const needsPlaywrightBrowser = run.enablePlaywrightSampling && samples.some((sample) => !hasReusableRenderedEvidence(sample));
    if (needsPlaywrightBrowser) {
      updateRun(db, runId, { currentPhase: 'playwright_sampling' });
      runtimeMetrics?.startPhase('browser_launch');
      playwrightSampler = await createPlaywrightSampler({
        finalDomain: run.finalDomain,
        timeoutMs: run.playwrightTimeoutMs || crawlerDefaults.playwrightTimeoutMs,
        userAgent: run.userAgent || crawlerDefaults.userAgent,
        collectScreenshots: Boolean(run.collectScreenshots),
        settling: {
          maxDurationMs: run.renderSettlingMaxMs,
          intervalMs: run.renderSettlingIntervalMs,
          maxSnapshots: run.renderSettlingMaxSnapshots,
          stableSnapshots: run.renderSettlingStableSnapshots,
          minimumObservationMs: run.renderSettlingMinimumObservationMs
        },
        screenshotDir: path.join(process.cwd(), 'reports', 'screenshots', `run-${runId}`),
        log: (level, message, data) => logRun(db, runId, level, message, data)
      });
      runtimeMetrics?.endPhase('browser_launch');
      runtimeMetrics?.recordBrowserLaunch({ success: Boolean(playwrightSampler.available) });
    }
    if (run.enableLighthouseSampling) {
      updateRun(db, runId, { currentPhase: 'lighthouse_sampling' });
      lighthouseSampler = await createLighthouseSampler({
        device: run.lighthouseDevice || crawlerDefaults.lighthouseDevice,
        categories: safeJson(run.lighthouseCategoriesJson, crawlerDefaults.lighthouseCategories),
        timeoutMs: run.lighthouseTimeoutMs || crawlerDefaults.lighthouseTimeoutMs,
        log: (level, message, data) => logRun(db, runId, level, message, data)
      });
    }

    let processed = 0;
    for (const sample of samples) {
      updateRun(db, runId, {
        currentPhase: 'sampling',
        currentSampleUrl: sample.url
      });
      const sampleResultId = insertSampleResult(db, runId, sample, {
        playwrightStatus: run.enablePlaywrightSampling ? 'pending' : 'disabled',
        lighthouseStatus: run.enableLighthouseSampling ? 'pending' : 'disabled'
      });
      const errors = [];

      if (run.enablePlaywrightSampling) {
        updateRun(db, runId, { currentPhase: 'playwright_sampling', currentSampleUrl: sample.url });
        const result = hasReusableRenderedEvidence(sample)
          ? reusablePlaywrightResult(sample)
          : await playwrightSampler.sample(sample);
        insertPlaywrightResult(db, runId, sample, result);
        updateSampleStatus(db, sampleResultId, { playwrightStatus: result.status });
        if (result.status !== 'success') errors.push(`Playwright: ${errorFromPlaywright(result, playwrightSampler.unavailableReason)}`);
      }

      if (run.enableLighthouseSampling) {
        updateRun(db, runId, { currentPhase: 'lighthouse_sampling', currentSampleUrl: sample.url });
        const result = await lighthouseSampler.sample(sample);
        const lighthouseStatus = lighthouseSampler.available
          ? (result.errorMessage ? 'error' : 'success')
          : 'unavailable';
        insertLighthouseResult(db, runId, sample, result);
        updateSampleStatus(db, sampleResultId, { lighthouseStatus });
        if (lighthouseStatus !== 'success') errors.push(`Lighthouse: ${result.errorMessage || lighthouseSampler.unavailableReason || 'unavailable'}`);
      }

      if (errors.length) {
        updateSampleStatus(db, sampleResultId, { errorMessage: errors.join(' | ') });
      }
      processed += 1;
      updateRun(db, runId, { samplesProcessed: processed, currentSampleUrl: null });
    }
  } finally {
    if (playwrightSampler) await playwrightSampler.close();
    if (lighthouseSampler) await lighthouseSampler.close();
  }

  const aggregation = aggregateTemplatePerformance(db, runId);
  updateRun(db, runId, {
    currentPhase: 'sampling_complete',
    currentSampleUrl: null,
    samplesProcessed: samples.length
  });
  logRun(db, runId, 'info', 'Template sampling completed', aggregation);
  return { samples: samples.length, ...aggregation };
}

export function loadTemplateSamples(db, runId, {
  maxTemplateSamplesTotal = 200,
  sampleOnlyIndexable = true
} = {}) {
  const clusters = db.prepare(`
    SELECT id, clusterKey, sampleUrlsJson
    FROM template_clusters
    WHERE runId = ?
    ORDER BY urlCount DESC, clusterKey ASC
  `).all(runId);

  const output = [];
  const seen = new Set();
  const findPage = db.prepare(`
    SELECT id, url, finalUrl, normalizedUrl, indexable, title, h1Count, wordCountRaw,
      internalLinksCount, externalLinksCount, renderStatus, settlingStatus,
      settlingDurationMs, renderSnapshotCount, renderFingerprint,
      initialRenderedStateJson, settledRenderedStateJson, renderProvenanceJson,
      browserEventsJson, renderProvenanceVersion, settlingPolicyVersion,
      wordCountRendered, renderedH1Count, renderedLinksCount, consoleErrorsJson,
      pageErrorsJson, requestFailuresJson, cspViolationsJson, navigationError
    FROM pages
    WHERE runId = ? AND (url = ? OR finalUrl = ? OR normalizedUrl = ?)
    ORDER BY id ASC
    LIMIT 1
  `);

  for (const cluster of clusters) {
    const urls = safeJson(cluster.sampleUrlsJson, []);
    for (const url of urls) {
      if (output.length >= maxTemplateSamplesTotal) return output;
      if (!url || seen.has(url)) continue;
      const page = findPage.get(runId, url, url, url);
      if (sampleOnlyIndexable && page && !page.indexable) continue;
      seen.add(url);
      output.push({
        ...(page || {}),
        templateClusterId: cluster.id,
        templateClusterKey: cluster.clusterKey,
        url,
        finalUrl: page?.finalUrl || url,
        sampleReason: 'template_cluster_sample'
      });
    }
  }

  return output;
}

function hasReusableRenderedEvidence(sample) {
  return sample?.renderStatus === 'success'
    && ['settled', 'content_remained_empty'].includes(sample?.settlingStatus)
    && Boolean(sample?.settledRenderedStateJson)
    && Boolean(sample?.renderProvenanceJson);
}

function reusablePlaywrightResult(sample) {
  const settled = safeJson(sample.settledRenderedStateJson, {});
  const initial = safeJson(sample.initialRenderedStateJson, {});
  const consoleErrors = safeJson(sample.consoleErrorsJson, []);
  const pageErrors = safeJson(sample.pageErrorsJson, []);
  const networkErrors = safeJson(sample.requestFailuresJson, []);
  return {
    status: 'success',
    finalUrl: sample.finalUrl || sample.url,
    title: settled.title || sample.title || null,
    h1Count: sample.renderedH1Count ?? settled.h1?.length ?? 0,
    renderedWordCount: sample.wordCountRendered ?? settled.visibleText?.wordCount ?? null,
    renderedLinksCount: sample.renderedLinksCount ?? settled.internalLinks?.length ?? null,
    rawRenderedWordDelta: sample.wordCountRendered === null || sample.wordCountRendered === undefined
      ? null
      : Number(sample.wordCountRendered) - Number(sample.wordCountRaw || 0),
    consoleErrorsCount: consoleErrors.length,
    consoleErrorsJson: sample.consoleErrorsJson || JSON.stringify([]),
    pageErrorsCount: pageErrors.length,
    pageErrorsJson: sample.pageErrorsJson || JSON.stringify([]),
    cspViolationsJson: sample.cspViolationsJson || JSON.stringify([]),
    networkErrorsCount: networkErrors.length,
    networkErrorsJson: sample.requestFailuresJson || JSON.stringify([]),
    navigationError: sample.navigationError || null,
    textNormalizationVersion: settled.visibleText?.normalizationVersion || initial.visibleText?.normalizationVersion || null,
    jsRequiredLikely: Number(sample.wordCountRaw || 0) < 100 && Number(sample.wordCountRendered || 0) > 200 ? 1 : 0,
    screenshotPath: null,
    loadTimeMs: null,
    domContentLoadedMs: null,
    settlingStatus: sample.settlingStatus,
    settlingDurationMs: sample.settlingDurationMs,
    renderSnapshotCount: sample.renderSnapshotCount,
    renderFingerprint: sample.renderFingerprint,
    initialRenderedStateJson: sample.initialRenderedStateJson,
    settledRenderedStateJson: sample.settledRenderedStateJson,
    renderProvenanceJson: sample.renderProvenanceJson,
    browserEventsJson: sample.browserEventsJson || JSON.stringify([]),
    renderProvenanceVersion: sample.renderProvenanceVersion,
    settlingPolicyVersion: sample.settlingPolicyVersion
  };
}

function insertSampleResult(db, runId, sample, statuses) {
  return db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterId, templateClusterKey, url, finalUrl, sampleReason,
      playwrightStatus, lighthouseStatus
    )
    VALUES (
      @runId, @templateClusterId, @templateClusterKey, @url, @finalUrl, @sampleReason,
      @playwrightStatus, @lighthouseStatus
    )
  `).run({
    runId,
    templateClusterId: sample.templateClusterId || null,
    templateClusterKey: sample.templateClusterKey || null,
    url: sample.url,
    finalUrl: sample.finalUrl || null,
    sampleReason: sample.sampleReason || 'template_cluster_sample',
    playwrightStatus: statuses.playwrightStatus,
    lighthouseStatus: statuses.lighthouseStatus
  }).lastInsertRowid;
}

function updateSampleStatus(db, sampleResultId, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`
    UPDATE template_sample_results
    SET ${assignments}, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...entries.map(([, value]) => value), sampleResultId);
}

function insertPlaywrightResult(db, runId, sample, result) {
  db.prepare(`
    INSERT INTO playwright_results (
      runId, templateClusterId, templateClusterKey, url, status, finalUrl, title,
      h1Count, renderedWordCount, renderedLinksCount, rawRenderedWordDelta,
      consoleErrorsCount, consoleErrorsJson, pageErrorsCount, pageErrorsJson, cspViolationsJson,
      networkErrorsCount, networkErrorsJson, navigationError, textNormalizationVersion,
      jsRequiredLikely, screenshotPath, loadTimeMs, domContentLoadedMs,
      settlingStatus, settlingDurationMs, renderSnapshotCount, renderFingerprint,
      initialRenderedStateJson, settledRenderedStateJson, renderProvenanceJson,
      browserEventsJson, renderProvenanceVersion, settlingPolicyVersion
    )
    VALUES (
      @runId, @templateClusterId, @templateClusterKey, @url, @status, @finalUrl, @title,
      @h1Count, @renderedWordCount, @renderedLinksCount, @rawRenderedWordDelta,
      @consoleErrorsCount, @consoleErrorsJson, @pageErrorsCount, @pageErrorsJson, @cspViolationsJson,
      @networkErrorsCount, @networkErrorsJson, @navigationError, @textNormalizationVersion,
      @jsRequiredLikely, @screenshotPath, @loadTimeMs, @domContentLoadedMs,
      @settlingStatus, @settlingDurationMs, @renderSnapshotCount, @renderFingerprint,
      @initialRenderedStateJson, @settledRenderedStateJson, @renderProvenanceJson,
      @browserEventsJson, @renderProvenanceVersion, @settlingPolicyVersion
    )
  `).run({
    runId,
    templateClusterId: sample.templateClusterId || null,
    templateClusterKey: sample.templateClusterKey || null,
    url: sample.url,
    ...result
  });
}

function insertLighthouseResult(db, runId, sample, result) {
  db.prepare(`
    INSERT INTO lighthouse_results (
      runId, templateClusterId, templateClusterKey, url, device, performanceScore,
      accessibilityScore, bestPracticesScore, seoScore, firstContentfulPaintMs,
      largestContentfulPaintMs, totalBlockingTimeMs, cumulativeLayoutShift,
      speedIndexMs, interactiveMs, totalByteWeight, domSize, auditsJson, errorMessage
    )
    VALUES (
      @runId, @templateClusterId, @templateClusterKey, @url, @device, @performanceScore,
      @accessibilityScore, @bestPracticesScore, @seoScore, @firstContentfulPaintMs,
      @largestContentfulPaintMs, @totalBlockingTimeMs, @cumulativeLayoutShift,
      @speedIndexMs, @interactiveMs, @totalByteWeight, @domSize, @auditsJson, @errorMessage
    )
  `).run({
    runId,
    templateClusterId: sample.templateClusterId || null,
    templateClusterKey: sample.templateClusterKey || null,
    url: sample.url,
    ...result
  });
}

function errorFromPlaywright(result, unavailableReason) {
  if (result.status === 'unavailable') return unavailableReason || 'unavailable';
  return result.navigationError || safeJson(result.pageErrorsJson, [])[0] || 'rendering failed';
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
