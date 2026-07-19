import { getDomain } from 'tldts-icann';
import { normalizeUrl } from '../utils/url.js';

export const CANONICAL_VALIDATION_LOGIC_VERSION = 'canonical-validation-v1';

export function normalizeCanonicalComparable(value, baseUrl = null) {
  const normalized = normalizeUrl(value, baseUrl);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.pathname = decodeUnreserved(url.pathname);
    url.search = decodeUnreserved(url.search);
    return url.toString();
  } catch {
    return normalized;
  }
}

export function canonicalValuesForPage(row = {}, currentModel = false) {
  const state = safeJson(currentModel ? row.effectiveDocumentStateJson : row.rawDocumentStateJson);
  const stateValues = currentModel
    ? state?.fields?.canonicalValues?.effective
    : state?.canonicalValues;
  const fallback = currentModel ? row.effectiveCanonical : row.canonical;
  const authored = Array.isArray(stateValues) && stateValues.length ? stateValues : (fallback ? [fallback] : []);
  return authored
    .map((value) => normalizeCanonicalComparable(value, row.finalUrl || row.url))
    .filter(Boolean);
}

export function evaluateCanonicalPage(row = {}, primaryUrl = null, currentModel = false) {
  const expectedUrl = normalizeCanonicalComparable(row.finalUrl || row.normalizedUrl || row.url);
  const values = canonicalValuesForPage(row, currentModel);
  const uniqueValues = [...new Set(values)];
  const relationships = uniqueValues.map((canonical) => canonicalHostRelationship(canonical, primaryUrl || row.finalUrl || row.url));
  const conflict = uniqueValues.length > 1;
  const nonSelfValues = uniqueValues.filter((canonical) => canonical !== expectedUrl);
  const crossDomainValues = uniqueValues.filter((_, index) => relationships[index]?.relationship === 'cross_registrable_domain');
  return {
    url: row.url,
    finalUrl: row.finalUrl || row.url,
    expectedUrl,
    values,
    uniqueValues,
    canonical: uniqueValues[0] || null,
    missing: uniqueValues.length === 0,
    conflict,
    duplicateEquivalentTags: values.length > 1 && uniqueValues.length === 1,
    isSelf: uniqueValues.length === 1 && uniqueValues[0] === expectedUrl,
    nonSelfValues,
    crossDomainValues,
    relationships,
    issueType: conflict ? 'conflicting_canonical_tags' : nonSelfValues.length ? 'non_self' : uniqueValues.length ? 'self' : 'missing'
  };
}

export function canonicalHostRelationship(canonical, primaryUrl) {
  let canonicalHost;
  let primaryHost;
  try {
    canonicalHost = new URL(canonical).hostname.toLowerCase();
    primaryHost = new URL(primaryUrl).hostname.toLowerCase();
  } catch {
    return { relationship: 'invalid_url', canonicalHost: null, primaryHost: null, canonicalDomain: null, primaryDomain: null };
  }
  const canonicalDomain = getDomain(canonicalHost) || canonicalHost;
  const primaryDomain = getDomain(primaryHost) || primaryHost;
  let relationship = 'cross_registrable_domain';
  if (canonicalHost === primaryHost) relationship = 'same_host';
  else if (canonicalHost.replace(/^www\./, '') === primaryHost.replace(/^www\./, '')) relationship = 'www_host_variant';
  else if (canonicalDomain === primaryDomain) relationship = 'same_registrable_domain_subdomain';
  return { relationship, canonicalHost, primaryHost, canonicalDomain, primaryDomain };
}

export function canonicalTargetFacts(sourceEvaluation, targetRows = []) {
  const targetByRequestedUrl = new Map();
  const targetByFinalUrl = new Map();
  for (const target of targetRows) {
    for (const value of [target.url, target.normalizedUrl]) {
      const key = normalizeCanonicalComparable(value);
      if (key && !targetByRequestedUrl.has(key)) targetByRequestedUrl.set(key, target);
    }
    const finalKey = normalizeCanonicalComparable(target.finalUrl);
    if (finalKey && !targetByFinalUrl.has(finalKey)) targetByFinalUrl.set(finalKey, target);
  }
  return sourceEvaluation.uniqueValues.map((canonical) => {
    const target = targetByRequestedUrl.get(canonical) || targetByFinalUrl.get(canonical) || null;
    const initialStatusKnown = Boolean(target && target.initialStatusCode !== null && target.initialStatusCode !== undefined && target.initialStatusCode !== '');
    const initialStatus = initialStatusKnown ? Number(target.initialStatusCode) : null;
    const finalStatusObserved = Boolean(target && target.statusCode !== null && target.statusCode !== undefined && target.statusCode !== '');
    const finalStatus = finalStatusObserved ? Number(target.statusCode) : null;
    const finalContentType = target?.contentType || null;
    const finalContentTypeKnown = Boolean(String(finalContentType || '').trim());
    const redirectChain = safeJson(target?.redirectChainJson, []);
    const finalUrl = target?.finalUrl || target?.url || null;
    const known = Boolean(target && finalStatusObserved && Number.isFinite(finalStatus));
    const initialRedirect = known && initialStatusKnown && initialStatus >= 300 && initialStatus < 400;
    const finalNon200 = known && finalStatus !== 200;
    const finalNonHtml = known && finalStatus === 200 && finalContentType && !/html|xhtml/i.test(finalContentType);
    const measurementComplete = known && initialStatusKnown && (finalStatus !== 200 || finalContentTypeKnown);
    return {
      canonical,
      known,
      initialStatus,
      initialStatusKnown,
      redirectChain: Array.isArray(redirectChain) ? redirectChain : [],
      finalStatus,
      finalUrl,
      finalContentType,
      finalContentTypeKnown,
      measurementComplete,
      initialRedirect,
      finalNon200,
      finalNonHtml,
      issueType: initialRedirect ? 'canonical_target_redirect' : finalNon200 ? 'canonical_target_non_200' : finalNonHtml ? 'canonical_target_non_html' : known ? 'canonical_target_200' : 'canonical_target_unknown'
    };
  });
}

function decodeUnreserved(value) {
  return String(value || '').replace(/%([0-9a-f]{2})/gi, (match, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

function safeJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
