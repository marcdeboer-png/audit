import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PROVENANCE_VERSION = 1;

export function buildRuntimeProvenance(config = {}) {
  const packageMeta = readPackageMeta();
  return {
    provenanceVersion: PROVENANCE_VERSION,
    gitCommit: runtimeGitCommit(),
    buildVersion: process.env.AUDIT_BUILD_VERSION || packageMeta.version || null,
    configHash: stableHash(safeRunConfig(config)),
    capturedAt: new Date().toISOString()
  };
}

export function buildCheckProvenance({ run, project, check, result, runtime = null }) {
  const storedRuntime = runtime || safeJson(run.runtimeProvenanceJson, {});
  const primaryHost = run.primaryHost || hostOf(run.finalDomain || project?.finalDomain || run.inputDomain || project?.inputDomain);
  return {
    provenanceVersion: PROVENANCE_VERSION,
    runId: Number(run.id),
    projectId: Number(run.projectId),
    auditType: run.auditType || null,
    primaryHost: primaryHost || null,
    urlOrScope: result.sampleUrls?.[0] || primaryHost || 'sitewide',
    collectedAt: run.finishedAt || run.updatedAt || run.startedAt || null,
    evaluatedAt: new Date().toISOString(),
    dataSource: result.dataBasis || result.evidence?.source || 'stored_run_facts',
    collector: result.evidence?.collector || sourceCollector(run.sourceType),
    extractor: result.evidence?.extractor || null,
    checkId: check.id,
    checkVersion: String(check.version || '1'),
    gitCommit: run.runtimeGitCommit || storedRuntime.gitCommit || null,
    buildVersion: run.runtimeBuildVersion || storedRuntime.buildVersion || null,
    configHash: run.runtimeConfigHash || storedRuntime.configHash || null,
    sourceMode: result.evidence?.sourceMode || inferSourceMode(result),
    measurementAttempt: result.evidence?.measurementAttempt ?? null,
    availabilityStatus: result.evaluationState || null,
    technicalErrorSource: result.evaluationState === 'technical_error'
      ? result.evidence?.technicalErrorSource || result.evidence?.technicalError || result.details || null
      : null
  };
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function safeRunConfig(config) {
  return sanitizeConfigValue(config) || {};
}

function sanitizeConfigValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeConfigValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(api[_-]?key|secret|password|passphrase|token|cookie|authorization|credential)/i.test(key))
    .map(([key, nested]) => [key, sanitizeConfigValue(nested)]));
}

function runtimeGitCommit() {
  const provided = process.env.AUDIT_GIT_COMMIT || process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA;
  if (provided) return String(provided).trim().slice(0, 64) || null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim() || null;
  } catch {
    return null;
  }
}

function readPackageMeta() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
}

function inferSourceMode(result) {
  const evidence = result.evidence || {};
  if (evidence.rendered || evidence.browser || /playwright|lighthouse/i.test(String(result.dataBasis || ''))) return 'rendered';
  if (evidence.raw || /html|crawl|http/i.test(String(result.dataBasis || ''))) return 'raw';
  return 'stored_facts';
}

function sourceCollector(sourceType) {
  if (sourceType === 'screaming_frog_import') return 'screaming_frog_importer';
  return 'audit_crawler';
}

function hostOf(value) {
  try {
    return new URL(/^https?:\/\//i.test(String(value || '')) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
