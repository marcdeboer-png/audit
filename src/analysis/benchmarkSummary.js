import fs from 'node:fs';
import { getConfiguredDbPath } from '../db/database.js';
import { buildStorageRealityCheck } from './storageRealityCheck.js';

export function buildBenchmarkSummary(db, runId, options = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return null;
  const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const durationMs = started && finished ? Math.max(0, finished - started) : null;
  const tableCounts = Object.fromEntries([
    'pages',
    'check_results',
    'page_links',
    'page_images',
    'resources',
    'schemas',
    'template_clusters',
    'template_sample_results',
    'playwright_results',
    'lighthouse_results',
    'llm_results'
  ].map((table) => [table, countTable(db, table, runId)]));
  const detailRows = tableCounts.page_links + tableCounts.page_images + tableCounts.resources + tableCounts.schemas;
  const cappedDetails = db.prepare(`
    SELECT COUNT(*) AS count
    FROM check_results
    WHERE runId = ?
      AND (
        evidenceJson LIKE '%"truncated":true%'
        OR evidenceJson LIKE '%"truncated"%'
      )
  `).get(runId).count || 0;
  const dbPath = getConfiguredDbPath();
  const dbSizeBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);
  const exportSizeEstimateBytes = options.exportSizeEstimateBytes ?? estimateExportSizeBytes(db, runId, tableCounts);
  const storageReality = options.storageReality === false ? null : buildStorageRealityCheck(db, runId, {
    detailCheckLimit: options.detailCheckLimit || 100,
    maxRowsPerDetailCheck: options.maxRowsPerDetailCheck || 1000
  });

  return {
    runId,
    generatedAt: new Date().toISOString(),
    sourceType: run.sourceType || 'crawl',
    storageProfile: run.storageProfile || 'standard',
    crawlScaleMode: run.crawlScaleMode || null,
    maxUrls: run.maxUrls,
    processedUrls: run.processedUrls || 0,
    successfulUrls: run.successfulUrls || 0,
    failedUrls: run.failedUrls || 0,
    durationMs,
    durationSeconds: durationMs === null ? null : Number((durationMs / 1000).toFixed(2)),
    urlsPerSecond: durationMs && run.processedUrls ? Number((run.processedUrls / (durationMs / 1000)).toFixed(3)) : null,
    dbSizeBytes,
    exportSizeEstimateBytes,
    memoryRssBytes: process.memoryUsage?.().rss || null,
    urlFacts: tableCounts.pages,
    findings: tableCounts.check_results,
    detailRows,
    cappedDetails,
    tables: tableCounts,
    runSpecificEstimatedBytes: storageReality?.runSpecificEstimatedBytes ?? null,
    estimatedBytesPerUrl: storageReality?.estimatedBytesPerUrl ?? null,
    estimatedSizePer10kUrlsBytes: storageReality?.projections?.estimated10kBytes ?? null,
    estimatedSizePer50kUrlsBytes: storageReality?.projections?.estimated50kBytes ?? null,
    estimatedSizePer500kUrlsBytes: storageReality?.projections?.estimated500kBytes ?? null,
    storageRiskLevel: storageReality?.riskLevel || null,
    storageRecommendations: storageReality?.recommendations || [],
    biggestTables: storageReality?.biggestTables || [],
    biggestDetailChecks: storageReality?.biggestDetailChecks || [],
    cappedDetailChecks: storageReality?.cappedDetailChecks ?? cappedDetails,
    storageRealityCheck: storageReality
  };
}

export function storeBenchmarkSummary(db, runId, options = {}) {
  const summary = buildBenchmarkSummary(db, runId, options);
  if (!summary) return null;
  db.prepare('UPDATE runs SET benchmarkSummaryJson = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(summary), runId);
  return summary;
}

function countTable(db, table, runId) {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE runId = ?`).get(runId).count || 0;
  } catch {
    return 0;
  }
}

function fileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function estimateExportSizeBytes(db, runId, tableCounts) {
  const findingBytes = db.prepare(`
    SELECT SUM(LENGTH(COALESCE(finding, '')) + LENGTH(COALESCE(details, '')) + LENGTH(COALESCE(evidenceJson, ''))) AS bytes
    FROM check_results
    WHERE runId = ?
  `).get(runId).bytes || 0;
  return Math.round(
    findingBytes
    + tableCounts.pages * 900
    + tableCounts.page_links * 180
    + tableCounts.page_images * 220
    + tableCounts.resources * 240
    + tableCounts.schemas * 500
  );
}
