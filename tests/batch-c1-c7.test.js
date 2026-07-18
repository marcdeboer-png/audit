import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDataAvailability,
  isObservedFact
} from '../src/checks/availability.js';
import { classifyInternalSearchPage } from '../src/checks/searchPageClassifier.js';
import {
  buildSyntheticNotFoundUrls,
  classifyProbe,
  probeUrl,
  syntheticNotFoundCheck
} from '../src/checks/http/notFoundCheck.js';
import { computeScores } from '../src/utils/scoring.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';

test('availability gates distinguish values from missing measurements', () => {
  const facts = { empty: '', nil: null, zero: 0, disabled: false, missing: undefined };
  assert.equal(isObservedFact(facts, 'empty'), true);
  assert.equal(isObservedFact(facts, 'nil'), false);
  assert.equal(isObservedFact(facts, 'zero'), true);
  assert.equal(isObservedFact(facts, 'disabled'), true);
  assert.equal(isObservedFact(facts, 'missing'), false);
  assert.equal(isObservedFact(facts, 'absent'), false);

  assert.equal(evaluateDataAvailability({ facts: { value: '' }, requiredFacts: ['value'] }).evaluationState, 'pass');
  assert.equal(evaluateDataAvailability({ facts: {}, requiredFacts: ['value'] }).evaluationState, 'insufficient_evidence');
  assert.equal(evaluateDataAvailability({ facts: {}, requiredFacts: ['value'], executed: false }).evaluationState, 'not_executed');
  assert.equal(evaluateDataAvailability({ facts: {}, requiredFacts: ['value'], technicalError: 'extractor crashed' }).evaluationState, 'technical_error');
  assert.equal(evaluateDataAvailability({ facts: {}, requiredFacts: ['value'], applicable: false }).evaluationState, 'not_applicable');
});

test('search classifier requires independent result-page signals', () => {
  const cases = [
    {
      label: 'real internal search page',
      page: { url: 'https://example.com/search/?s=boots', title: 'Search results for boots', featureFlags: { mainSearchFormCount: 1, searchResultListCount: 1 } },
      expected: 'internal_search'
    },
    {
      label: 'query parameter with result template',
      page: { url: 'https://example.com/?q=boots', h1: ['Results for boots'], featureFlags: { searchResultListCount: 1 } },
      expected: 'internal_search'
    },
    {
      label: 'blog overview with header search',
      page: { url: 'https://example.com/blog/', pageType: 'blog_index', featureFlags: { searchFormCount: 1, globalSearchFormCount: 1 } },
      expected: 'not_internal_search'
    },
    {
      label: 'category archive',
      page: { url: 'https://example.com/category/shoes/', pageType: 'category_index', featureFlags: { searchFormCount: 1 } },
      expected: 'not_internal_search'
    },
    {
      label: 'glossary',
      page: { url: 'https://example.com/glossary/', title: 'Glossary', featureFlags: { searchFormCount: 1 } },
      expected: 'not_internal_search'
    },
    {
      label: 'filter page',
      page: { url: 'https://example.com/products/?filter=red', pageType: 'product_index', featureFlags: { mainSearchFormCount: 0 } },
      expected: 'not_internal_search'
    },
    {
      label: 'unknown q parameter',
      page: { url: 'https://example.com/page/?q=abc' },
      expected: 'not_internal_search'
    },
    {
      label: 'SearchAction on a normal homepage',
      page: { url: 'https://example.com/', pageType: 'homepage', schemaTypes: ['SearchAction'] },
      expected: 'not_internal_search'
    },
    {
      label: 'conflicting archive signals',
      page: { url: 'https://example.com/category/search/?s=boots', pageType: 'category_index', title: 'Search results for boots' },
      expected: 'unclear'
    }
  ];
  for (const item of cases) {
    assert.equal(classifyInternalSearchPage(item.page).classification, item.expected, item.label);
  }
});

test('HTML extraction separates global search controls from result-page evidence', () => {
  const globalOnly = extractHtml(`<!doctype html><html><head><title>Blog</title></head><body>
    <header><form role="search"><input type="search" name="q"></form></header>
    <main><h1>Blog</h1></main></body></html>`, 'https://example.com/blog/', 'https://example.com');
  assert.equal(globalOnly.featureFlags.searchFormCount, 1);
  assert.equal(globalOnly.featureFlags.mainSearchFormCount, 0);

  const result = extractHtml(`<!doctype html><html><head><title>Search results for boots</title></head><body>
    <main><h1>Search results for boots</h1><form role="search"><input name="q"></form>
    <section class="search-results"><article>Boot result</article></section></main></body></html>`, 'https://example.com/search/?q=boots', 'https://example.com');
  assert.equal(result.featureFlags.mainSearchFormCount, 1);
  assert.equal(result.featureFlags.searchResultListCount, 1);
  assert.equal(classifyInternalSearchPage({ ...result.page, url: 'https://example.com/search/?q=boots' }).classification, 'internal_search');
});

test('synthetic URL builder creates root, nested, file and query probes without sensitive paths', () => {
  const probes = buildSyntheticNotFoundUrls('https://example.com', '0123456789abcdef');
  assert.deepEqual(probes.map((item) => item.kind), ['root_path', 'nested_path', 'file_path', 'query_path']);
  assert.equal(probes.some((item) => /admin|login|api|security/i.test(new URL(item.url).pathname)), false);
  assert.equal(new URL(probes[2].url).pathname.endsWith('.xyz'), true);
  assert.equal(new URL(probes[3].url).searchParams.get('audit_test'), '1');
});

test('synthetic 404 classifier covers pass, soft-404, homepage redirect, 5xx and technical outcomes', async () => {
  const homepage = probeFact(200, '<title>Home</title><main>Regular landing page content</main>', 'https://example.com/');
  const matrix = [
    ['real 404', probeFact(404, '<title>Not found</title>', 'https://example.com/missing'), 'pass', 'http_404'],
    ['real 410', probeFact(410, '<title>Gone</title>', 'https://example.com/gone'), 'pass', 'http_410'],
    ['custom 404 page', probeFact(404, '<title>Custom missing page</title><h1>Not found</h1>', 'https://example.com/custom'), 'pass', 'http_404'],
    ['soft 404', probeFact(200, '<title>Missing</title><h1>No result</h1>', 'https://example.com/soft'), 'fail', 'soft_404_http_200'],
    ['server error', probeFact(500, '<title>Error</title>', 'https://example.com/broken'), 'fail', 'server_error_500'],
    ['network error', { ...probeFact(null, '', 'https://example.com/network'), technicalError: 'ECONNRESET', technicalErrorType: 'network_error' }, 'technical_error', 'network_error']
  ];
  for (const [label, probe, outcome, reason] of matrix) {
    const classified = classifyProbe(probe, homepage, 'https://example.com');
    assert.equal(classified.outcome, outcome, label);
    assert.equal(classified.reason, reason, label);
  }

  const redirectProbe = await probeUrl('https://example.com/missing', responseSequence([
    response(302, '', 'text/html', { location: '/' }),
    response(200, '<title>Home</title><main>Regular landing page content</main>')
  ]));
  const redirected = classifyProbe(redirectProbe, homepage, 'https://example.com');
  assert.equal(redirected.outcome, 'fail');
  assert.equal(redirected.reason, 'redirect_to_homepage');

  const loopProbe = await probeUrl('https://example.com/loop-a', async (url) => response(302, '', 'text/html', {
    location: url.endsWith('loop-a') ? '/loop-b' : '/loop-a'
  }));
  const loop = classifyProbe(loopProbe, homepage, 'https://example.com');
  assert.equal(loop.outcome, 'fail');
  assert.equal(loop.severity, 'critical');
  assert.equal(loop.reason, 'redirect_loop');
});

test('synthetic check treats network failure as technical error and does not score it as a site failure', async () => {
  const check = syntheticNotFoundCheck({
    force: true,
    nonceFactory: () => 'abcdef0123456789',
    clock: () => '2026-07-16T12:00:00.000Z',
    request: async (url) => {
      if (new URL(url).pathname === '/') return response(200, '<title>Home</title><h1>Home</h1>');
      throw new Error('fixture network failure');
    }
  });
  const result = await check.run({
    run: { id: 1, finalDomain: 'https://example.com', requestTimeoutMs: 1000 },
    project: { finalDomain: 'https://example.com' }
  });
  assert.equal(result.status, 'NA');
  assert.equal(result.evaluationState, 'technical_error');
  assert.equal(result.scoreEligible, false);
  assert.equal(result.affectedCount, 0);
  assert.equal(result.facts.technicalErrorCount, 4);
});

test('synthetic check passes root, nested, unknown-file and query probes on stable 404 responses', async () => {
  const check = syntheticNotFoundCheck({
    force: true,
    nonceFactory: () => 'fedcba9876543210',
    request: async (url) => new URL(url).pathname === '/'
      ? response(200, '<title>Home</title><h1>Home</h1>')
      : response(404, '<title>Custom not found</title><h1>Not found</h1>')
  });
  const result = await check.run({
    run: { id: 2, status: 'running', sourceType: 'crawl', finalDomain: 'https://example.com', requestTimeoutMs: 1000 },
    project: { finalDomain: 'https://example.com' }
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.evaluationState, 'pass');
  assert.equal(result.facts.passCount, 4);
  assert.deepEqual(result.facts.probes.map((item) => item.kind), ['root_path', 'nested_path', 'file_path', 'query_path']);
  assert.deepEqual([...new Set(result.facts.probes.map((item) => item.finalStatusCode))], [404]);
});

test('score calibration prioritizes critical risks, deduplicates root causes and excludes unavailable checks', () => {
  const pass = resultRow('pass', 'OK', 'High', 'core_issue');
  const critical = { ...resultRow('critical', 'Error', 'High', 'core_issue'), assessment: { severity: 'critical' } };
  const lowOptional = Array.from({ length: 23 }, (_, index) => resultRow(`optional-${index}`, 'Warning', 'Low', 'opportunity'));
  const criticalResult = computeScores([pass, critical]);
  const optionalResult = computeScores([pass, ...lowOptional]);
  const criticalScore = criticalResult.overallScore;
  const optionalScore = optionalResult.overallScore;
  assert.ok(criticalScore < optionalScore, { criticalScore, optionalScore });
  assert.ok(criticalResult.breakdown.appliedPenalty > optionalResult.breakdown.appliedPenalty);
  assert.ok(optionalResult.breakdown.capsApplied.some((cap) => cap.type === 'optional_low_global'));

  const oneUrl = computeScores([{ ...resultRow('sitewide', 'Warning'), affectedCount: 1 }]);
  const manyUrls = computeScores([{ ...resultRow('sitewide', 'Warning'), affectedCount: 1000 }]);
  assert.ok(manyUrls.overallScore < oneUrl.overallScore);
  assert.ok(manyUrls.breakdown.appliedPenalty < oneUrl.breakdown.appliedPenalty * 3);

  const deduplicated = computeScores([
    { ...resultRow('social-image', 'Warning', 'Low', 'opportunity'), scoreDeduplicationKey: 'social.open_graph' },
    { ...resultRow('open-graph', 'Warning', 'Low', 'opportunity'), scoreDeduplicationKey: 'social.open_graph' }
  ]);
  assert.equal(deduplicated.breakdown.deduplicatedChecks, 1);
  assert.equal(deduplicated.breakdown.rootCauseCount, 1);
  assert.equal(deduplicated.breakdown.scoredFindingCount, 2);

  const restricted = computeScores([
    pass,
    { ...resultRow('missing-data', 'NA'), score: null, evaluationState: 'insufficient_evidence', scoreEligible: false, scoreExclusionReason: 'missing extractor fact' }
  ]);
  assert.equal(restricted.overallScore, 100);
  assert.equal(restricted.diagnosticOverallScore, 100);
  assert.equal(restricted.scoreStatus, 'provisional');
  assert.equal(restricted.breakdown.excludedChecks, 1);
  assert.ok(restricted.breakdown.dataCoveragePct < 100);
  assert.equal(restricted.breakdown.excluded[0].reason, 'missing extractor fact');

  const complete = computeScores([pass, resultRow('second-pass', 'OK')]);
  assert.equal(complete.overallScore, restricted.overallScore);
  assert.ok(complete.breakdown.dataCoveragePct > restricted.breakdown.dataCoveragePct);
});

function resultRow(id, status, priority = 'Medium', findingType = 'core_issue') {
  return {
    id,
    checkId: id,
    auditType: 'tech',
    category: findingType === 'opportunity' ? 'HTML Head & Meta Opportunity' : 'Server & Infrastructure',
    status,
    score: status === 'OK' ? 10 : status === 'Warning' ? 5 : status === 'Error' ? 1 : null,
    evaluationState: status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(status) ? 'fail' : 'insufficient_evidence',
    scoreEligible: status !== 'NA',
    priority,
    findingType
  };
}

function probeFact(statusCode, body, finalUrl) {
  const words = String(body || '').toLowerCase().replace(/<[^>]+>/g, ' ').split(/\W+/).filter((word) => word.length > 2);
  return {
    testedUrl: finalUrl,
    finalUrl,
    statusCode,
    redirectChain: [{ url: finalUrl, statusCode, location: null }],
    contentType: 'text/html; charset=utf-8',
    bodyLength: Buffer.byteLength(body || ''),
    title: null,
    fingerprint: {
      normalizedTextSha256: `${statusCode}-${body}`,
      tokenSample: [...new Set(words)]
    },
    relevantHeaders: {},
    checkedAt: '2026-07-16T12:00:00.000Z',
    technicalError: null,
    technicalErrorType: null
  };
}

function response(statusCode, body = '', contentType = 'text/html; charset=utf-8', headers = {}) {
  return {
    statusCode,
    body,
    contentType,
    sizeBytes: Buffer.byteLength(body),
    headers: { 'content-type': contentType, ...headers }
  };
}

function responseSequence(items) {
  let index = 0;
  return async () => items[Math.min(index++, items.length - 1)];
}
