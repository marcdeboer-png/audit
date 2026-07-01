import { dedupeUrlSamples } from '../checks/helpers.js';
import { normalizeStorageConfig } from './storageProfiles.js';
import crypto from 'node:crypto';

const DEFAULT_POLICY = Object.freeze({
  maxEvidenceSamplesPerCheck: 20,
  maxStoredDetailRowsPerCheck: 1000,
  maxEvidenceStringLength: 4000,
  maxErrorStringLength: 2000,
  maxEvidenceKeys: 80,
  maxEvidenceJsonBytes: 120000,
  maxStandardLinksPerPage: 25,
  maxLeanLinksPerPage: 0,
  maxStandardSchemaRawJsonBytes: 4000,
  maxDebugSchemaRawJsonBytes: 50000,
  maxStandardDomainAssetBytes: 50000,
  maxLeanDomainAssetBytes: 5000,
  maxDebugDomainAssetBytes: 250000
});

export function retentionPolicyFromRun(run = {}) {
  const storage = normalizeStorageConfig(run);
  return {
    ...DEFAULT_POLICY,
    ...storage,
    maxEvidenceSamplesPerCheck: Number(run.maxEvidenceSamplesPerCheck || storage.maxEvidenceSamplesPerCheck || DEFAULT_POLICY.maxEvidenceSamplesPerCheck),
    maxStoredDetailRowsPerCheck: Number(run.maxStoredDetailRowsPerCheck || storage.maxStoredDetailRowsPerCheck || DEFAULT_POLICY.maxStoredDetailRowsPerCheck)
  };
}

export function sanitizeCheckResultForStorage(item, policy = DEFAULT_POLICY) {
  const maxSamples = Math.max(1, Number(policy.maxEvidenceSamplesPerCheck || DEFAULT_POLICY.maxEvidenceSamplesPerCheck));
  const sampleUrls = dedupeUrlSamples(item.sampleUrls || [], maxSamples);
  const evidenceResult = pruneEvidence(item.evidence || {}, policy);
  const evidence = evidenceResult.truncated
    ? {
        ...evidenceResult.value,
        storageTruncated: true,
        storagePolicy: {
          maxEvidenceSamplesPerCheck: maxSamples,
          maxEvidenceStringLength: policy.maxEvidenceStringLength || DEFAULT_POLICY.maxEvidenceStringLength
        }
      }
    : evidenceResult.value;
  return {
    ...item,
    sampleUrls,
    finding: truncateText(item.finding, 5000),
    details: truncateText(item.details, 8000),
    recommendation: truncateText(item.recommendation, 8000),
    dataBasis: truncateText(item.dataBasis, 1000),
    reviewReason: truncateText(item.reviewReason, 1000),
    interpretation: truncateText(item.interpretation, 2000),
    limitations: truncateText(item.limitations, 2000),
    evidence
  };
}

export function pruneEvidence(value, policy = DEFAULT_POLICY, path = []) {
  let truncated = false;
  const prune = (input, nestedPath) => {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      const limit = /error|stack|trace|exception/i.test(nestedPath.join('.'))
        ? policy.maxErrorStringLength || DEFAULT_POLICY.maxErrorStringLength
        : policy.maxEvidenceStringLength || DEFAULT_POLICY.maxEvidenceStringLength;
      const output = truncateText(input, limit);
      if (output !== input) truncated = true;
      return output;
    }
    if (typeof input !== 'object') return input;
    if (Array.isArray(input)) {
      const max = Math.max(1, Number(policy.maxEvidenceSamplesPerCheck || DEFAULT_POLICY.maxEvidenceSamplesPerCheck));
      if (input.length > max) truncated = true;
      return input.slice(0, max).map((item, index) => prune(item, [...nestedPath, String(index)]));
    }

    const entries = Object.entries(input);
    const maxKeys = policy.maxEvidenceKeys || DEFAULT_POLICY.maxEvidenceKeys;
    if (entries.length > maxKeys) truncated = true;
    const output = {};
    for (const [key, nestedValue] of entries.slice(0, maxKeys)) {
      output[key] = prune(nestedValue, [...nestedPath, key]);
    }
    return output;
  };

  const pruned = prune(value, path);
  return { value: pruned && typeof pruned === 'object' && !Array.isArray(pruned) ? pruned : {}, truncated };
}

export function boundedJson(value, policy = DEFAULT_POLICY) {
  const json = JSON.stringify(value || {});
  const maxBytes = policy.maxEvidenceJsonBytes || DEFAULT_POLICY.maxEvidenceJsonBytes;
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return json;
  return JSON.stringify({
    storageTruncated: true,
    reason: 'evidence_json_byte_limit',
    maxBytes,
    originalBytes: Buffer.byteLength(json, 'utf8')
  });
}

export function truncateText(value, maxLength = 4000) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (text.length <= maxLength) return value;
  return `${text.slice(0, Math.max(0, maxLength - 32))}... [truncated ${text.length - maxLength + 32} chars]`;
}

export function capRows(rows = [], maxRows = DEFAULT_POLICY.maxStoredDetailRowsPerCheck) {
  const limit = Math.max(1, Number(maxRows || DEFAULT_POLICY.maxStoredDetailRowsPerCheck));
  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    storedRows: Math.min(rows.length, limit),
    totalRows: rows.length,
    limit
  };
}

export function filterArtifactsForStorage(run = {}, artifacts = {}) {
  const storage = normalizeStorageConfig(run);
  const affectedOnly = storage.storeAffectedOnlyDetails;
  const linkLimit = storage.storageProfile === 'debug'
    ? Infinity
    : storage.storageProfile === 'lean'
      ? DEFAULT_POLICY.maxLeanLinksPerPage
      : DEFAULT_POLICY.maxStandardLinksPerPage;
  const originalLinks = artifacts.links || [];
  const links = storage.storeAllLinks ? originalLinks : [];
  const storedLinks = Number.isFinite(linkLimit) ? links.slice(0, linkLimit) : links;
  return {
    links: storedLinks,
    linkAggregates: buildLinkAggregates(originalLinks, storedLinks),
    images: storage.storeAllImages
      ? artifacts.images || []
      : affectedOnly
        ? (artifacts.images || []).filter((image) => !image.hasAlt || image.alt === '')
        : [],
    resources: storage.storeAllResources
      ? artifacts.resources || []
      : affectedOnly
        ? (artifacts.resources || []).filter((resource) => Number(resource.statusCode || 0) >= 400)
        : [],
    schemas: normalizeSchemasForStorage(storage, artifacts.schemas || [])
  };
}

export function normalizeSchemasForStorage(runOrStorage = {}, schemas = []) {
  const storage = runOrStorage.storageProfile ? normalizeStorageConfig(runOrStorage) : normalizeStorageConfig({ storageProfile: 'standard' });
  const rawLimit = storage.storageProfile === 'debug'
    ? DEFAULT_POLICY.maxDebugSchemaRawJsonBytes
    : storage.storageProfile === 'lean'
      ? 0
      : DEFAULT_POLICY.maxStandardSchemaRawJsonBytes;
  return schemas.map((schema) => ({
    ...schema,
    rawJson: rawLimit ? truncateText(schema.rawJson, rawLimit) : null,
    rawJsonHash: schema.rawJson ? crypto.createHash('sha1').update(String(schema.rawJson)).digest('hex') : null,
    rawJsonBytes: schema.rawJson ? Buffer.byteLength(String(schema.rawJson), 'utf8') : null,
    rawJsonTruncated: Boolean(schema.rawJson && rawLimit && String(schema.rawJson).length > rawLimit),
    rawJsonStored: Boolean(schema.rawJson && rawLimit)
  }));
}

export function buildLinkAggregates(originalLinks = [], storedLinks = originalLinks) {
  const internalTargets = new Set();
  const externalTargets = new Set();
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  let nofollowCount = 0;
  let imageLinkCount = 0;
  const samples = [];

  for (const link of originalLinks || []) {
    const targetUrl = link.normalizedTargetUrl || link.targetUrl || '';
    if (link.linkType === 'external') {
      externalLinkCount += 1;
      if (targetUrl) externalTargets.add(targetUrl);
    } else {
      internalLinkCount += 1;
      if (targetUrl) internalTargets.add(targetUrl);
    }
    if (/\bnofollow\b/i.test(link.rel || '')) nofollowCount += 1;
    if (/\.(png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(targetUrl)) imageLinkCount += 1;
    if (samples.length < 20 && targetUrl) {
      samples.push({
        targetUrl,
        linkType: link.linkType || 'internal',
        anchorText: link.anchorText || null,
        rel: link.rel || null
      });
    }
  }

  return {
    internalLinkCount,
    externalLinkCount,
    uniqueInternalTargetsCount: internalTargets.size,
    uniqueExternalTargetsCount: externalTargets.size,
    nofollowCount,
    imageLinkCount,
    storedRows: storedLinks.length,
    totalRows: originalLinks.length,
    truncated: storedLinks.length < originalLinks.length,
    samples
  };
}

export function normalizeDomainAssetForStorage(run = {}, asset = {}) {
  const storage = normalizeStorageConfig(run);
  const type = String(asset.type || '').toLowerCase();
  const baseLimit = storage.storageProfile === 'debug'
    ? DEFAULT_POLICY.maxDebugDomainAssetBytes
    : storage.storageProfile === 'lean'
      ? DEFAULT_POLICY.maxLeanDomainAssetBytes
      : DEFAULT_POLICY.maxStandardDomainAssetBytes;
  const limit = type === 'sitemap' && storage.storageProfile === 'standard'
    ? Math.min(baseLimit, 20000)
    : baseLimit;
  const content = limit ? truncateText(asset.content, limit) : null;
  return {
    ...asset,
    content,
    responseHeadersJson: asset.responseHeadersJson ? truncateText(asset.responseHeadersJson, storage.storageProfile === 'debug' ? 20000 : 4000) : null,
    storageTruncated: Boolean(asset.content && content !== asset.content)
  };
}

export function snapshotHtml(value, maxBytes = 0) {
  if (!value || !maxBytes) {
    return { html: null, bytes: 0, truncated: false };
  }
  const buffer = Buffer.from(String(value), 'utf8');
  const truncated = buffer.length > maxBytes;
  const html = buffer.subarray(0, maxBytes).toString('utf8');
  return {
    html,
    bytes: buffer.length,
    truncated
  };
}
