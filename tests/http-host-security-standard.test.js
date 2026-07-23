import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import {
  HEADER_POLICY_VERSION,
  parseContentSecurityPolicy,
  parseCrossOriginPolicies,
  parseFrameProtection,
  parseHsts,
  parsePermissionsPolicy,
  parseReferrerPolicy,
  parseXContentTypeOptions
} from '../src/utils/headerSemantics.js';
import { followRedirectChain } from '../src/utils/http.js';

test('versioned security parsers distinguish presence, validity and effective protection', () => {
  const nonceCsp = parseContentSecurityPolicy({
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-abc'; frame-ancestors 'self'"
  });
  assert.equal(nonceCsp.logicVersion, HEADER_POLICY_VERSION);
  assert.equal(nonceCsp.pass, true);
  assert.equal(nonceCsp.frameAncestors[0], "'self'");

  assert.equal(parseContentSecurityPolicy({
    'content-security-policy-report-only': "default-src 'self'"
  }).state, 'report_only');
  const weakCsp = parseContentSecurityPolicy({
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'"
  });
  assert.equal(weakCsp.state, 'dangerously_weak');
  assert.equal(weakCsp.severity, 'Medium');
  assert.equal(parseContentSecurityPolicy({
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'nonce-abc'"
  }).state, 'dangerously_weak');

  assert.equal(parsePermissionsPolicy({}).state, 'missing');
  assert.equal(parsePermissionsPolicy({ 'permissions-policy': 'camera=*, microphone=()' }).state, 'invalid');
  assert.equal(parsePermissionsPolicy({ 'permissions-policy': 'camera=(*), microphone=()' }).state, 'dangerously_open');
  assert.equal(parsePermissionsPolicy({ 'permissions-policy': 'camera=(), geolocation=(self)' }).pass, true);

  assert.equal(parseReferrerPolicy({ 'referrer-policy': 'strict-origin-when-cross-origin' }).pass, true);
  assert.equal(parseReferrerPolicy({ 'referrer-policy': 'origin' }).qualityTier, 'valid_alternative');
  assert.equal(parseReferrerPolicy({ 'referrer-policy': 'unsafe-url' }).state, 'unsafe');

  assert.equal(parseXContentTypeOptions({ 'x-content-type-options': 'nosniff' }).pass, true);
  assert.equal(parseXContentTypeOptions({ 'x-content-type-options': 'nosniff, invalid' }).state, 'invalid');

  const cspFrame = parseFrameProtection({
    'content-security-policy': "default-src 'self'; frame-ancestors 'self'",
    'x-frame-options': 'ALLOWALL'
  });
  assert.equal(cspFrame.state, 'protected_by_csp');
  assert.equal(cspFrame.pass, true);
  assert.equal(parseFrameProtection({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }).state, 'unprotected');

  assert.equal(parseHsts({ 'strict-transport-security': 'max-age=31536000; includeSubDomains' }, { url: 'https://fixture.invalid/' }).pass, true);
  assert.equal(parseHsts({ 'strict-transport-security': 'max-age=300' }, { url: 'https://fixture.invalid/' }).state, 'too_short');
  assert.equal(parseHsts({}, { url: 'http://fixture.invalid/' }).state, 'not_applicable');

  const crossOrigin = parseCrossOriginPolicies({
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-site'
  });
  assert.equal(crossOrigin.coep.effective, 'require-corp');
  assert.equal(crossOrigin.coep.protective, true);
  assert.equal(crossOrigin.coop.effective, 'same-origin');
  assert.equal(crossOrigin.coop.state, 'protective');
  assert.equal(crossOrigin.corp.effective, 'same-site');
  assert.equal(crossOrigin.corp.protective, true);
  assert.equal(parseCrossOriginPolicies({
    'cross-origin-embedder-policy': 'unsafe-none',
    'cross-origin-opener-policy': 'unsafe-none',
    'cross-origin-resource-policy': 'cross-origin'
  }).coep.state, 'permissive');
  assert.equal(parseCrossOriginPolicies({
    'cross-origin-opener-policy': 'same-origin, unsafe-none'
  }).coop.state, 'invalid_or_conflicting');
});

test('security checks persist parser states, dynamic severity and score-capable root causes', () => {
  const fixture = setupRun('https://headers.invalid');
  addPage(fixture, {
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
    'permissions-policy': 'camera=(*)',
    'referrer-policy': 'unsafe-url',
    'x-content-type-options': 'invalid',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=300',
    'cross-origin-opener-policy': 'same-origin',
    server: 'fixture',
    'x-powered-by': 'fixture'
  });
  const csp = runCheck(fixture, 'tech.content_security_policy');
  assert.equal(csp.status, 'Warning');
  assert.equal(csp.priority, 'Medium');
  assert.equal(csp.evidence.logicVersion, HEADER_POLICY_VERSION);
  assert.equal(csp.evidence.samples[0].supportingEvidence.crossOriginPolicies.coop.effective, 'same-origin');
  assert.equal(csp.evidence.samples[0].supportingEvidence.serverHeaderPresent, true);
  assert.equal(csp.evidence.samples[0].supportingEvidence.poweredByHeaderPresent, true);
  assert.equal(csp.rootCauseFamily, 'security_headers.configuration');

  assert.equal(runCheck(fixture, 'tech.permissions_policy').priority, 'Medium');
  assert.equal(runCheck(fixture, 'tech.referrer_policy').priority, 'Low');
  assert.equal(runCheck(fixture, 'tech.x_content_type_options').status, 'Warning');
  assert.equal(runCheck(fixture, 'tech.x_frame_options').status, 'OK');
  assert.equal(runCheck(fixture, 'tech.hsts_header').status, 'Warning');
  fixture.db.close();
});

test('missing frame protection is Medium on a classified sensitive page', () => {
  const fixture = setupRun('https://sensitive.invalid');
  addPage(fixture, {}, { pageType: 'login' });
  const frame = runCheck(fixture, 'tech.x_frame_options');
  assert.equal(frame.status, 'Warning');
  assert.equal(frame.priority, 'Medium');
  assert.equal(frame.evidence.samples[0].policy.sensitivePage, true);
  fixture.db.close();
});

test('nosniff scope includes executable and stylesheet resource responses', () => {
  const fixture = setupRun('https://nosniff.invalid');
  addPage(fixture, { 'x-content-type-options': 'nosniff' });
  addResource(fixture, '/app.js', 'script', 'application/javascript', 12000, {
    'content-type': 'application/javascript'
  });
  addResource(fixture, '/site.css', 'stylesheet', 'text/css', 8000, {
    'content-type': 'text/css',
    'x-content-type-options': 'nosniff'
  });

  const result = runCheck(fixture, 'tech.x_content_type_options');
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 1);
  assert.equal(result.evidence.samples[0].url.endsWith('/app.js'), true);
  assert.equal(result.evidence.samples[0].evidenceSource, 'resource');
  assert.equal(result.rootCauseKey, 'security_headers.content_type_protection');
  fixture.db.close();
});

test('header checks never turn missing stored evidence into a pass', () => {
  const fixture = setupRun('https://incomplete.invalid');
  addPage(fixture, null);
  for (const id of [
    'tech.content_security_policy',
    'tech.permissions_policy',
    'tech.referrer_policy',
    'tech.x_content_type_options',
    'tech.x_frame_options',
    'tech.hsts_header'
  ]) {
    const result = runCheck(fixture, id);
    assert.equal(result.evaluationState, 'insufficient_evidence', id);
    assert.equal(result.scoreEligible, false, id);
  }
  fixture.db.close();
});

test('compression and cache checks use type, size and effective resource policy', () => {
  const fixture = setupRun('https://delivery.invalid');
  addPage(fixture, {
    'content-encoding': 'br',
    'cache-control': 'no-cache',
    etag: '"fixture"'
  }, { rawHtmlSize: 12000 });
  addResource(fixture, '/app.js', 'script', 'application/javascript', 80000, {
    'content-encoding': 'gzip',
    'cache-control': 'public, max-age=31536000, immutable'
  });
  addResource(fixture, '/bad.css', 'stylesheet', 'text/css', 50000, {
    'cache-control': 'no-store'
  });
  addResource(fixture, '/photo.jpg', 'image', 'image/jpeg', 90000, {
    'cache-control': 'public, max-age=31536000'
  });

  const compression = runCheck(fixture, 'tech.compression_header');
  assert.equal(compression.affectedCount, 1);
  assert.equal(compression.evidence.samples[0].url.endsWith('/bad.css'), true);
  const cache = runCheck(fixture, 'tech.cache_control_header');
  assert.equal(cache.status, 'Warning');
  assert.equal(cache.affectedCount, 1);
  assert.equal(cache.scoreDeduplicationKey, 'http_cache.configuration');
  const cachePerspective = runCheck(fixture, 'tech.cdn_cache_signals');
  assert.equal(cachePerspective.rootCauseKey, cache.rootCauseKey);
  fixture.db.close();
});

test('HTTP version check accepts only actual stored ALPN negotiation', () => {
  const fixture = setupRun('https://protocol.invalid');
  setProtocol(fixture, [{
    startUrl: 'https://protocol.invalid/',
    finalUrl: 'https://protocol.invalid/',
    finalHost: 'protocol.invalid',
    finalStatusCode: 200,
    finalHeaders: { 'alt-svc': 'h3=":443"' },
    tls: { state: 'connected', authorized: true, negotiatedProtocol: 'h2', tlsProtocol: 'TLSv1.3' }
  }]);
  assert.equal(runCheck(fixture, 'tech.http_version_support').status, 'OK');

  setProtocol(fixture, [{
    startUrl: 'https://protocol.invalid/',
    finalUrl: 'https://protocol.invalid/',
    finalHost: 'protocol.invalid',
    finalStatusCode: 200,
    tls: { state: 'connected', authorized: true, negotiatedProtocol: 'http/1.1', tlsProtocol: 'TLSv1.3' }
  }]);
  assert.equal(runCheck(fixture, 'tech.http_version_support').status, 'Warning');

  setProtocol(fixture, [{
    startUrl: 'https://protocol.invalid/',
    finalUrl: 'https://protocol.invalid/',
    finalHost: 'protocol.invalid',
    finalStatusCode: 200,
    featureFlagsJson: '{"httpVersion":"h2"}'
  }]);
  assert.equal(runCheck(fixture, 'tech.http_version_support').evaluationState, 'insufficient_evidence');
  fixture.db.close();
});

test('host checks use permanent direct redirects, canonical host, path/query preservation and configuration failures', () => {
  const fixture = setupRun('https://host.invalid');
  const tls = { state: 'connected', authorized: true, negotiatedProtocol: 'h2', tlsProtocol: 'TLSv1.3' };
  const passing = [
    hostCandidate('https://host.invalid/', 'https://host.invalid/', 200, [], { tls }),
    hostCandidate('https://www.host.invalid/', 'https://host.invalid/', 200, [308], { tls }),
    hostCandidate('http://host.invalid/', 'https://host.invalid/', 200, [308]),
    hostCandidate('http://www.host.invalid/', 'https://host.invalid/', 200, [301]),
    hostCandidate('http://host.invalid/article?q=1', 'https://host.invalid/article?q=1', 200, [308], { probeRole: 'representative_public_path' }),
    hostCandidate('http://www.host.invalid/article?q=1', 'https://host.invalid/article?q=1', 200, [308], { probeRole: 'representative_public_path' }),
    hostCandidate('https://www.host.invalid/article?q=1', 'https://host.invalid/article?q=1', 200, [308], { probeRole: 'representative_public_path' }),
    hostCandidate('https://host.invalid/article?q=1', 'https://host.invalid/article?q=1', 200, [], { probeRole: 'representative_public_path' })
  ];
  setProtocol(fixture, passing);
  setWww(fixture, passing, 'host.invalid');
  assert.equal(runCheck(fixture, 'tech.https_reachable').status, 'OK');
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').status, 'OK');
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').status, 'OK');

  const wrongQuery = hostCandidate('http://host.invalid/article?q=1', 'https://host.invalid/article', 200, [308], { probeRole: 'representative_public_path' });
  setProtocol(fixture, [passing[0], wrongQuery]);
  const redirectResult = runCheck(fixture, 'tech.http_to_https_redirect');
  assert.equal(redirectResult.status, 'Warning');
  assert.equal(redirectResult.evidence.pathOrQueryLoss, 1);

  const loop = hostCandidate('http://host.invalid/loop', 'http://host.invalid/loop', null, [301, 302], {
    probeRole: 'representative_public_path',
    loopDetected: true,
    errorType: 'redirect_loop'
  });
  setProtocol(fixture, [passing[0], loop]);
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').status, 'Warning');

  const certificateFailure = hostCandidate('https://host.invalid/', 'https://host.invalid/', null, [], {
    tls: {
      state: 'technical_error',
      errorClass: 'certificate_error',
      errorCode: 'CERT_HAS_EXPIRED',
      attempts: [
        { attempt: 1, errorClass: 'certificate_error', errorCode: 'CERT_HAS_EXPIRED' },
        { attempt: 2, errorClass: 'certificate_error', errorCode: 'CERT_HAS_EXPIRED' }
      ]
    },
    attempts: [
      { attempt: 1, errorType: 'certificate_error', error: 'expired' },
      { attempt: 2, errorType: 'certificate_error', error: 'expired' }
    ]
  });
  setProtocol(fixture, [certificateFailure]);
  assert.equal(runCheck(fixture, 'tech.https_reachable').status, 'Error');
  fixture.db.close();
});

test('host configuration cannot pass globally when known deep public paths were not probed', () => {
  const fixture = setupRun('https://coverage.invalid');
  addPage(fixture, {}, { url: 'https://coverage.invalid/article' });
  const tls = { state: 'connected', authorized: true, negotiatedProtocol: 'h2', tlsProtocol: 'TLSv1.3' };
  const roots = [
    hostCandidate('https://coverage.invalid/', 'https://coverage.invalid/', 200, [], { tls }),
    hostCandidate('https://www.coverage.invalid/', 'https://coverage.invalid/', 200, [308], { tls }),
    hostCandidate('http://coverage.invalid/', 'https://coverage.invalid/', 200, [308]),
    hostCandidate('http://www.coverage.invalid/', 'https://coverage.invalid/', 200, [308])
  ];
  setProtocol(fixture, roots);
  setWww(fixture, roots, 'coverage.invalid');
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').evaluationState, 'insufficient_evidence');
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').evaluationState, 'insufficient_evidence');
  fixture.db.close();
});

test('redirect-chain collection distinguishes loops from transport errors and retains hop headers', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/a') return response.writeHead(301, { location: '/b', 'x-frame-options': 'DENY' }).end();
    if (request.url === '/b') return response.writeHead(302, { location: '/a' }).end();
    return response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await followRedirectChain(`http://127.0.0.1:${server.address().port}/a`);
    assert.equal(result.errorType, 'redirect_loop');
    assert.equal(result.loopDetected, true);
    assert.equal(result.chain.length, 2);
    assert.equal(result.chain[0].headers['x-frame-options'], 'DENY');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function setupRun(domain) {
  const db = new Database(':memory:');
  initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  db.prepare('UPDATE projects SET finalDomain=?, protocolBehaviorJson=?, wwwBehaviorJson=? WHERE id=?')
    .run(domain, '[]', '{}', projectId);
  const config = normalizeAuditConfig({
    domain,
    auditType: 'tech',
    maxUrls: 20,
    maxDepth: 0,
    usePlaywright: false,
    storeResponseHeaders: true,
    storeAllResources: true
  });
  const runId = createRun(db, projectId, config);
  return { db, projectId, runId, domain };
}

function addPage(fixture, headers, options = {}) {
  const url = options.url || `${fixture.domain.replace(/\/$/, '')}/`;
  fixture.db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,
      redirectChainJson,httpAttemptHistoryJson,contentType,indexable,title,h1Json,h1Count,
      pageType,responseHeadersJson,rawHtmlSize
    ) VALUES (?,?,?,?,0,200,200,'[]','[]','text/html; charset=utf-8',1,'Fixture','["Fixture"]',1,'other',?,?)
  `).run(
    fixture.runId,
    url,
    url,
    url,
    headers === null ? null : JSON.stringify(headers),
    options.rawHtmlSize ?? 12000
  );
  if (options.pageType) {
    fixture.db.prepare('UPDATE pages SET pageType=? WHERE runId=? AND url=?')
      .run(options.pageType, fixture.runId, url);
  }
}

function addResource(fixture, path, resourceType, contentType, sizeBytes, headers) {
  const pageUrl = `${fixture.domain.replace(/\/$/, '')}/`;
  const resourceUrl = new URL(path, fixture.domain).toString();
  fixture.db.prepare(`
    INSERT INTO resources (
      runId,pageUrl,resourceUrl,resourceType,statusCode,sizeBytes,sizeMeasurementKind,
      contentType,isThirdParty,responseHeadersJson
    ) VALUES (?,?,?,?,200,?,'decoded_body_bytes',?,0,?)
  `).run(fixture.runId, pageUrl, resourceUrl, resourceType, sizeBytes, contentType, JSON.stringify(headers));
}

function setProtocol(fixture, candidates) {
  fixture.db.prepare('UPDATE projects SET protocolBehaviorJson=? WHERE id=?')
    .run(JSON.stringify(candidates), fixture.projectId);
}

function setWww(fixture, candidates, selectedHost) {
  fixture.db.prepare('UPDATE projects SET wwwBehaviorJson=? WHERE id=?')
    .run(JSON.stringify({ selectedHost, candidates }), fixture.projectId);
}

function hostCandidate(startUrl, finalUrl, finalStatusCode, redirectStatuses = [], overrides = {}) {
  const start = new URL(startUrl);
  const final = new URL(finalUrl);
  const redirectChain = redirectStatuses.map((statusCode, index) => ({
    url: index ? finalUrl : startUrl,
    statusCode,
    location: finalUrl
  }));
  return {
    startUrl,
    startHost: start.hostname,
    finalUrl,
    finalHost: final.hostname,
    statusCode: finalStatusCode,
    finalStatusCode,
    initialStatusCode: redirectStatuses[0] ?? finalStatusCode,
    redirectChain,
    redirectStatuses,
    redirectsToHttps: final.protocol === 'https:',
    pathPreserved: start.pathname === final.pathname,
    queryPreserved: start.search === final.search,
    ...overrides
  };
}

function runCheck(fixture, id) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}
