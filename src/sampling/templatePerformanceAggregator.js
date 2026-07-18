import { VISIBLE_TEXT_NORMALIZATION_VERSION } from '../extractors/visibleText.js';

export function aggregateTemplatePerformance(db, runId) {
  db.prepare('DELETE FROM template_performance_summary WHERE runId = ?').run(runId);

  const clusters = db.prepare(`
    SELECT DISTINCT templateClusterId, templateClusterKey
    FROM template_sample_results
    WHERE runId = ?
    ORDER BY templateClusterKey ASC
  `).all(runId);

  const insert = db.prepare(`
    INSERT INTO template_performance_summary (
      runId, templateClusterId, templateClusterKey, sampleCount,
      playwrightSuccessCount, lighthouseSuccessCount,
      avgPerformanceScore, minPerformanceScore, avgSeoScore, minSeoScore,
      avgAccessibilityScore, avgBestPracticesScore, avgLcpMs, avgTbtMs,
      avgCls, jsRequiredCount, consoleErrorSampleCount, worstSampleUrlsJson
    )
    VALUES (
      @runId, @templateClusterId, @templateClusterKey, @sampleCount,
      @playwrightSuccessCount, @lighthouseSuccessCount,
      @avgPerformanceScore, @minPerformanceScore, @avgSeoScore, @minSeoScore,
      @avgAccessibilityScore, @avgBestPracticesScore, @avgLcpMs, @avgTbtMs,
      @avgCls, @jsRequiredCount, @consoleErrorSampleCount, @worstSampleUrlsJson
    )
  `);

  const tx = db.transaction(() => {
    for (const cluster of clusters) {
      const sampleCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM template_sample_results
        WHERE runId = ? AND COALESCE(templateClusterKey, '') = COALESCE(?, '')
      `).get(runId, cluster.templateClusterKey).count || 0;
      const playwrightRows = db.prepare(`
        SELECT *
        FROM playwright_results
        WHERE runId = ? AND COALESCE(templateClusterKey, '') = COALESCE(?, '')
      `).all(runId, cluster.templateClusterKey);
      const lighthouseRows = db.prepare(`
        SELECT *
        FROM lighthouse_results
        WHERE runId = ? AND COALESCE(templateClusterKey, '') = COALESCE(?, '')
      `).all(runId, cluster.templateClusterKey);
      const lighthouseSuccess = lighthouseRows.filter((row) => !row.errorMessage && hasAnyScore(row));
      const playwrightSuccess = playwrightRows.filter((row) => row.status === 'success' && !row.navigationError);
      const normalizedPlaywrightSuccess = playwrightSuccess.filter((row) => row.textNormalizationVersion === VISIBLE_TEXT_NORMALIZATION_VERSION);
      const channelAwarePlaywrightSuccess = playwrightSuccess.filter((row) =>
        row.consoleErrorsJson !== null && row.pageErrorsJson !== null && row.networkErrorsJson !== null
      );
      const performanceScores = lighthouseSuccess.map((row) => row.performanceScore);
      const seoScores = lighthouseSuccess.map((row) => row.seoScore);

      insert.run({
        runId,
        templateClusterId: cluster.templateClusterId,
        templateClusterKey: cluster.templateClusterKey,
        sampleCount,
        playwrightSuccessCount: playwrightSuccess.length,
        lighthouseSuccessCount: lighthouseSuccess.length,
        avgPerformanceScore: average(performanceScores),
        minPerformanceScore: minimum(performanceScores),
        avgSeoScore: average(seoScores),
        minSeoScore: minimum(seoScores),
        avgAccessibilityScore: average(lighthouseSuccess.map((row) => row.accessibilityScore)),
        avgBestPracticesScore: average(lighthouseSuccess.map((row) => row.bestPracticesScore)),
        avgLcpMs: average(lighthouseSuccess.map((row) => row.largestContentfulPaintMs)),
        avgTbtMs: average(lighthouseSuccess.map((row) => row.totalBlockingTimeMs)),
        avgCls: average(lighthouseSuccess.map((row) => row.cumulativeLayoutShift)),
        jsRequiredCount: normalizedPlaywrightSuccess.filter((row) => row.jsRequiredLikely).length,
        consoleErrorSampleCount: channelAwarePlaywrightSuccess.filter((row) => Number(row.consoleErrorsCount || 0) > 0).length,
        worstSampleUrlsJson: JSON.stringify(worstSamples(playwrightSuccess, lighthouseSuccess))
      });
    }
  });
  tx();

  return {
    templates: clusters.length,
    samples: db.prepare('SELECT COUNT(*) AS count FROM template_sample_results WHERE runId = ?').get(runId).count
  };
}

function hasAnyScore(row) {
  return [row.performanceScore, row.seoScore, row.accessibilityScore, row.bestPracticesScore]
    .some((value) => Number.isFinite(Number(value)));
}

function worstSamples(playwrightRows, lighthouseRows) {
  const byUrl = new Map();
  for (const row of lighthouseRows) {
    byUrl.set(row.url, {
      url: row.url,
      performanceScore: row.performanceScore,
      seoScore: row.seoScore,
      largestContentfulPaintMs: row.largestContentfulPaintMs,
      totalBlockingTimeMs: row.totalBlockingTimeMs,
      cumulativeLayoutShift: row.cumulativeLayoutShift
    });
  }
  for (const row of playwrightRows) {
    const existing = byUrl.get(row.url) || { url: row.url };
    existing.consoleErrorsCount = row.consoleErrorsCount || 0;
    existing.jsRequiredLikely = row.jsRequiredLikely || 0;
    byUrl.set(row.url, existing);
  }
  return [...byUrl.values()]
    .sort((a, b) =>
      nullLast(a.performanceScore, b.performanceScore) ||
      Number(b.largestContentfulPaintMs || 0) - Number(a.largestContentfulPaintMs || 0) ||
      Number(b.totalBlockingTimeMs || 0) - Number(a.totalBlockingTimeMs || 0) ||
      Number(b.consoleErrorsCount || 0) - Number(a.consoleErrorsCount || 0) ||
      String(a.url).localeCompare(String(b.url))
    )
    .slice(0, 5);
}

function nullLast(a, b) {
  const av = Number(a);
  const bv = Number(b);
  const aFinite = Number.isFinite(av);
  const bFinite = Number.isFinite(bv);
  if (!aFinite && !bFinite) return 0;
  if (!aFinite) return 1;
  if (!bFinite) return -1;
  return av - bv;
}

function average(values) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(3));
}

function minimum(values) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return Number(Math.min(...numeric).toFixed(3));
}
