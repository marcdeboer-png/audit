import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { fetchWithTimeout, selectedHeaders } from '../../utils/http.js';
import { makeResult } from '../helpers.js';

const MAX_REDIRECTS = 6;
const SAFE_PREFIX = '__seo-audit-not-found';

export function buildSyntheticNotFoundUrls(origin, nonce = crypto.randomUUID().replaceAll('-', '')) {
  const base = new URL(origin);
  const token = String(nonce).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64) || crypto.randomUUID().replaceAll('-', '');
  const stem = `${SAFE_PREFIX}-${token}`;
  return [
    { kind: 'root_path', url: new URL(`/${stem}/`, base).toString() },
    { kind: 'nested_path', url: new URL(`/${stem}/nested/page/`, base).toString() },
    { kind: 'file_path', url: new URL(`/${stem}.xyz`, base).toString() },
    { kind: 'query_path', url: new URL(`/${stem}/?audit_test=1`, base).toString() }
  ];
}

export function syntheticNotFoundCheck(options = {}) {
  const request = options.request || fetchWithTimeout;
  const nonceFactory = options.nonceFactory || (() => crypto.randomUUID().replaceAll('-', ''));
  const clock = options.clock || (() => new Date().toISOString());
  return {
    id: 'tech.synthetic_not_found_handling',
    category: 'Server & Infrastructure',
    name: 'Synthetic unknown-URL error handling',
    auditType: 'tech',
    priority: 'High',
    effort: 'S',
    preserveCollectedEvidenceOnRerun: true,
    async run(ctx) {
      if (!options.force && (ctx.run.sourceType === 'screaming_frog_import' || ctx.run.status !== 'running')) {
        return makeResult(this, 'NA', {
          evaluationState: 'not_executed',
          finding: 'Synthetic unknown-URL requests were not executed outside an active live crawl.',
          details: 'Import-only runs and later report/check recalculations do not issue new live HTTP requests.',
          recommendation: 'Run a small live crawl or invoke this targeted HTTP check during an active audit.',
          facts: { sourceType: ctx.run.sourceType || 'crawl', runStatus: ctx.run.status || null },
          evidence: { checkId: this.id, lifecycleGate: 'active_live_crawl_only' },
          requirements: requirements(['activeLiveCrawl'], [], ['activeLiveCrawl']),
          scoreDeduplicationKey: 'http.not_found_handling'
        });
      }
      const origin = ctx.run.finalDomain || ctx.project.finalDomain;
      if (!origin) {
        return makeResult(this, 'NA', {
          evaluationState: 'not_executed',
          finding: 'Synthetic 404 handling was not executed because no canonical origin was available.',
          details: 'Domain detection must complete before this targeted HTTP check can run.',
          recommendation: 'Repeat domain detection and rerun only this targeted HTTP check.',
          facts: { origin: null },
          evidence: { checkId: this.id, source: 'domain_detection' },
          requirements: requirements(['canonicalOrigin'], ['homepageFingerprint']),
          scoreDeduplicationKey: 'http.not_found_handling'
        });
      }

      const checkedAt = clock();
      const homepage = await probeUrl(new URL('/', origin).toString(), request, ctx.run, checkedAt);
      const cases = buildSyntheticNotFoundUrls(origin, nonceFactory());
      const probes = [];
      for (const item of cases) {
        const probe = await probeUrl(item.url, request, ctx.run, checkedAt);
        probes.push({ ...item, ...classifyProbe(probe, homepage, origin), ...probe });
      }

      const failures = probes.filter((probe) => probe.outcome === 'fail');
      const technical = probes.filter((probe) => probe.outcome === 'technical_error');
      const severe = failures.filter((probe) => probe.severity === 'critical');
      const passes = probes.filter((probe) => probe.outcome === 'pass');
      const state = failures.length ? 'fail' : technical.length ? 'technical_error' : 'pass';
      const status = severe.length ? 'Error' : failures.length ? 'Warning' : state === 'pass' ? 'OK' : 'NA';
      const priority = severe.length ? 'High' : failures.length ? 'High' : 'Low';
      const missingFacts = technical.length ? ['stableHttpResponseForAllSyntheticUrls'] : [];

      return makeResult(this, status, {
        evaluationState: state,
        priority,
        affectedCount: failures.length,
        sampleUrls: failures.map((probe) => probe.url),
        finding: failures.length
          ? `${failures.length}/${probes.length} synthetic unknown URL(s) failed correct 404/410 handling.`
          : technical.length
            ? `Synthetic unknown-URL handling could not be evaluated reliably for ${technical.length}/${probes.length} probe(s).`
            : `${passes.length}/${probes.length} synthetic unknown URL(s) returned a stable 404 or 410 response.`,
        details: failures.length
          ? summarizeOutcomes(failures)
          : technical.length
            ? `No website defect was scored. Technical probe outcomes: ${summarizeOutcomes(technical)}`
            : 'Root-level, nested, file-like and query-string paths were tested with safe GET requests.',
        recommendation: failures.length
          ? 'Configure unknown URLs to return 404 or intentional 410 without redirecting to regular content; verify the custom error handler does not recurse or return 5xx.'
          : technical.length
            ? 'Repeat this small targeted check after resolving the network, firewall or robots limitation.'
            : 'No change required for synthetic unknown-URL handling.',
        facts: {
          origin,
          requestedProbeCount: probes.length,
          passCount: passes.length,
          failureCount: failures.length,
          technicalErrorCount: technical.length,
          homepageStatusCode: homepage.statusCode,
          probes: probes.map(compactProbeFact)
        },
        evidence: {
          checkId: this.id,
          extractor: 'synthetic_not_found_http_probe',
          checkedAt,
          requestMethod: 'GET',
          homepageFingerprint: homepage.fingerprint,
          probes: probes.map(compactProbeEvidence)
        },
        assessment: {
          severity: severe.length ? 'critical' : failures.length ? 'high' : 'none',
          rationale: failures.length ? summarizeOutcomes(failures) : technical.length ? 'Evidence collection was incomplete.' : 'All stable probes returned 404/410.',
          validityConditions: ['unique nonce path', 'stable HTTP response', 'no write request'],
          confidence: technical.length ? 'low' : 'high'
        },
        recommendationMeta: {
          action: failures.length ? 'Correct the server error/redirect handling for unknown URLs.' : 'No action required.',
          expectedBenefit: 'Reliable crawl and indexation semantics for missing URLs.',
          whenNotToImplement: 'Do not replace an intentional 410 response with 404.',
          priority,
          effort: 'S'
        },
        requirements: requirements(['canonicalOrigin', 'stableHttpResponseForAllSyntheticUrls'], ['homepageFingerprint'], missingFacts),
        confidence: technical.length ? 'low' : 'high',
        evidenceLevel: 'fact',
        automationCoverage: technical.length ? 'partial' : 'full',
        scoreDeduplicationKey: 'http.not_found_handling',
        reportGroupingKey: 'http.not_found_handling',
        relatedCheckIds: ['tech.4xx_pages', 'tech.5xx_pages']
      });
    }
  };
}

export async function probeUrl(startUrl, request = fetchWithTimeout, run = {}, checkedAt = new Date().toISOString()) {
  let currentUrl = startUrl;
  const redirectChain = [];
  const seen = new Set();
  let finalResponse = null;

  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    if (seen.has(currentUrl)) {
      return technicalProbe(startUrl, currentUrl, redirectChain, checkedAt, 'Redirect loop detected', 'redirect_loop');
    }
    seen.add(currentUrl);
    let response;
    try {
      response = await request(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        timeoutMs: Number(run.requestTimeoutMs || 15000),
        maxBytes: 256 * 1024,
        userAgent: run.userAgent
      });
    } catch (error) {
      return technicalProbe(startUrl, currentUrl, redirectChain, checkedAt, error.message, 'network_error');
    }

    const location = response.headers?.location ? safeAbsoluteUrl(response.headers.location, currentUrl) : null;
    redirectChain.push({ url: currentUrl, statusCode: response.statusCode, location });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (!location) return technicalProbe(startUrl, currentUrl, redirectChain, checkedAt, 'Redirect response has no usable Location header', 'invalid_redirect');
      currentUrl = location;
      continue;
    }
    finalResponse = response;
    break;
  }

  if (!finalResponse) return technicalProbe(startUrl, currentUrl, redirectChain, checkedAt, 'Too many redirects', 'redirect_loop');
  const fingerprint = fingerprintBody(finalResponse.body, finalResponse.contentType);
  return {
    testedUrl: startUrl,
    finalUrl: currentUrl,
    statusCode: finalResponse.statusCode,
    redirectChain,
    contentType: finalResponse.contentType || '',
    bodyLength: Number(finalResponse.sizeBytes ?? Buffer.byteLength(finalResponse.body || '', 'utf8')),
    title: fingerprint.title,
    fingerprint,
    relevantHeaders: selectedHeaders(finalResponse.headers || {}),
    checkedAt,
    technicalError: null,
    technicalErrorType: null
  };
}

export function classifyProbe(probe, homepage, origin) {
  if (probe.technicalErrorType === 'redirect_loop') {
    return { outcome: 'fail', severity: 'critical', reason: 'redirect_loop', homepageSimilarity: null };
  }
  if (probe.technicalError) {
    return { outcome: 'technical_error', severity: 'none', reason: probe.technicalErrorType || 'technical_error', homepageSimilarity: null };
  }
  const status = Number(probe.statusCode || 0);
  const homepageSimilarity = compareFingerprints(probe.fingerprint, homepage?.fingerprint);
  const finalPath = safePath(probe.finalUrl);
  const originPath = safePath(new URL('/', origin).toString());
  const redirected = probe.redirectChain.length > 1;
  if (status === 404 || status === 410) return { outcome: 'pass', severity: 'none', reason: `http_${status}`, homepageSimilarity };
  if (status >= 500 && status <= 599) return { outcome: 'fail', severity: 'critical', reason: `server_error_${status}`, homepageSimilarity };
  if (status === 200) {
    const homeLike = homepageSimilarity !== null && homepageSimilarity >= 0.85;
    const redirectedToHome = redirected && finalPath === originPath;
    return {
      outcome: 'fail',
      severity: 'high',
      reason: redirectedToHome ? 'redirect_to_homepage' : redirected ? 'redirect_to_regular_200_page' : homeLike ? 'soft_404_homepage_match' : 'soft_404_http_200',
      homepageSimilarity
    };
  }
  if ([401, 403, 429].includes(status)) return { outcome: 'technical_error', severity: 'none', reason: `blocked_or_rate_limited_${status}`, homepageSimilarity };
  if (status >= 300 && status < 400) return { outcome: 'technical_error', severity: 'none', reason: 'unstable_redirect_response', homepageSimilarity };
  return { outcome: 'technical_error', severity: 'none', reason: `unsupported_status_${status || 'unknown'}`, homepageSimilarity };
}

function fingerprintBody(body, contentType = '') {
  const html = /html|xhtml/i.test(contentType) || /<html[\s>]/i.test(String(body || '').slice(0, 500));
  let title = null;
  let text = String(body || '');
  if (html) {
    const $ = cheerio.load(text);
    title = $('title').first().text().replace(/\s+/g, ' ').trim() || null;
    $('script,style,noscript').remove();
    text = $('body').text();
  }
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 20000);
  const tokens = [...new Set(normalizedText.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2))].slice(0, 500);
  return {
    bodySha256: crypto.createHash('sha256').update(String(body || '')).digest('hex'),
    normalizedTextSha256: crypto.createHash('sha256').update(normalizedText).digest('hex'),
    title,
    textLength: normalizedText.length,
    tokenSample: tokens,
    excerpt: normalizedText.slice(0, 240)
  };
}

function compareFingerprints(left, right) {
  if (!left || !right || !left.tokenSample?.length || !right.tokenSample?.length) return null;
  if (left.normalizedTextSha256 === right.normalizedTextSha256) return 1;
  const a = new Set(left.tokenSample);
  const b = new Set(right.tokenSample);
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? Number((intersection / union).toFixed(3)) : null;
}

function compactProbeFact(probe) {
  return {
    kind: probe.kind,
    testedUrl: probe.testedUrl || probe.url,
    finalUrl: probe.finalUrl,
    finalStatusCode: probe.statusCode,
    redirectCount: Math.max(0, (probe.redirectChain || []).length - 1),
    contentType: probe.contentType,
    bodyLength: probe.bodyLength,
    title: probe.title,
    homepageSimilarity: probe.homepageSimilarity,
    outcome: probe.outcome,
    reason: probe.reason
  };
}

function compactProbeEvidence(probe) {
  return {
    kind: probe.kind,
    testedUrl: probe.testedUrl || probe.url,
    redirectChain: probe.redirectChain,
    relevantHeaders: probe.relevantHeaders,
    checkedAt: probe.checkedAt,
    bodySha256: probe.fingerprint?.bodySha256 || null,
    excerpt: probe.fingerprint?.excerpt || null,
    technicalError: probe.technicalError
  };
}

function technicalProbe(startUrl, finalUrl, redirectChain, checkedAt, message, type) {
  return {
    testedUrl: startUrl,
    finalUrl,
    statusCode: null,
    redirectChain,
    contentType: '',
    bodyLength: 0,
    title: null,
    fingerprint: null,
    relevantHeaders: {},
    checkedAt,
    technicalError: message,
    technicalErrorType: type
  };
}

function requirements(requiredFacts, optionalFacts, missingFacts = []) {
  return {
    requiredFacts,
    optionalFacts,
    minimumCoverage: 1,
    missingFacts,
    canCollectWithTargetedRun: true
  };
}

function summarizeOutcomes(probes) {
  return probes.map((probe) => `${probe.kind}:${probe.reason}`).join(', ');
}

function safeAbsoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function safePath(value) {
  try {
    return new URL(value).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}
