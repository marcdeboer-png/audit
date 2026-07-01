import fs from 'node:fs';
import { getConfiguredDbPath } from '../db/database.js';
import { getCheckDetail } from '../results/checkDetailService.js';

const RUN_TABLES = Object.freeze([
  'pages',
  'page_snapshots',
  'check_results',
  'page_links',
  'page_images',
  'resources',
  'schemas',
  'domain_assets',
  'template_clusters',
  'template_sample_results',
  'template_performance_summary',
  'playwright_results',
  'lighthouse_results',
  'llm_results',
  'import_files',
  'run_logs',
  'validation_reports'
]);

export function buildStorageRealityCheck(db, runId, options = {}) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return null;
  const dbPath = options.dbPath || getConfiguredDbPath();
  const dbSizeBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);
  const allRunsCount = safeGet(db, 'SELECT COUNT(*) AS count FROM runs').count || 0;
  const tableStats = RUN_TABLES
    .filter((table) => tableExists(db, table))
    .map((table) => tableStorageStats(db, table, runId));
  const auditPayloadTableStats = tableStats.filter((row) => row.table !== 'validation_reports');
  const validationArtifactEstimatedBytes = tableStats.find((row) => row.table === 'validation_reports')?.estimatedBytes || 0;
  const runSpecificEstimatedBytes = auditPayloadTableStats.reduce((sum, row) => sum + row.estimatedBytes, 0);
  const urlFacts = countTable(db, 'pages', runId);
  const processedUrls = Number(run.processedUrls || run.successfulUrls || urlFacts || 0);
  const denominatorUrls = Math.max(1, processedUrls || urlFacts || 1);
  const estimatedBytesPerUrl = Math.round(runSpecificEstimatedBytes / denominatorUrls);
  const jsonFieldStats = jsonFieldSizes(db, runId);
  const detailChecks = detailRowsByCheck(db, runId, options);
  const cappedDetailChecks = detailChecks.filter((row) => row.truncated);
  const projections = {
    estimated10kBytes: estimatedBytesPerUrl * 10000,
    estimated50kBytes: estimatedBytesPerUrl * 50000,
    estimated500kBytes: estimatedBytesPerUrl * 500000,
    estimated10kHuman: humanBytes(estimatedBytesPerUrl * 10000),
    estimated50kHuman: humanBytes(estimatedBytesPerUrl * 50000),
    estimated500kHuman: humanBytes(estimatedBytesPerUrl * 500000)
  };
  const risk = storageRisk({
    storageProfile: run.storageProfile,
    processedUrls,
    estimatedBytesPerUrl,
    projections,
    rawSnapshotRows: tableStats.find((row) => row.table === 'page_snapshots')?.rows || 0,
    cappedDetailChecks: cappedDetailChecks.length
  });
  return {
    runId: Number(runId),
    generatedAt: new Date().toISOString(),
    sourceType: run.sourceType || 'crawl',
    storageProfile: run.storageProfile || 'standard',
    crawlScaleMode: run.crawlScaleMode || null,
    processedUrls,
    successfulUrls: Number(run.successfulUrls || 0),
    maxUrls: Number(run.maxUrls || 0),
    globalDbSizeBytes: dbSizeBytes,
    globalDbSizeHuman: humanBytes(dbSizeBytes),
    allRunsCount,
    oldRunsDistortion: allRunsCount > 1
      ? `Global SQLite size includes ${allRunsCount} runs; use runSpecificEstimatedBytes for this run.`
      : 'Global SQLite size is effectively this run only.',
    runSpecificEstimatedBytes,
    runSpecificEstimatedHuman: humanBytes(runSpecificEstimatedBytes),
    validationArtifactEstimatedBytes,
    validationArtifactEstimatedHuman: humanBytes(validationArtifactEstimatedBytes),
    estimatedBytesPerUrl,
    estimatedBytesPerUrlHuman: humanBytes(estimatedBytesPerUrl),
    projections,
    tableStats,
    auditPayloadTableStats,
    biggestTables: [...auditPayloadTableStats].sort((a, b) => b.estimatedBytes - a.estimatedBytes).slice(0, 10),
    jsonFieldStats,
    biggestJsonFields: [...jsonFieldStats].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    detailRowsByCheck: detailChecks,
    biggestDetailChecks: [...detailChecks].sort((a, b) => b.rowCount - a.rowCount || b.affectedCount - a.affectedCount).slice(0, 15),
    cappedDetailChecks: cappedDetailChecks.length,
    riskLevel: risk.level,
    warnings: risk.warnings,
    recommendations: risk.recommendations,
    notes: [
      'Row byte estimates are approximate because SQLite page allocation is not table-attributed.',
      'The run-specific estimate intentionally separates current-run payload from historic runs in the same database.'
    ]
  };
}

export function renderStorageRealityMarkdown(check = {}) {
  const lines = [
    `# Storage Reality Check - Run ${check.runId ?? 'unknown'}`,
    '',
    `Generated: ${check.generatedAt || ''}`,
    '',
    '## Summary',
    '',
    `- Storage profile: ${check.storageProfile || 'unknown'}`,
    `- Source type: ${check.sourceType || 'unknown'}`,
    `- Processed URLs: ${check.processedUrls ?? 0}`,
    `- Global DB size: ${check.globalDbSizeHuman || humanBytes(check.globalDbSizeBytes || 0)}`,
    `- Run-specific estimate: ${check.runSpecificEstimatedHuman || humanBytes(check.runSpecificEstimatedBytes || 0)}`,
    `- Validation/report artifacts on this run: ${check.validationArtifactEstimatedHuman || humanBytes(check.validationArtifactEstimatedBytes || 0)}`,
    `- Estimated bytes per URL: ${check.estimatedBytesPerUrlHuman || humanBytes(check.estimatedBytesPerUrl || 0)}`,
    `- 10k projection: ${check.projections?.estimated10kHuman || 'n/a'}`,
    `- 50k projection: ${check.projections?.estimated50kHuman || 'n/a'}`,
    `- 500k projection: ${check.projections?.estimated500kHuman || 'n/a'}`,
    `- Risk level: ${check.riskLevel || 'unknown'}`,
    '',
    `Old-run distortion: ${check.oldRunsDistortion || 'n/a'}`,
    '',
    '## Biggest Tables',
    '',
    '| Table | Rows | Estimated Size | Notes |',
    '| --- | ---: | ---: | --- |'
  ];
  for (const row of check.biggestTables || []) {
    lines.push(`| ${row.table} | ${row.rows} | ${row.estimatedHuman} | ${md(row.notes || '')} |`);
  }
  lines.push('', '## Biggest Detail Checks', '', '| Check | Status | Rows | Affected | Truncated |', '| --- | --- | ---: | ---: | --- |');
  for (const row of check.biggestDetailChecks || []) {
    lines.push(`| ${md(row.checkId)} | ${md(row.status)} | ${row.rowCount} | ${row.affectedCount} | ${row.truncated ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Warnings', '');
  for (const warning of check.warnings || []) lines.push(`- ${warning}`);
  if (!(check.warnings || []).length) lines.push('- No storage warnings for the current run.');
  lines.push('', '## Recommendations', '');
  for (const recommendation of check.recommendations || []) lines.push(`- ${recommendation}`);
  return `${lines.join('\n')}\n`;
}

function tableStorageStats(db, table, runId) {
  const columns = tableColumns(db, table);
  const hasRunId = columns.some((column) => column.name === 'runId');
  const where = hasRunId ? 'WHERE runId = @runId' : '';
  const rows = hasRunId ? countTable(db, table, runId) : 0;
  if (!hasRunId) {
    return { table, rows: 0, estimatedBytes: 0, estimatedHuman: humanBytes(0), textBytes: 0, numericBytes: 0, notes: 'No runId column; excluded from run estimate.' };
  }
  const textColumns = columns.filter((column) => /TEXT|BLOB/i.test(column.type || '')).map((column) => column.name);
  const numericColumns = columns.filter((column) => /INT|REAL|NUMERIC/i.test(column.type || '')).map((column) => column.name);
  const textBytes = textColumns.length
    ? Number(safeGet(db, `SELECT ${textColumns.map((column) => `SUM(LENGTH(COALESCE(${q(column)}, '')))`).join(' + ')} AS bytes FROM ${q(table)} ${where}`, { runId }).bytes || 0)
    : 0;
  const numericBytes = rows * Math.max(1, numericColumns.length) * 8;
  const overheadBytes = rows * 80;
  const estimatedBytes = Math.round(textBytes + numericBytes + overheadBytes);
  return {
    table,
    rows,
    estimatedBytes,
    estimatedHuman: humanBytes(estimatedBytes),
    textBytes,
    textHuman: humanBytes(textBytes),
    numericBytes,
    overheadBytes,
    notes: noteForTable(table, rows, estimatedBytes)
  };
}

function detailRowsByCheck(db, runId, options = {}) {
  const limit = Number(options.detailCheckLimit || 250);
  const rows = db.prepare(`
    SELECT id, checkId, status, priority, affectedCount
    FROM check_results
    WHERE runId = ?
    ORDER BY CASE status WHEN 'Error' THEN 0 WHEN 'Warning' THEN 1 ELSE 2 END, affectedCount DESC
    LIMIT ?
  `).all(runId, limit);
  return rows.map((row) => {
    try {
      const detail = getCheckDetail(db, runId, row.id, { maxRows: options.maxRowsPerDetailCheck || 1000 });
      return {
        checkResultId: row.id,
        checkId: row.checkId,
        status: row.status,
        priority: row.priority,
        affectedCount: Number(row.affectedCount || 0),
        rowCount: Number(detail?.rowCount || 0),
        storedRows: Number(detail?.storedRows || detail?.rowCount || 0),
        totalAffected: Number(detail?.totalAffected || row.affectedCount || 0),
        truncated: Boolean(detail?.truncated),
        dataSource: detail?.dataSource || 'unknown'
      };
    } catch (error) {
      return {
        checkResultId: row.id,
        checkId: row.checkId,
        status: row.status,
        priority: row.priority,
        affectedCount: Number(row.affectedCount || 0),
        rowCount: 0,
        storedRows: 0,
        totalAffected: Number(row.affectedCount || 0),
        truncated: false,
        dataSource: 'error',
        error: String(error.message || error).slice(0, 300)
      };
    }
  });
}

function jsonFieldSizes(db, runId) {
  const output = [];
  for (const table of RUN_TABLES) {
    if (!tableExists(db, table)) continue;
    const columns = tableColumns(db, table);
    if (!columns.some((column) => column.name === 'runId')) continue;
    const jsonColumns = columns
      .filter((column) => /Json$|JSON/i.test(column.name) || /Json$/i.test(column.name))
      .map((column) => column.name);
    for (const column of jsonColumns) {
      const bytes = Number(safeGet(db, `SELECT SUM(LENGTH(COALESCE(${q(column)}, ''))) AS bytes FROM ${q(table)} WHERE runId = @runId`, { runId }).bytes || 0);
      if (bytes) {
        output.push({
          table,
          column,
          bytes,
          human: humanBytes(bytes)
        });
      }
    }
  }
  return output;
}

function storageRisk(input) {
  const warnings = [];
  const recommendations = [];
  let level = 'low';
  if (input.storageProfile === 'debug' && input.processedUrls > 5000) {
    level = 'critical';
    warnings.push('Debug profile with more than 5,000 URLs can create very large raw snapshots.');
    recommendations.push('Use standard or lean for large/enterprise runs; reserve debug for targeted samples.');
  }
  if (input.estimatedBytesPerUrl > 250000) {
    level = level === 'critical' ? level : 'high';
    warnings.push(`High estimated storage per URL (${humanBytes(input.estimatedBytesPerUrl)}).`);
    recommendations.push('Review detail caps, raw snapshots and resource/link/image storage settings before scaling.');
  } else if (input.estimatedBytesPerUrl > 75000) {
    level = level === 'critical' ? level : 'medium';
    warnings.push(`Moderate estimated storage per URL (${humanBytes(input.estimatedBytesPerUrl)}).`);
    recommendations.push('For 50k+ URLs prefer standard with capped details or lean if detailed resource facts are not needed.');
  }
  if (input.projections.estimated50kBytes > 10 * 1024 * 1024 * 1024) {
    level = level === 'critical' ? level : 'high';
    warnings.push(`50k projection exceeds 10 GB (${input.projections.estimated50kHuman}).`);
  }
  if (input.rawSnapshotRows) {
    warnings.push(`${input.rawSnapshotRows} raw/page snapshot row(s) exist for this run.`);
    recommendations.push('Keep raw HTML disabled for broad crawls; rerun debug only on sampled templates.');
  }
  if (input.cappedDetailChecks) {
    recommendations.push(`${input.cappedDetailChecks} check(s) have capped details; exports should mark truncation clearly.`);
  }
  if (!recommendations.length) recommendations.push('Current run shape is compatible with the selected storage profile.');
  return { level, warnings, recommendations };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all();
}

function countTable(db, table, runId) {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${q(table)} WHERE runId = ?`).get(runId).count || 0;
  } catch {
    return 0;
  }
}

function safeGet(db, sql, params = undefined) {
  try {
    return params === undefined ? db.prepare(sql).get() || {} : db.prepare(sql).get(params) || {};
  } catch {
    return {};
  }
}

function noteForTable(table, rows, bytes) {
  if (!rows) return 'No rows for this run.';
  if (table === 'page_snapshots') return 'Raw/rendered HTML snapshots; should be zero outside debug runs.';
  if (['page_links', 'page_images', 'resources'].includes(table)) return 'Potentially high-cardinality detail facts; caps matter for large runs.';
  if (table === 'check_results') return 'Finding/evidence JSON and narrative storage.';
  if (bytes > 5 * 1024 * 1024) return 'Large contributor for this run.';
  return '';
}

function fileSize(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024 || unit === units[units.length - 1]) return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
    amount /= 1024;
  }
  return `${Math.round(value)} B`;
}

function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
