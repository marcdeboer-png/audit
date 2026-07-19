import { getDomain } from 'tldts-icann';

export const HTTP_STATUS_VALIDATION_VERSION = 'http-status-validation-v1';
export const RETRY_SENSITIVE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_STORED_ATTEMPTS = 5;

export function compactHttpAttempt(input = {}) {
  return {
    attempt: positiveInteger(input.attempt),
    method: String(input.method || 'GET').toUpperCase(),
    requestedUrl: input.requestedUrl || input.url || null,
    initialStatus: finiteStatus(input.initialStatus ?? input.initialStatusCode),
    redirectChain: compactRedirectChain(input.redirectChain),
    finalStatus: finiteStatus(input.finalStatus ?? input.finalStatusCode ?? input.statusCode),
    finalUrl: input.finalUrl || null,
    contentType: input.contentType || null,
    durationMs: finiteNumber(input.durationMs ?? input.loadTimeMs),
    checkedAt: input.checkedAt || new Date().toISOString(),
    technicalErrorType: input.technicalErrorType || input.errorType || null,
    technicalError: input.technicalError || input.error || null
  };
}

export function parseHttpAttempts(value) {
  if (Array.isArray(value)) return value.map(compactHttpAttempt).slice(-MAX_STORED_ATTEMPTS);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(compactHttpAttempt).slice(-MAX_STORED_ATTEMPTS) : [];
  } catch {
    return [];
  }
}

export function appendHttpAttemptHistory(value, attempt) {
  return JSON.stringify([...parseHttpAttempts(value), compactHttpAttempt(attempt)].slice(-MAX_STORED_ATTEMPTS));
}

export function classifyHttpStability(value) {
  const attempts = parseHttpAttempts(value);
  const completed = attempts.filter((item) => item.finalStatus !== null);
  const errors = attempts.filter((item) => item.technicalErrorType || item.technicalError);
  if (!attempts.length) return { status: 'insufficient_evidence', attempts: [], finalStatus: null };
  if (!completed.length) return { status: errors.length ? 'technical_error' : 'insufficient_evidence', attempts, finalStatus: null };
  const last = completed.at(-1);
  const observedStatuses = [...new Set(completed.map((item) => item.finalStatus))];
  if (observedStatuses.length > 1 || (errors.length && completed.length)) {
    return { status: 'transient', attempts, finalStatus: last.finalStatus, observedStatuses };
  }
  if (RETRY_SENSITIVE_HTTP_STATUSES.has(last.finalStatus)) {
    return {
      status: completed.length >= 2 ? 'confirmed' : 'insufficient_evidence',
      attempts,
      finalStatus: last.finalStatus,
      observedStatuses
    };
  }
  return { status: 'confirmed', attempts, finalStatus: last.finalStatus, observedStatuses };
}

export function classifyHostRelation(requestedHost, candidateHost) {
  const requested = normalizeHost(requestedHost);
  const candidate = normalizeHost(candidateHost);
  if (!requested || !candidate) return 'different_registrable_domain';
  if (requested === candidate) return 'same';
  if (stripWww(requested) === stripWww(candidate)) return 'www_variant';
  const requestedDomain = getDomain(requested);
  const candidateDomain = getDomain(candidate);
  if (requestedDomain && candidateDomain && requestedDomain === candidateDomain) return 'subdomain';
  return 'different_registrable_domain';
}

export function isRegistrableApexHost(host) {
  const normalized = normalizeHost(host);
  const domain = normalized ? getDomain(normalized) : null;
  return Boolean(domain && normalized === domain);
}

export function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function stripWww(value) {
  return normalizeHost(value).replace(/^www\./, '');
}

function compactRedirectChain(value) {
  const rows = Array.isArray(value) ? value : parseJsonArray(value);
  return rows.slice(0, 10).map((item) => ({
    url: item?.url || null,
    statusCode: finiteStatus(item?.statusCode),
    location: item?.location || null
  }));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function finiteStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 999 ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
