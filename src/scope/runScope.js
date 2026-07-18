const INTERNAL_URL_FIELDS = new Set([
  'url',
  'pageUrl',
  'sourceUrl',
  'source_url',
  'sampledUrl',
  'linkedUrl',
  'linked_url'
]);

export class RunScopeIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RunScopeIntegrityError';
    this.code = 'RUN_SCOPE_INTEGRITY_ERROR';
    this.details = details;
  }
}

export function requireRunId(runId, operation = 'run-scoped operation') {
  const value = Number(runId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RunScopeIntegrityError(`${operation} requires an explicit positive run_id.`, { runId: runId ?? null, operation });
  }
  return value;
}

export function createRunScope(run, project = null) {
  const runId = requireRunId(run?.id, 'create run scope');
  const projectId = Number(run?.projectId || project?.id);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new RunScopeIntegrityError('Run scope requires an explicit project_id.', { runId, projectId: projectId || null });
  }
  const allowedHosts = new Set();
  for (const value of [run.finalDomain, run.inputDomain, project?.finalDomain, project?.inputDomain]) {
    const host = hostOf(value);
    if (!host) continue;
    allowedHosts.add(host);
    allowedHosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
  }
  if (!allowedHosts.size) {
    throw new RunScopeIntegrityError('Run scope has no valid primary host.', { runId, projectId });
  }
  return { runId, projectId, allowedHosts, primaryHost: hostOf(run.finalDomain || project?.finalDomain || run.inputDomain || project?.inputDomain) };
}

export function assertRunStorageScope(db, scope) {
  const violations = [];
  const scans = [
    ['pages', 'url', 'page'],
    ['page_links', 'sourceUrl', 'source'],
    ['page_images', 'pageUrl', 'source'],
    ['resources', 'pageUrl', 'source'],
    ['http_timing_measurements', 'url', 'measurement'],
    ['schemas', 'pageUrl', 'source'],
    ['domain_assets', 'url', 'asset']
  ];
  for (const [table, column, kind] of scans) {
    if (!hasTable(db, table)) continue;
    const rows = db.prepare(`SELECT MIN(id) AS id, ${column} AS url FROM ${table} WHERE runId = ? GROUP BY ${column} ORDER BY MIN(id) ASC`).all(scope.runId);
    for (const row of rows) {
      if (!row.url || hostAllowed(row.url, scope.allowedHosts)) continue;
      violations.push({ table, rowId: row.id, field: column, kind, url: row.url });
      if (violations.length >= 25) break;
    }
    if (violations.length >= 25) break;
  }
  if (hasTable(db, 'page_links')) {
    const rows = db.prepare(`
      SELECT MIN(id) AS id, targetUrl AS url
      FROM page_links
      WHERE runId = ? AND linkType = 'internal'
      GROUP BY targetUrl
      ORDER BY MIN(id) ASC
    `).all(scope.runId);
    for (const row of rows) {
      if (!row.url || hostAllowed(row.url, scope.allowedHosts)) continue;
      violations.push({ table: 'page_links', rowId: row.id, field: 'targetUrl', kind: 'internal_target', url: row.url });
      if (violations.length >= 25) break;
    }
  }
  if (violations.length) {
    throw new RunScopeIntegrityError(`Run ${scope.runId} contains data outside its allowed host scope.`, {
      runId: scope.runId,
      projectId: scope.projectId,
      allowedHosts: [...scope.allowedHosts],
      violations
    });
  }
  return { checked: true, violations: 0, allowedHosts: [...scope.allowedHosts] };
}

export function assertCheckResultScope(result, scope, check = {}) {
  if (result?.provenance?.runId && Number(result.provenance.runId) !== scope.runId) {
    throw new RunScopeIntegrityError(`Check ${check.id || result.id} returned a foreign run_id.`, { expected: scope.runId, actual: result.provenance.runId });
  }
  if (result?.provenance?.projectId && Number(result.provenance.projectId) !== scope.projectId) {
    throw new RunScopeIntegrityError(`Check ${check.id || result.id} returned a foreign project_id.`, { expected: scope.projectId, actual: result.provenance.projectId });
  }
  const violations = [];
  for (const url of result?.sampleUrls || []) {
    if (!hostAllowed(url, scope.allowedHosts)) violations.push({ field: 'sampleUrls', url });
  }
  walkUrls(result?.evidence, [], (field, url, path) => {
    if (!INTERNAL_URL_FIELDS.has(field)) return;
    if (!hostAllowed(url, scope.allowedHosts)) violations.push({ field, path, url });
  });
  if (violations.length) {
    throw new RunScopeIntegrityError(`Check ${check.id || result?.id} returned foreign internal-scope evidence.`, {
      runId: scope.runId,
      projectId: scope.projectId,
      allowedHosts: [...scope.allowedHosts],
      violations: violations.slice(0, 25)
    });
  }
  return result;
}

export function scopeSafeCheckResult(result, scope, check = {}) {
  try {
    return assertCheckResultScope(result, scope, check);
  } catch (error) {
    if (!(error instanceof RunScopeIntegrityError)) throw error;
    const checkId = check.id || result.checkId || result.id || 'unknown';
    const evidence = {
      checkId,
      runId: scope.runId,
      projectId: scope.projectId,
      technicalErrorSource: error.code,
      scopeIntegrityViolationCount: Number(error.details?.violations?.length || 1)
    };
    const finding = `${result.checkName || result.name || checkId}: stored finding evidence failed run-scope integrity validation.`;
    const recommendation = 'Recompute the check from correctly scoped run facts after reviewing the integrity error.';
    const provenance = {
      provenanceVersion: result.provenance?.provenanceVersion || 1,
      runId: scope.runId,
      projectId: scope.projectId,
      primaryHost: scope.primaryHost,
      checkId,
      checkVersion: result.checkVersion || result.provenance?.checkVersion || null,
      availabilityStatus: 'technical_error',
      technicalErrorSource: error.code,
      derivedAtReadTime: true
    };
    return {
      ...result,
      status: 'NA',
      effectiveStatus: 'NA',
      score: null,
      scoreEligible: false,
      evaluationState: 'technical_error',
      scoreExclusionReason: 'Excluded because persisted finding evidence violates run/project/host scope.',
      affectedCount: 0,
      sampleUrls: [],
      sampleUrlsJson: '[]',
      finding,
      effectiveFinding: finding,
      details: 'Foreign or mismatched run/project/host evidence was suppressed. Recompute the check from correctly scoped facts.',
      recommendation,
      effectiveRecommendation: recommendation,
      evidence,
      evidenceJson: JSON.stringify(evidence),
      facts: {},
      factsJson: '{}',
      assessment: {},
      assessmentJson: '{}',
      recommendationMeta: {},
      recommendationMetaJson: '{}',
      provenance,
      provenanceJson: JSON.stringify(provenance),
      requirements: {
        requiredFacts: ['runScopedEvidence'],
        missingFacts: ['validRunScopedEvidence'],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true,
        reason: 'Persisted evidence failed run-scope integrity validation.'
      }
    };
  }
}

export function hostAllowed(url, allowedHosts) {
  const host = hostOf(url);
  return Boolean(host && allowedHosts.has(host));
}

function walkUrls(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkUrls(item, [...path, index], visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && /^https?:\/\//i.test(nested)) visit(key, nested, [...path, key].join('.'));
    else walkUrls(nested, [...path, key], visit);
  }
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hostOf(value) {
  try {
    return new URL(/^https?:\/\//i.test(String(value || '')) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}
