import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, hydrateInternalLinkHttpFacts, insertCheckResults } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import { classifyHostRelation, classifyHttpStability } from '../src/utils/httpStatus.js';
import { originCandidates } from '../src/utils/url.js';
import { classifyProbe, probeUrl } from '../src/checks/http/notFoundCheck.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectCheckDetailCsv, collectFullAuditJson } from '../src/results/checkExportService.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { fetchWithTimeout, followRedirectChain } from '../src/utils/http.js';
import { processQueueItem } from '../src/crawler/pageProcessor.js';
import { appendHttpAttempt, claimNextUrl, enqueueUrl } from '../src/queue/sqliteQueue.js';

test('HTTP stability keeps deterministic, transient, confirmed and technical outcomes separate', () => {
  assert.equal(classifyHttpStability([{ attempt: 1, finalStatus: 404 }]).status, 'confirmed');
  assert.equal(classifyHttpStability([{ attempt: 1, finalStatus: 503 }]).status, 'insufficient_evidence');
  assert.equal(classifyHttpStability([{ attempt: 1, finalStatus: 503 }, { attempt: 2, finalStatus: 503 }]).status, 'confirmed');
  assert.equal(classifyHttpStability([{ attempt: 1, finalStatusCode: 503 }, { attempt: 2, finalStatusCode: 503 }]).status, 'confirmed');
  assert.equal(classifyHttpStability([{ attempt: 1, finalStatus: 503 }, { attempt: 2, finalStatus: 200 }]).status, 'transient');
  assert.equal(classifyHttpStability([{ attempt: 1, technicalErrorType: 'timeout', technicalError: 'timed out' }]).status, 'technical_error');
  assert.equal(classifyHostRelation('www.example.co.uk', 'example.co.uk'), 'www_variant');
  assert.equal(classifyHostRelation('docs.example.co.uk', 'example.co.uk'), 'subdomain');
  assert.equal(classifyHostRelation('example.co.uk', 'example.com'), 'different_registrable_domain');
});

test('origin candidates create www only for a registrable Apex, never for a genuine subdomain', () => {
  assert.deepEqual(originCandidates('example.com'), [
    'https://example.com', 'https://www.example.com', 'http://example.com', 'http://www.example.com'
  ]);
  assert.deepEqual(originCandidates('app.example.com'), ['https://app.example.com', 'http://app.example.com']);
  assert.deepEqual(originCandidates('localhost:8080'), ['https://localhost:8080', 'http://localhost:8080']);
});

test('GET is authoritative when HEAD is rejected and a 5xx still proves HTTP transport reachability', async () => {
  const methods = [];
  const server = http.createServer((request, response) => {
    methods.push(request.method);
    if (request.method === 'HEAD') return response.writeHead(405).end();
    if (request.url === '/server') return response.writeHead(503, { 'content-type': 'text/plain' }).end('unavailable');
    return response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>ok</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const head = await fetchWithTimeout(`${origin}/`, { method: 'HEAD', redirect: 'manual' });
    const get = await followRedirectChain(`${origin}/`);
    const serverError = await followRedirectChain(`${origin}/server`);
    assert.equal(head.statusCode, 405);
    assert.equal(get.statusCode, 200);
    assert.equal(get.ok, true);
    assert.equal(serverError.statusCode, 503);
    assert.equal(serverError.ok, true);
    assert.deepEqual(methods, ['HEAD', 'GET', 'GET']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('5xx requires reproducibility while deterministic 4xx and redirect inventory remain distinct', () => {
  const fixture = setupRun('https://status.invalid');
  addPage(fixture, '/stable-500', 500, attempts(500, 500));
  addPage(fixture, '/not-found', 404, attempts(404));
  addPage(fixture, '/rate-limited', 429, attempts(429));
  addPage(fixture, '/alias', 200, attempts(200), { initialStatusCode: 308, finalUrl: 'https://status.invalid/final', redirectChain: [{ url: 'https://status.invalid/alias', statusCode: 308, location: 'https://status.invalid/final' }] });
  assert.equal(runCheck(fixture, 'tech.5xx_pages').status, 'Error');
  assert.equal(runCheck(fixture, 'tech.5xx_pages').affectedCount, 1);
  assert.equal(runCheck(fixture, 'tech.4xx_pages').affectedCount, 1);
  const redirects = runCheck(fixture, 'tech.redirect_pages');
  assert.equal(redirects.status, 'OK');
  assert.equal(redirects.affectedCount, 1);
  assert.equal(redirects.scoreEligible, false);
  fixture.db.close();

  const uncertain = setupRun('https://uncertain.invalid');
  addPage(uncertain, '/one-shot-503', 503, attempts(503));
  const result = runCheck(uncertain, 'tech.5xx_pages');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  uncertain.db.close();

  const rateLimited = setupRun('https://rate.invalid');
  addPage(rateLimited, '/limited', 429, attempts(429, 429));
  const rateResult = runCheck(rateLimited, 'tech.4xx_pages');
  assert.equal(rateResult.evaluationState, 'insufficient_evidence');
  assert.equal(rateResult.scoreEligible, false);
  rateLimited.db.close();
});

test('crawler persists retryable 5xx attempts before throwing so a repeated server failure remains auditable', async () => {
  const server = http.createServer((_request, response) => response.writeHead(503, { 'content-type': 'text/html' }).end('<h1>Unavailable</h1>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = setupRun(origin);
  enqueueUrl(fixture.db, { runId: fixture.runId, url: `${origin}/server`, sourceType: 'seed' });
  try {
    for (let expectedAttempt = 1; expectedAttempt <= 2; expectedAttempt += 1) {
      const item = claimNextUrl(fixture.db, fixture.runId);
      assert.equal(item.attempts, expectedAttempt);
      await assert.rejects(async () => {
        try {
          await processQueueItem(fixture.db, getRunWithProject(fixture.db, fixture.runId), getRunWithProject(fixture.db, fixture.runId), item, null, null);
        } catch (error) {
          appendHttpAttempt(fixture.db, item.id, error.httpAttempt);
          throw error;
        }
      }, /Retryable HTTP status 503/);
      if (expectedAttempt === 1) fixture.db.prepare("UPDATE crawl_queue SET status='pending' WHERE id=?").run(item.id);
    }
    const page = fixture.db.prepare('SELECT statusCode,httpAttemptHistoryJson FROM pages WHERE runId=?').get(fixture.runId);
    assert.equal(page.statusCode, 503);
    assert.equal(JSON.parse(page.httpAttemptHistoryJson).length, 2);
    assert.equal(runCheck(fixture, 'tech.5xx_pages').status, 'Error');
  } finally {
    fixture.db.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('internal link checks count occurrences and unique targets without hiding redirects or admitting assets/external targets', () => {
  const fixture = setupRun('https://links.invalid');
  addPage(fixture, '/source', 200, attempts(200));
  addPage(fixture, '/redirect', 200, attempts(200), { initialStatusCode: 308, finalUrl: 'https://links.invalid/final', redirectChain: [{ url: 'https://links.invalid/redirect', statusCode: 308, location: 'https://links.invalid/final' }] });
  addPage(fixture, '/final', 200, attempts(200));
  addPage(fixture, '/broken', 404, attempts(404));
  addPage(fixture, '/server', 503, attempts(503, 503));
  addPage(fixture, '/asset.png', 404, attempts(404), { contentType: 'image/png' });
  addLink(fixture, '/source', '/redirect#section', 'internal');
  addLink(fixture, '/source', '/broken', 'internal');
  addLink(fixture, '/source', '/broken', 'internal');
  addLink(fixture, '/source', '/server', 'internal');
  addLink(fixture, '/source', '/asset.png', 'internal');
  addLink(fixture, '/source', 'https://outside.invalid/broken', 'external');
  hydrateInternalLinkHttpFacts(fixture.db, fixture.runId);

  const redirects = runCheck(fixture, 'tech.internal_links_to_3xx');
  assert.equal(redirects.affectedCount, 1);
  assert.equal(redirects.evidence.samples[0].initial_status, 308);
  const broken = runCheck(fixture, 'tech.internal_links_to_4xx_5xx');
  assert.equal(broken.affectedCount, 3);
  assert.equal(broken.facts.uniqueTargets, 2);
  assert.equal(broken.priority, 'Medium');
  assert.equal(broken.evidence.excludedNonPageTargets, 1);
  fixture.db.close();
});

test('missing internal target measurement is not a silent pass and run scope remains isolated', () => {
  const a = setupRun('https://a.invalid');
  const b = setupRun('https://b.invalid', a.db);
  addPage(a, '/source', 200, attempts(200));
  addLink(a, '/source', '/missing', 'internal');
  addPage(b, '/missing', 404, attempts(404));
  const result = runCheck(a, 'tech.internal_links_to_4xx_5xx');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.affectedCount, 0);
  assert.equal(JSON.stringify(result.evidence).includes('b.invalid'), false);
  a.db.close();

  const limited = setupRun('https://limited.invalid');
  addPage(limited, '/source', 200, attempts(200));
  addPage(limited, '/target', 429, attempts(429, 429));
  addLink(limited, '/source', '/target', 'internal');
  hydrateInternalLinkHttpFacts(limited.db, limited.runId);
  assert.equal(runCheck(limited, 'tech.internal_links_to_4xx_5xx').evaluationState, 'insufficient_evidence');
  limited.db.close();
});

test('HTTP/HTTPS and Apex/www checks use GET response, permanence and final host separately', () => {
  const fixture = setupRun('https://example.com');
  setDomainEvidence(fixture, {
    protocol: [
      candidate('https://example.com', 500, 'https://example.com'),
      candidate('https://www.example.com', 308, 'https://example.com', [308]),
      candidate('http://example.com', 301, 'https://example.com', [301]),
      candidate('http://www.example.com', 308, 'https://example.com', [308])
    ],
    www: [
      candidate('https://example.com', 200, 'https://example.com'),
      candidate('https://www.example.com', 308, 'https://example.com', [308])
    ],
    selectedHost: 'example.com'
  });
  assert.equal(runCheck(fixture, 'tech.https_reachable').status, 'OK');
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').status, 'OK');
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').status, 'OK');

  const temporary = candidate('http://example.com', 302, 'https://example.com', [302]);
  fixture.db.prepare('UPDATE projects SET protocolBehaviorJson=? WHERE id=?').run(JSON.stringify([temporary]), fixture.projectId);
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').status, 'Warning');

  const limited = candidate('http://example.com', 429, 'http://example.com');
  fixture.db.prepare('UPDATE projects SET protocolBehaviorJson=? WHERE id=?').run(JSON.stringify([limited]), fixture.projectId);
  assert.equal(runCheck(fixture, 'tech.http_to_https_redirect').evaluationState, 'technical_error');

  const unavailableHost = [candidate('https://example.com', 200, 'https://example.com'), candidate('https://www.example.com', 503, 'https://www.example.com')];
  fixture.db.prepare('UPDATE projects SET wwwBehaviorJson=? WHERE id=?').run(JSON.stringify({ selectedHost: 'example.com', candidates: unavailableHost }), fixture.projectId);
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').evaluationState, 'technical_error');

  const split = [candidate('https://example.com', 200, 'https://example.com'), candidate('https://www.example.com', 200, 'https://www.example.com')];
  fixture.db.prepare('UPDATE projects SET wwwBehaviorJson=? WHERE id=?').run(JSON.stringify({ selectedHost: 'example.com', candidates: split }), fixture.projectId);
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').status, 'Warning');
  fixture.db.close();
});

test('a genuine subdomain has no fabricated www consistency requirement', () => {
  const fixture = setupRun('https://app.example.com');
  setDomainEvidence(fixture, {
    protocol: [candidate('https://app.example.com', 200, 'https://app.example.com')],
    www: [candidate('https://app.example.com', 200, 'https://app.example.com')],
    selectedHost: 'app.example.com'
  });
  assert.equal(runCheck(fixture, 'tech.www_non_www_consistency').evaluationState, 'not_applicable');
  fixture.db.close();
});

test('sitemap URLs use authored initial status and missing measurement does not pass', () => {
  const fixture = setupRun('https://sitemap.invalid');
  addPage(fixture, '/direct', 200, attempts(200));
  addQueue(fixture, '/direct', 'sitemap', 'done');
  assert.equal(runCheck(fixture, 'tech.sitemap_urls_non_200').status, 'OK');
  addPage(fixture, '/alias', 200, attempts(200), { initialStatusCode: 301, finalUrl: 'https://sitemap.invalid/final', redirectChain: [{ statusCode: 301, url: 'https://sitemap.invalid/alias', location: 'https://sitemap.invalid/final' }] });
  addQueue(fixture, '/alias', 'sitemap', 'done');
  assert.equal(runCheck(fixture, 'tech.sitemap_urls_non_200').affectedCount, 1);
  addQueue(fixture, '/not-measured', 'sitemap', 'failed');
  const partial = runCheck(fixture, 'tech.sitemap_urls_non_200');
  assert.equal(partial.status, 'Warning');
  assert.equal(partial.requirements.missingFacts.includes('completeSitemapUrlStatusCoverage'), true);
  fixture.db.close();

  const limited = setupRun('https://sitemap-limited.invalid');
  addPage(limited, '/limited', 429, attempts(429, 429));
  addQueue(limited, '/limited', 'sitemap', 'done');
  assert.equal(runCheck(limited, 'tech.sitemap_urls_non_200').evaluationState, 'insufficient_evidence');
  limited.db.close();
});

test('HTTP evidence stays aligned across detail, CSV, JSON and HTML report', () => {
  const fixture = setupRun('https://parity.invalid');
  addPage(fixture, '/source', 200, attempts(200));
  addPage(fixture, '/broken', 404, attempts(404));
  addLink(fixture, '/source', '/broken', 'internal');
  hydrateInternalLinkHttpFacts(fixture.db, fixture.runId);
  const result = runCheck(fixture, 'tech.internal_links_to_4xx_5xx');
  insertCheckResults(fixture.db, fixture.runId, [result]);
  const stored = fixture.db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.internal_links_to_4xx_5xx'").get(fixture.runId);
  const detail = getCheckDetail(fixture.db, fixture.runId, stored.id);
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.rows[0].finalStatusCode, 404);
  assert.equal(detail.rows[0].measurementStability, 'confirmed');
  const csv = collectCheckDetailCsv(fixture.db, fixture.runId, stored.id).csv;
  assert.match(csv, /Measurement Stability/);
  assert.match(csv, /Normalized Target/);
  const json = JSON.parse(collectFullAuditJson(fixture.db, fixture.runId, ['findings', 'links']).body);
  const exported = json.checkDetails.find((item) => item.checkId === 'tech.internal_links_to_4xx_5xx');
  assert.equal(exported.rows[0].finalStatusCode, 404);
  const reportPath = generateReport(fixture.db, fixture.runId);
  const report = fs.readFileSync(reportPath, 'utf8');
  assert.match(report, /Internal links to 4xx\/5xx/);
  fs.rmSync(reportPath, { force: true });
  fixture.db.close();
});

test('synthetic unknown-URL probe retries bounded transient 503 and confirms persistent 503', async () => {
  let transientCalls = 0;
  const transient = await probeUrl('https://fixture.invalid/missing', async () => {
    transientCalls += 1;
    return response(transientCalls === 1 ? 503 : 404);
  });
  assert.equal(transientCalls, 2);
  assert.equal(transient.statusCode, 404);
  assert.equal(transient.measurementStability, 'transient');
  assert.equal(classifyProbe(transient, responseFingerprint(), 'https://fixture.invalid').outcome, 'pass');

  const persistent = await probeUrl('https://fixture.invalid/missing', async () => response(503));
  assert.equal(persistent.measurementAttempts.length, 2);
  assert.equal(persistent.measurementStability, 'confirmed');
  assert.equal(classifyProbe(persistent, responseFingerprint(), 'https://fixture.invalid').outcome, 'fail');
});

test('additive migration keeps legacy databases readable and adds compact attempt columns', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  db.exec('ALTER TABLE pages DROP COLUMN httpAttemptHistoryJson; ALTER TABLE crawl_queue DROP COLUMN httpAttemptHistoryJson;');
  initDatabase(db);
  assert.ok(db.prepare("PRAGMA table_info(pages)").all().some((row) => row.name === 'httpAttemptHistoryJson'));
  assert.ok(db.prepare("PRAGMA table_info(crawl_queue)").all().some((row) => row.name === 'httpAttemptHistoryJson'));
  db.close();
});

function setupRun(domain, existingDb = null) {
  const db = existingDb || new Database(':memory:');
  if (!existingDb) initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run(domain, projectId);
  const runId = createRun(db, projectId, normalizeAuditConfig({ domain, auditType: 'tech', maxUrls: 100, maxDepth: 0, usePlaywright: false, storeAllLinks: true }));
  return { db, projectId, runId, domain };
}

function addPage(fixture, path, statusCode, history, options = {}) {
  const url = new URL(path, fixture.domain).toString();
  const normalizedUrl = options.normalizedUrl || url.replace(/#.*$/, '').replace(/\/$/, '') || url;
  fixture.db.prepare(`
    INSERT INTO pages (runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,redirectChainJson,httpAttemptHistoryJson,contentType,indexable,title,h1Json,h1Count,pageType)
    VALUES (?,?,?,?,0,?,?,?,?,?,1,'Fixture','["Fixture"]',1,'other')
  `).run(fixture.runId, url, normalizedUrl, options.finalUrl || url, statusCode, options.initialStatusCode ?? statusCode, JSON.stringify(options.redirectChain || []), JSON.stringify(history), options.contentType || 'text/html; charset=utf-8');
  return { url, normalizedUrl };
}

function addQueue(fixture, path, sourceType, status) {
  const url = new URL(path, fixture.domain).toString();
  fixture.db.prepare('INSERT OR IGNORE INTO crawl_queue (runId,url,normalizedUrl,depth,sourceType,status,priority,attempts) VALUES (?,?,?,0,?,?,0,1)').run(fixture.runId, url, url, sourceType, status);
}

function addLink(fixture, sourcePath, target, linkType, forcedNormalized = null) {
  const sourceUrl = new URL(sourcePath, fixture.domain).toString();
  const linkedUrl = new URL(target, fixture.domain).toString();
  const normalizedTarget = forcedNormalized || linkedUrl.replace(/#.*$/, '');
  fixture.db.prepare('INSERT INTO page_links (runId,sourceUrl,targetUrl,linkedUrl,normalizedTargetUrl,linkType,anchorText) VALUES (?,?,?,?,?,?,?)').run(fixture.runId, sourceUrl, linkedUrl, linkedUrl, normalizedTarget, linkType, 'Fixture');
}

function attempts(...statuses) {
  return statuses.map((status, index) => ({ attempt: index + 1, method: 'GET', initialStatus: status, finalStatus: status }));
}

function runCheck(fixture, id) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}

function candidate(startUrl, initialStatusCode, finalUrl, redirectStatuses = []) {
  const start = new URL(startUrl);
  const final = new URL(finalUrl);
  const redirectChain = redirectStatuses.map((statusCode) => ({ url: startUrl, statusCode, location: finalUrl }));
  return {
    startUrl, startHost: start.hostname, finalUrl, finalHost: final.hostname,
    statusCode: redirectStatuses.length ? 200 : initialStatusCode,
    finalStatusCode: redirectStatuses.length ? 200 : initialStatusCode,
    initialStatusCode, redirectChain, redirectStatuses,
    redirectsToHttps: final.protocol === 'https:',
    permanentRedirect: redirectStatuses.length > 0 && redirectStatuses.every((status) => [301, 308].includes(status)),
    pathPreserved: start.pathname === final.pathname,
    queryPreserved: start.search === final.search,
    hostRelation: classifyHostRelation(start.hostname, final.hostname)
  };
}

function setDomainEvidence(fixture, input) {
  fixture.db.prepare('UPDATE projects SET protocolBehaviorJson=?, wwwBehaviorJson=? WHERE id=?').run(
    JSON.stringify(input.protocol), JSON.stringify({ selectedHost: input.selectedHost, candidates: input.www }), fixture.projectId
  );
}

function response(statusCode) {
  return { statusCode, headers: {}, body: '<html><title>Missing</title></html>', contentType: 'text/html', sizeBytes: 36 };
}

function responseFingerprint() {
  return { fingerprint: { title: 'Home', visibleTextHash: 'home', bodySha256: 'home', structuralHash: 'home', excerpt: 'home' } };
}
