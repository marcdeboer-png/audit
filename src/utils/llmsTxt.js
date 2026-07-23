import crypto from 'node:crypto';

export const LLMS_TXT_VALIDATION_VERSION = 'llms-txt-validation-v1';

const VALID_CONTENT_TYPES = [
  /^text\/plain(?:;|$)/i,
  /^text\/markdown(?:;|$)/i,
  /^text\/x-markdown(?:;|$)/i,
  /^application\/markdown(?:;|$)/i
];

const GENERIC_DESIGNATIONS = /^(?:llms(?:\.txt)?|documentation|docs|website|site|home|index|readme)$/i;

export function analyzeLlmsTxtContent({
  url,
  body = '',
  contentType = '',
  utf8Valid = true,
  bodyBytes = null
} = {}) {
  const text = String(body).replace(/^\uFEFF/, '');
  const trimmed = text.trim();
  const looksHtml = /<\s*!doctype\s+html|<\s*html(?:\s|>)|<\s*(?:head|body|title)(?:\s|>)/i.test(trimmed.slice(0, 4096));
  const headings = extractHeadings(text);
  const siteDesignation = headings.find((heading) => heading.level === 1 && !GENERIC_DESIGNATIONS.test(heading.text))?.text || null;
  const sections = extractUsableSections(text, headings);
  const internalUrls = extractInternalUrls(text, url);
  const normalizedContentType = String(contentType || '').trim().toLowerCase();
  const contentTypeValid = VALID_CONTENT_TYPES.some((pattern) => pattern.test(normalizedContentType));
  const charset = charsetFromContentType(normalizedContentType);
  const charsetValid = utf8Valid && (!charset || ['utf-8', 'utf8'].includes(charset));
  const byteCount = bodyBytes === null || bodyBytes === undefined
    ? Buffer.byteLength(text, 'utf8')
    : Number(bodyBytes);
  const validationReasons = [];
  if (!trimmed) validationReasons.push('empty_or_whitespace_body');
  if (looksHtml) validationReasons.push('html_or_soft_error_representation');
  if (!contentTypeValid) validationReasons.push('unsupported_content_type');
  if (!charsetValid) validationReasons.push('not_valid_utf8');
  if (!siteDesignation) validationReasons.push('missing_site_or_project_designation');
  if (!sections.length && !internalUrls.length) validationReasons.push('missing_usable_section_or_internal_target');

  return {
    version: LLMS_TXT_VALIDATION_VERSION,
    bodyBytes: Number.isFinite(byteCount) ? byteCount : 0,
    contentHash: crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    contentType: normalizedContentType,
    contentTypeValid,
    charset: charset || (utf8Valid ? 'utf-8-detected' : 'unknown'),
    utf8Valid: Boolean(utf8Valid),
    looksHtml,
    nonWhitespace: Boolean(trimmed),
    headings: headings.slice(0, 20),
    headingCount: headings.length,
    siteDesignation,
    usableSections: sections.slice(0, 20),
    usableSectionCount: sections.length,
    internalUrls: internalUrls.slice(0, 20),
    internalUrlCount: internalUrls.length,
    minimumContentValid: validationReasons.length === 0,
    validationReasons
  };
}

export function analyzeLlmsTxtAsset(asset = {}) {
  const metadata = safeJson(asset.metadataJson, {});
  const stored = metadata.llmsTxt;
  const contentType = metadata.contentType || headerValue(asset.responseHeadersJson, 'content-type') || '';
  const contentAnalysis = stored?.version === LLMS_TXT_VALIDATION_VERSION
    ? stored
    : analyzeLlmsTxtContent({
        url: asset.url,
        body: asset.content ?? '',
        contentType,
        utf8Valid: metadata.utf8Valid !== false,
        bodyBytes: metadata.sizeBytes
      });
  const initialStatusCode = numberOrNull(metadata.initialStatusCode);
  const finalStatusCode = numberOrNull(metadata.finalStatusCode) ?? numberOrNull(asset.statusCode);
  const finalUrl = metadata.finalUrl || null;
  const redirectChain = Array.isArray(metadata.redirectChain) ? metadata.redirectChain : [];
  const attempts = Array.isArray(metadata.measurementAttempts) ? metadata.measurementAttempts : [];
  const measurementState = metadata.measurementState || inferHistoricalMeasurementState({
    statusCode: finalStatusCode,
    attempts,
    metadata
  });
  const provenanceComplete = initialStatusCode !== null &&
    finalStatusCode !== null &&
    Boolean(finalUrl) &&
    Array.isArray(metadata.redirectChain) &&
    Boolean(contentType) &&
    metadata.truncated !== undefined &&
    Array.isArray(metadata.measurementAttempts) &&
    metadata.measurementAttempts.length > 0;
  const direct200 = initialStatusCode === 200 &&
    finalStatusCode === 200 &&
    redirectChain.length === 0 &&
    comparableUrl(finalUrl) === comparableUrl(asset.url);
  const stable = measurementState === 'confirmed';
  const failureReasons = [];
  if (!provenanceComplete) failureReasons.push('incomplete_http_provenance');
  if (metadata.truncated) failureReasons.push('truncated_response');
  if (!stable) failureReasons.push(`measurement_${measurementState}`);
  if (!direct200 && provenanceComplete && stable) failureReasons.push(httpFailureReason(initialStatusCode, finalStatusCode, redirectChain));
  if (provenanceComplete && stable && direct200) failureReasons.push(...contentAnalysis.validationReasons);

  return {
    version: LLMS_TXT_VALIDATION_VERSION,
    url: asset.url || null,
    initialStatusCode,
    finalStatusCode,
    finalUrl,
    redirectChain,
    contentType: String(contentType).toLowerCase(),
    attempts,
    measurementState,
    provenanceComplete,
    truncated: Boolean(metadata.truncated),
    direct200,
    stable,
    content: contentAnalysis,
    pass: provenanceComplete && stable && direct200 && contentAnalysis.minimumContentValid,
    failureReasons: failureReasons.filter(Boolean)
  };
}

export function classifyLlmsAvailability(analysis = {}) {
  if (analysis.measurementState === 'technical_error') return 'technical_error';
  if (!analysis.provenanceComplete || analysis.truncated) return 'insufficient_evidence';
  if (['transient', 'unstable', 'rate_limited', 'historical_unknown'].includes(analysis.measurementState)) return 'insufficient_evidence';
  return null;
}

export function classifyMeasurementAttempts(attempts = []) {
  if (!attempts.length) return 'technical_error';
  const statuses = attempts.map((attempt) => numberOrNull(attempt.finalStatusCode));
  const successfulResponses = statuses.filter((status) => status !== null);
  if (!successfulResponses.length) return 'technical_error';
  if (successfulResponses.some((status) => status === 429)) return 'rate_limited';
  const retryable = successfulResponses.filter((status) => status >= 500 && status <= 599);
  if (retryable.length === successfulResponses.length) {
    return successfulResponses.length >= 2 ? 'confirmed' : 'transient';
  }
  if (retryable.length || attempts.some((attempt) => attempt.networkError)) return 'unstable';
  return 'confirmed';
}

function inferHistoricalMeasurementState({ statusCode, attempts, metadata }) {
  if (attempts.length) return classifyMeasurementAttempts(attempts);
  if (metadata.fetchError || statusCode === null) return 'technical_error';
  if (metadata.logicVersion && statusCode !== 429 && !(statusCode >= 500 && statusCode <= 599)) return 'confirmed';
  return 'historical_unknown';
}

function httpFailureReason(initialStatus, finalStatus, redirects) {
  if (redirects.length || (initialStatus >= 300 && initialStatus < 400)) return 'redirected_resource';
  if (finalStatus === 204) return 'http_204_no_content';
  if (finalStatus >= 400 && finalStatus < 500) return `http_${finalStatus}`;
  if (finalStatus >= 500 && finalStatus < 600) return `confirmed_http_${finalStatus}`;
  return `unexpected_http_${finalStatus ?? 'unknown'}`;
}

function extractHeadings(text) {
  const output = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const value = normalizeLabel(match[2]);
    if (!value) continue;
    output.push({ level: match[1].length, text: value, line: index + 1 });
  }
  return output;
}

function extractUsableSections(text, headings) {
  const lines = String(text).split(/\r?\n/);
  const output = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.level < 2) continue;
    const nextLine = headings[index + 1]?.line || lines.length + 1;
    const content = lines.slice(heading.line, nextLine - 1)
      .map((line) => line.trim())
      .filter((line) => line && !/^<!--/.test(line));
    if (content.length) output.push({ heading: heading.text, line: heading.line, contentLines: content.length });
  }
  return output;
}

function extractInternalUrls(text, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const candidates = [];
  const markdown = /\[[^\]]*]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/gi;
  const absolute = /https?:\/\/[^\s<>)\]]+/gi;
  for (const match of String(text).matchAll(markdown)) candidates.push(match[1]);
  for (const match of String(text).matchAll(absolute)) candidates.push(match[0]);
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate.replace(/[.,;:!?]+$/, ''), base);
      if (!sameCanonicalSiteHost(parsed.hostname, base.hostname)) continue;
      parsed.hash = '';
      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    } catch {
      // Invalid references are excluded from the compact valid-target evidence.
    }
  }
  return output;
}

function sameCanonicalSiteHost(left, right) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

function normalizeLabel(value) {
  return String(value || '')
    .replace(/[*_`~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function charsetFromContentType(contentType) {
  return contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() || null;
}

function headerValue(value, key) {
  return safeJson(value, {})?.[key] || safeJson(value, {})?.[key.toLowerCase()] || null;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
