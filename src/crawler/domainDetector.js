import { followRedirectChain } from '../utils/http.js';
import { normalizeUrl, originCandidates, stripWww, urlOrigin } from '../utils/url.js';

export async function detectDomain(inputDomain, options = {}) {
  const candidates = originCandidates(inputDomain);
  const results = [];

  for (const candidate of candidates) {
    const result = await followRedirectChain(candidate, { timeoutMs: 8000, userAgent: options.userAgent });
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
  return results.map((result) => ({
    startUrl: result.startUrl,
    finalUrl: result.finalUrl,
    statusCode: result.statusCode,
    redirectsToHttps: Boolean(result.finalUrl && new URL(result.finalUrl).protocol === 'https:'),
    chainLength: result.chain.length,
    error: result.error || null
  }));
}

function summarizeWww(results, finalHost) {
  return {
    selectedHost: finalHost,
    selectedHostWithoutWww: stripWww(finalHost),
    candidates: results.map((result) => ({
      startHost: new URL(result.startUrl).hostname,
      finalHost: result.finalUrl ? new URL(result.finalUrl).hostname : null,
      finalHostWithoutWww: result.finalUrl ? stripWww(new URL(result.finalUrl).hostname) : null,
      statusCode: result.statusCode,
      error: result.error || null
    }))
  };
}
