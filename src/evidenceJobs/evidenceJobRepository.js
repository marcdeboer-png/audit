import { normalizeUrl } from '../utils/url.js';

export const EVIDENCE_JOB_STATUSES = Object.freeze(['planned', 'running', 'completed', 'failed', 'cancelled']);

export function createEvidenceJob(db, input = {}) {
  const result = db.prepare(`
    INSERT INTO evidence_jobs (
      runId, validationId, jobType, label, status, urlSource, urlCountPlanned,
      maxUrls, dryRun, storageProfile, factsToExtractJson, storesRawHtml,
      storesRenderedHtml, estimatedBytesPerUrl, estimatedTotalBytes,
      closesGapTypesJson, relatedManualItemIdsJson, relatedCheckIdsJson,
      summaryJson, warningsJson, errorsJson, configJson
    )
    VALUES (
      @runId, @validationId, @jobType, @label, @status, @urlSource, @urlCountPlanned,
      @maxUrls, @dryRun, @storageProfile, @factsToExtractJson, @storesRawHtml,
      @storesRenderedHtml, @estimatedBytesPerUrl, @estimatedTotalBytes,
      @closesGapTypesJson, @relatedManualItemIdsJson, @relatedCheckIdsJson,
      @summaryJson, @warningsJson, @errorsJson, @configJson
    )
  `).run(jobParams({
    status: 'planned',
    dryRun: 0,
    ...input
  }));
  return getEvidenceJob(db, result.lastInsertRowid);
}

export function updateEvidenceJob(db, jobId, fields = {}) {
  const mapped = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (['factsToExtract', 'closesGapTypes', 'relatedManualItemIds', 'relatedCheckIds', 'summary', 'warnings', 'errors', 'config'].includes(key)) {
      mapped[jsonColumnFor(key)] = JSON.stringify(value || (Array.isArray(value) ? [] : {}));
    } else if (['storesRawHtml', 'storesRenderedHtml', 'dryRun'].includes(key)) {
      mapped[key] = value ? 1 : 0;
    } else {
      mapped[key] = value;
    }
  }
  const entries = Object.entries(mapped);
  if (!entries.length) return getEvidenceJob(db, jobId);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE evidence_jobs SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), jobId);
  return getEvidenceJob(db, jobId);
}

export function startEvidenceJob(db, jobId) {
  return updateEvidenceJob(db, jobId, {
    status: 'running',
    startedAt: new Date().toISOString()
  });
}

export function completeEvidenceJob(db, jobId, fields = {}) {
  return updateEvidenceJob(db, jobId, {
    ...fields,
    status: 'completed',
    completedAt: new Date().toISOString()
  });
}

export function failEvidenceJob(db, jobId, error, fields = {}) {
  const existing = getEvidenceJob(db, jobId);
  return updateEvidenceJob(db, jobId, {
    ...fields,
    status: 'failed',
    completedAt: new Date().toISOString(),
    errors: [...(existing?.errors || []), errorMessage(error)]
  });
}

export function getEvidenceJob(db, jobId) {
  const row = db.prepare('SELECT * FROM evidence_jobs WHERE id = ?').get(jobId);
  return row ? normalizeJobRow(row) : null;
}

export function listEvidenceJobs(db, runId, options = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit || 100)));
  return db.prepare(`
    SELECT *
    FROM evidence_jobs
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(runId, limit).map(normalizeJobRow);
}

export function insertTargetedEvidenceFact(db, fact = {}) {
  db.prepare(`
    INSERT INTO targeted_evidence_facts (
      jobId, runId, jobType, url, normalizedUrl, finalUrl, statusCode,
      contentType, indexability, factsJson, error, storedBytesEstimate
    )
    VALUES (
      @jobId, @runId, @jobType, @url, @normalizedUrl, @finalUrl, @statusCode,
      @contentType, @indexability, @factsJson, @error, @storedBytesEstimate
    )
    ON CONFLICT(jobId, normalizedUrl, jobType) DO UPDATE SET
      finalUrl = excluded.finalUrl,
      statusCode = excluded.statusCode,
      contentType = excluded.contentType,
      indexability = excluded.indexability,
      factsJson = excluded.factsJson,
      error = excluded.error,
      storedBytesEstimate = excluded.storedBytesEstimate
  `).run({
    jobId: fact.jobId,
    runId: fact.runId,
    jobType: fact.jobType,
    url: fact.url,
    normalizedUrl: fact.normalizedUrl || normalizeUrl(fact.url) || fact.url,
    finalUrl: fact.finalUrl || null,
    statusCode: fact.statusCode ?? null,
    contentType: fact.contentType || null,
    indexability: fact.indexability || null,
    factsJson: JSON.stringify(fact.facts || {}),
    error: fact.error || null,
    storedBytesEstimate: fact.storedBytesEstimate || Buffer.byteLength(JSON.stringify(fact.facts || {}), 'utf8')
  });
}

export function listTargetedEvidenceFacts(db, jobId, options = {}) {
  const limit = Math.min(5000, Math.max(1, Number(options.limit || 1000)));
  return db.prepare(`
    SELECT *
    FROM targeted_evidence_facts
    WHERE jobId = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(jobId, limit).map(normalizeFactRow);
}

export function countTargetedEvidenceFacts(db, jobId) {
  return db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(storedBytesEstimate), 0) AS storedBytesEstimate
    FROM targeted_evidence_facts
    WHERE jobId = ?
  `).get(jobId);
}

export function latestValidationIdForRun(db, runId) {
  return db.prepare(`
    SELECT id
    FROM validation_reports
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(runId)?.id || null;
}

export function resolveEvidenceJobUrls(db, run, input = {}) {
  const urlSource = normalizeUrlSource(input.urlSource);
  const warnings = [];
  let urls = [];

  if (urlSource === 'manual_url_list') {
    urls = (input.urls || []).map((url) => normalizeUrl(url)).filter(Boolean);
    if (!urls.length) warnings.push('manual_url_list did not contain valid URLs.');
  } else if (urlSource === 'known_url_facts') {
    urls = knownUrlFacts(db, run);
  } else if (urlSource === 'sitemap_urls') {
    urls = sitemapUrls(db, run.id);
    if (!urls.length) warnings.push('sitemap_urls has no stored sitemap queue URLs for this run; use current_run_urls, known_url_facts or manual_url_list.');
  } else {
    urls = currentRunUrls(db, run.id);
  }

  const deduped = dedupeUrls(urls);
  return {
    urlSource,
    urls: deduped,
    plannedUrlCount: deduped.length,
    warnings
  };
}

export function normalizeUrlSource(value) {
  const source = String(value || 'current_run_urls').trim();
  return ['current_run_urls', 'known_url_facts', 'manual_url_list', 'sitemap_urls'].includes(source)
    ? source
    : 'current_run_urls';
}

export function serializeEvidenceJobFactCsv(facts = []) {
  const columns = ['jobId', 'runId', 'jobType', 'url', 'normalizedUrl', 'finalUrl', 'statusCode', 'contentType', 'indexability', 'error', 'factsJson'];
  const lines = [`${columns.join(',')}\n`];
  for (const fact of facts) {
    lines.push(`${columns.map((column) => csvEscape(column === 'factsJson' ? JSON.stringify(fact.facts || {}) : fact[column])).join(',')}\n`);
  }
  return lines.join('');
}

function currentRunUrls(db, runId) {
  const pageUrls = db.prepare(`
    SELECT COALESCE(NULLIF(finalUrl, ''), NULLIF(normalizedUrl, ''), url) AS url
    FROM pages
    WHERE runId = ?
    ORDER BY id ASC
  `).all(runId).map((row) => row.url);
  if (pageUrls.length) return pageUrls;
  return db.prepare(`
    SELECT normalizedUrl AS url
    FROM crawl_queue
    WHERE runId = ?
    ORDER BY id ASC
  `).all(runId).map((row) => row.url);
}

function knownUrlFacts(db, run) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(p.finalUrl, ''), NULLIF(p.normalizedUrl, ''), p.url) AS url, MAX(p.id) AS latestId
    FROM pages p
    JOIN runs r ON r.id = p.runId
    WHERE r.projectId = ?
    GROUP BY COALESCE(NULLIF(p.normalizedUrl, ''), p.url)
    ORDER BY latestId DESC
  `).all(run.projectId).map((row) => row.url);
}

function sitemapUrls(db, runId) {
  return db.prepare(`
    SELECT normalizedUrl AS url
    FROM crawl_queue
    WHERE runId = ? AND sourceType LIKE '%sitemap%'
    ORDER BY id ASC
  `).all(runId).map((row) => row.url);
}

function dedupeUrls(urls = []) {
  const seen = new Set();
  const output = [];
  for (const value of urls) {
    const normalized = normalizeUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function jobParams(input = {}) {
  return {
    runId: input.runId,
    validationId: input.validationId || null,
    jobType: input.jobType,
    label: input.label || input.jobType,
    status: normalizeStatus(input.status),
    urlSource: normalizeUrlSource(input.urlSource),
    urlCountPlanned: Number(input.urlCountPlanned || 0),
    maxUrls: Number(input.maxUrls || 0),
    dryRun: input.dryRun ? 1 : 0,
    storageProfile: input.storageProfile || 'targeted_minimal',
    factsToExtractJson: JSON.stringify(input.factsToExtract || []),
    storesRawHtml: input.storesRawHtml ? 1 : 0,
    storesRenderedHtml: input.storesRenderedHtml ? 1 : 0,
    estimatedBytesPerUrl: Number(input.estimatedBytesPerUrl || 0),
    estimatedTotalBytes: Number(input.estimatedTotalBytes || 0),
    closesGapTypesJson: JSON.stringify(input.closesGapTypes || []),
    relatedManualItemIdsJson: JSON.stringify(input.relatedManualItemIds || []),
    relatedCheckIdsJson: JSON.stringify(input.relatedCheckIds || []),
    summaryJson: JSON.stringify(input.summary || {}),
    warningsJson: JSON.stringify(input.warnings || []),
    errorsJson: JSON.stringify(input.errors || []),
    configJson: JSON.stringify(input.config || {})
  };
}

function normalizeJobRow(row = {}) {
  return {
    jobId: row.id,
    id: row.id,
    runId: row.runId,
    validationId: row.validationId,
    jobType: row.jobType,
    label: row.label,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    urlSource: row.urlSource,
    urlCountPlanned: row.urlCountPlanned,
    urlCountProcessed: row.urlCountProcessed,
    urlCountSucceeded: row.urlCountSucceeded,
    urlCountFailed: row.urlCountFailed,
    maxUrls: row.maxUrls,
    dryRun: Boolean(row.dryRun),
    storageProfile: row.storageProfile,
    factsToExtract: parseJson(row.factsToExtractJson, []),
    storesRawHtml: Boolean(row.storesRawHtml),
    storesRenderedHtml: Boolean(row.storesRenderedHtml),
    estimatedBytesPerUrl: row.estimatedBytesPerUrl,
    estimatedTotalBytes: row.estimatedTotalBytes,
    actualStoredBytesEstimate: row.actualStoredBytesEstimate,
    closesGapTypes: parseJson(row.closesGapTypesJson, []),
    relatedManualItemIds: parseJson(row.relatedManualItemIdsJson, []),
    relatedCheckIds: parseJson(row.relatedCheckIdsJson, []),
    summary: parseJson(row.summaryJson, {}),
    warnings: parseJson(row.warningsJson, []),
    errors: parseJson(row.errorsJson, []),
    config: parseJson(row.configJson, {})
  };
}

function normalizeFactRow(row = {}) {
  return {
    id: row.id,
    jobId: row.jobId,
    runId: row.runId,
    jobType: row.jobType,
    url: row.url,
    normalizedUrl: row.normalizedUrl,
    finalUrl: row.finalUrl,
    statusCode: row.statusCode,
    contentType: row.contentType,
    indexability: row.indexability,
    facts: parseJson(row.factsJson, {}),
    error: row.error,
    storedBytesEstimate: row.storedBytesEstimate,
    createdAt: row.createdAt
  };
}

function normalizeStatus(status) {
  return EVIDENCE_JOB_STATUSES.includes(status) ? status : 'planned';
}

function jsonColumnFor(key) {
  return {
    factsToExtract: 'factsToExtractJson',
    closesGapTypes: 'closesGapTypesJson',
    relatedManualItemIds: 'relatedManualItemIdsJson',
    relatedCheckIds: 'relatedCheckIdsJson',
    summary: 'summaryJson',
    warnings: 'warningsJson',
    errors: 'errorsJson',
    config: 'configJson'
  }[key];
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
