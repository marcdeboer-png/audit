import { normalizeUrl, isLikelyHtmlPage } from '../utils/url.js';
import { crawlerDefaults } from '../crawler/defaults.js';

export function enqueueUrl(db, {
  runId,
  url,
  baseUrl = null,
  depth = 0,
  sourceUrl = null,
  sourceType = 'internal_link',
  priority = 0,
  allowNonHtml = false
}) {
  const normalizedUrl = normalizeUrl(url, baseUrl);
  if (!normalizedUrl) return { inserted: false, normalizedUrl: null, reason: 'invalid' };
  if (!allowNonHtml && !isLikelyHtmlPage(normalizedUrl)) {
    return { inserted: false, normalizedUrl, reason: 'non_html' };
  }

  const shard = shardForUrl(normalizedUrl);
  const result = db.prepare(`
    INSERT OR IGNORE INTO crawl_queue (
      runId, url, normalizedUrl, depth, sourceUrl, sourceType, status, priority,
      shardKey, shardId
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(runId, normalizedUrl, normalizedUrl, depth, sourceUrl, sourceType, priority, shard.shardKey, shard.shardId);

  return {
    inserted: result.changes > 0,
    normalizedUrl,
    reason: result.changes > 0 ? 'inserted' : 'duplicate'
  };
}

export function enqueueSkippedUrl(db, {
  runId,
  url,
  normalizedUrl = null,
  baseUrl = null,
  depth = 0,
  sourceUrl = null,
  sourceType = 'internal_link',
  priority = 0
}, reason) {
  const finalNormalizedUrl = normalizedUrl || normalizeUrl(url, baseUrl);
  if (!finalNormalizedUrl) return { inserted: false, normalizedUrl: null, reason: 'invalid' };

  const shard = shardForUrl(finalNormalizedUrl);
  const result = db.prepare(`
    INSERT OR IGNORE INTO crawl_queue (
      runId, url, normalizedUrl, depth, sourceUrl, sourceType, status,
      priority, attempts, lastError, failedReason, shardKey, shardId, finishedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    runId,
    finalNormalizedUrl,
    finalNormalizedUrl,
    depth,
    sourceUrl,
    sourceType,
    priority,
    String(reason || 'Skipped').slice(0, 2000),
    String(reason || 'Skipped').slice(0, 2000),
    shard.shardKey,
    shard.shardId
  );

  return {
    inserted: result.changes > 0,
    normalizedUrl: finalNormalizedUrl,
    reason: result.changes > 0 ? `Skipped: ${reason}` : 'duplicate'
  };
}

export function enqueueBatch(db, rows) {
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const tx = db.transaction((items) => {
    let inserted = 0;
    let skipped = 0;
    for (const row of items) {
      const result = enqueueUrl(db, row);
      if (result.inserted) inserted += 1;
      else skipped += 1;
    }
    return { inserted, skipped };
  });
  return tx(rows);
}

export function claimNextUrl(db, runId) {
  return claimNextUrlForLock(db, runId, null);
}

export function claimNextUrlForLock(db, runId, lockToken = null) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE crawl_queue
      SET status = 'pending',
          nextAttemptAt = NULL
      WHERE runId = ? AND status = 'waiting' AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
    `).run(runId, now);

    const item = db.prepare(`
      SELECT *
      FROM crawl_queue
      WHERE runId = ? AND status = 'pending'
        AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
        ${lockToken ? 'AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND lockToken = ?)' : ''}
      ORDER BY priority DESC, discoveredAt ASC, id ASC
      LIMIT 1
    `).get(...(lockToken ? [runId, now, runId, lockToken] : [runId, now]));

    if (!item) return null;

    db.prepare(`
      UPDATE crawl_queue
      SET status = 'processing',
          attempts = attempts + 1,
          startedAt = CURRENT_TIMESTAMP,
          nextAttemptAt = NULL,
          lockToken = ?,
          lastError = NULL
      WHERE id = ? AND status = 'pending'
    `).run(lockToken, item.id);

    return db.prepare('SELECT * FROM crawl_queue WHERE id = ?').get(item.id);
  });

  return tx();
}

export function completeUrl(db, queueId) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'done',
        finishedAt = CURRENT_TIMESTAMP,
        nextAttemptAt = NULL,
        lockToken = NULL
    WHERE id = ?
  `).run(queueId);
}

export function scheduleRetry(db, queueId, { errorMessage, nextAttemptAt, statusCode = null, errorType = 'retryable', failedReason = null }) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'waiting',
        lastError = ?,
        nextAttemptAt = ?,
        lastStatusCode = ?,
        lastErrorType = ?,
        failedReason = ?,
        startedAt = NULL,
        finishedAt = NULL,
        lockToken = NULL
    WHERE id = ?
  `).run(
    String(errorMessage || 'Unknown error').slice(0, 2000),
    nextAttemptAt,
    statusCode,
    errorType,
    failedReason,
    queueId
  );
}

export function failUrl(db, queueId, errorMessage, retry = false) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = ?,
        lastError = ?,
        failedReason = CASE WHEN ? = 'failed' THEN ? ELSE failedReason END,
        finishedAt = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
        startedAt = CASE WHEN ? = 'pending' THEN NULL ELSE startedAt END,
        nextAttemptAt = NULL,
        lockToken = NULL
    WHERE id = ?
  `).run(
    retry ? 'pending' : 'failed',
    String(errorMessage || 'Unknown error').slice(0, 2000),
    retry ? 'pending' : 'failed',
    String(errorMessage || 'Unknown error').slice(0, 2000),
    retry ? 'pending' : 'failed',
    retry ? 'pending' : 'failed',
    queueId
  );
}

export function failUrlPermanent(db, queueId, { errorMessage, statusCode = null, errorType = 'permanent', failedReason = null }) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'failed',
        lastError = ?,
        lastStatusCode = ?,
        lastErrorType = ?,
        failedReason = ?,
        finishedAt = CURRENT_TIMESTAMP,
        nextAttemptAt = NULL,
        lockToken = NULL
    WHERE id = ?
  `).run(
    String(errorMessage || 'Unknown error').slice(0, 2000),
    statusCode,
    errorType,
    failedReason || String(errorMessage || 'Unknown error').slice(0, 2000),
    queueId
  );
}

export function skipUrl(db, queueId, reason) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'skipped',
        lastError = ?,
        failedReason = ?,
        nextAttemptAt = NULL,
        finishedAt = CURRENT_TIMESTAMP,
        lockToken = NULL
    WHERE id = ?
  `).run(String(reason || 'Skipped').slice(0, 2000), String(reason || 'Skipped').slice(0, 2000), queueId);
}

export function resetProcessingForRun(db, runId) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'pending',
        startedAt = NULL,
        lockToken = NULL,
        nextAttemptAt = NULL,
        lastError = COALESCE(lastError, 'Reset processing URL on resume')
    WHERE runId = ? AND status = 'processing'
  `).run(runId);
}

export function waitingCount(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_queue
    WHERE runId = ? AND status = 'waiting'
  `).get(runId).count;
}

export function nextWaitingDelayMs(db, runId) {
  const row = db.prepare(`
    SELECT MIN(nextAttemptAt) AS nextAttemptAt
    FROM crawl_queue
    WHERE runId = ? AND status = 'waiting'
  `).get(runId);
  if (!row.nextAttemptAt) return null;
  return Math.max(0, new Date(row.nextAttemptAt).getTime() - Date.now());
}

export function pendingCount(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_queue
    WHERE runId = ? AND status = 'pending'
  `).get(runId).count;
}

export function processingCount(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_queue
    WHERE runId = ? AND status = 'processing'
  `).get(runId).count;
}

export function processedCount(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_queue
    WHERE runId = ? AND status IN ('done', 'failed', 'skipped')
  `).get(runId).count;
}

export function totalCount(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_queue
    WHERE runId = ?
  `).get(runId).count;
}

export function skipRemainingPending(db, runId, reason) {
  db.prepare(`
    UPDATE crawl_queue
    SET status = 'skipped',
        lastError = ?,
        failedReason = ?,
        nextAttemptAt = NULL,
        startedAt = NULL,
        finishedAt = CURRENT_TIMESTAMP,
        lockToken = NULL
    WHERE runId = ? AND status IN ('pending', 'waiting')
  `).run(String(reason || 'Skipped').slice(0, 2000), String(reason || 'Skipped').slice(0, 2000), runId);
}

export function shardForUrl(url, shardCount = crawlerDefaults.shardCount) {
  const shardKey = shardKeyForUrl(url);
  return {
    shardKey,
    shardId: stableHash(shardKey) % Math.max(1, Number(shardCount || crawlerDefaults.shardCount))
  };
}

export function shardKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const prefix = parts.length ? `/${parts[0].toLowerCase()}` : '/';
    return `${parsed.hostname.toLowerCase()}${prefix}`;
  } catch {
    return 'unknown/';
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
