import { followRedirectChain } from '../utils/http.js';
import { normalizeUrl, originCandidates, stripWww, urlOrigin } from '../utils/url.js';
import { classifyHostRelation, RETRY_SENSITIVE_HTTP_STATUSES } from '../utils/httpStatus.js';

export async function detectDomain(inputDomain, options = {}) {
  const candidates = originCandidates(inputDomain);
  const results = [];

  for (const candidate of candidates) {
    const result = await probeCandidate(candidate, options);
    results.push(result);
  }

  const reachable = results.filter((result) => result.ok && result.finalUrl);
  if (!reachable.length) {
    const error = results.find((result) => result.error)?.error || 'No candidate URL reachable';
    throw new Error(`Could not resolve start URL for ${inputDomain}: ${error}`);
  }

  reachable.sort((a, b) => candidateRank(a) - candidateRank(b));
  const selected = reachable[0];
  const finalStartUrl = normalizeUrl(selected.finalUrl) || selected.finalUrl;
  const finalDomain = urlOrigin(finalStartUrl);
  const finalHost = new URL(finalStartUrl).hostname;

  return {
    finalStartUrl,
    finalDomain,
    protocolBehavior: summarizeProtocol(results),
    wwwBehavior: summarizeWww(results, finalHost),
    redirectChain: selected.chain,
    allCandidates: results
  };
}

function candidateRank(result) {
  let score = 0;
  const final = result.finalUrl || result.startUrl;
  const url = new URL(final);
  if (url.protocol !== 'https:') score += 20;
  if (url.hostname.startsWith('www.')) score += 2;
  if (result.statusCode !== 200) score += 5;
  if (result.statusCode >= 400) score += 10;
  score += result.chain.length;
  return score;
}

function summarizeProtocol(results) {
  return results.map((result) => candidateEvidence(result, {
    redirectsToHttps: Boolean(result.finalUrl && new URL(result.finalUrl).protocol === 'https:')
  }));
}

function candidateEvidence(result, extra = {}) {
  const start = new URL(result.startUrl);
  const final = result.finalUrl ? new URL(result.finalUrl) : null;
  const initialStatusCode = result.chain?.[0]?.statusCode ?? null;
  const redirectStatuses = (result.chain || []).filter((entry) => entry.statusCode >= 300 && entry.statusCode < 400).map((entry) => entry.statusCode);
  return {
    startUrl: result.startUrl,
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    initialStatusCode,
    finalStatusCode: result.statusCode,
    redirectChain: result.chain || [],
    chainLength: result.chain.length,
    redirectStatuses,
    permanentRedirect: redirectStatuses.length > 0 && redirectStatuses.every((status) => [301, 308].includes(status)),
    pathPreserved: Boolean(final && start.pathname === final.pathname),
    queryPreserved: Boolean(final && start.search === final.search),
    finalProtocol: final?.protocol || null,
    finalHost: final?.hostname || null,
    hostRelation: final ? classifyHostRelation(start.hostname, final.hostname) : null,
    method: 'GET',
    attempts: result.attempts || [],
    error: result.error || null,
    ...extra
  };
}

function summarizeWww(results, finalHost) {
  return {
    selectedHost: finalHost,
    selectedHostWithoutWww: stripWww(finalHost),
    candidates: results.map((result) => candidateEvidence(result, {
      startHost: new URL(result.startUrl).hostname,
      finalHostWithoutWww: result.finalUrl ? stripWww(new URL(result.finalUrl).hostname) : null
    }))
  };
}

async function probeCandidate(candidate, options) {
  const attempts = [];
  const maximum = 2;
  let result;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    result = await followRedirectChain(candidate, { timeoutMs: 8000, userAgent: options.userAgent });
    attempts.push({
      attempt,
      method: 'GET',
      initialStatusCode: result.chain?.[0]?.statusCode ?? null,
      finalStatusCode: result.statusCode,
      finalUrl: result.finalUrl,
      error: result.error || null
    });
    if (!result.error && !RETRY_SENSITIVE_HTTP_STATUSES.has(Number(result.statusCode))) break;
  }
  return { ...result, attempts };
}
