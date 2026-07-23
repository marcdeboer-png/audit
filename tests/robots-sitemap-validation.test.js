import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, insertCheckResults, insertDomainAsset } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { discoverDomainAssets } from '../src/crawler/sitemap.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import {
  analyzeRobotsAsset,
  extractSitemapDirectives,
  parseSitemapDocument
} from '../src/utils/discoverySemantics.js';
import { parseRobots, summarizeAiBotRules } from '../src/utils/robots.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectCheckDetailCsv, collectFullAuditJson } from '../src/results/checkExportService.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { fetchWithTimeout } from '../src/utils/http.js';

test('robots discovery distinguishes valid, empty, absent, HTML and technical states', () => {
  assert.equal(analyzeRobotsAsset(asset(200, 'User-agent: *\nDisallow: /private')).state, 'valid');
  assert.equal(analyzeRobotsAsset(asset(200, '')).state, 'valid_empty');
  assert.deepEqual(
    [404, 410, 401, 403].map((statusCode) => analyzeRobotsAsset(asset(statusCode, '<html>missing</html>')).state),
    ['absent', 'absent', 'access_restricted', 'access_restricted']
  );
  assert.equal(analyzeRobotsAsset(asset(200, '<!doctype html><html>fallback</html>', 'text/html')).state, 'invalid_html_representation');
  assert.equal(analyzeRobotsAsset(asset(503, 'unavailable')).state, 'temporarily_unreachable');
  assert.equal(analyzeRobotsAsset({ url: 'https://fixture.invalid/robots.txt', statusCode: null, content: '', responseHeadersJson: '{"error":"timeout"}' }).state, 'technical_error');
});

test('robots directives handle comments, whitespace, multiple sitemaps and reject relative locations', () => {
  const directives = extractSitemapDirectives([
    '\ufeffUser-agent: *',
    'Disallow:',
    'Sitemap: https://example.com/one.xml # primary',
    ' sitemap : https://example.com/two.xml ',
    'Sitemap: /relative.xml',
    'Sitemap: https://example.com/one.xml'
  ].join('\n'), 'https://example.com/robots.txt');
  assert.equal(directives.length, 3);
  assert.deepEqual(directives.map((row) => row.valid), [true, true, false]);
  assert.equal(directives[0].sameHost, true);

  const parser = parseRobots('https://example.com/robots.txt', 'User-agent: *\nDisallow: /private/*\nAllow: /private/public$');
  assert.equal(parser.isAllowed('https://example.com/private/file', '*'), false);
  assert.equal(parser.isAllowed('https://example.com/private/public', '*'), true);
  const policies = summarizeAiBotRules('https://example.com/robots.txt', 'User-agent: *\nAllow: /');
  assert.ok(policies.every((row) => row.status === 'implicitly_allowed' && row.inheritedWildcard));
});

test('sitemap parser accepts urlset, index, namespace, BOM, entities and gzip while rejecting invalid or HTML roots', () => {
  const urlset = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a?x=1&amp;y=2</loc></url><url><loc>https://example.com/a?x=1&amp;y=2</loc></url></urlset>';
  const parsed = parseSitemapDocument(`\ufeff${urlset}`);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.documentType, 'urlset');
  assert.equal(parsed.locationCount, 2);
  assert.equal(parsed.uniqueLocationCount, 1);
  assert.equal(parsed.locations[0], 'https://example.com/a?x=1&y=2');

  const index = parseSitemapDocument('<sitemapindex><sitemap><loc>https://example.com/a.xml.gz</loc></sitemap></sitemapindex>');
  assert.equal(index.documentType, 'sitemapindex');
  assert.equal(index.locations.length, 1);
  assert.equal(parseSitemapDocument(zlib.gzipSync(urlset), { url: 'https://example.com/sitemap.xml.gz' }).valid, true);
  assert.equal(parseSitemapDocument(zlib.gzipSync(urlset), { maxUncompressedBytes: 64 }).parseError, 'uncompressed_size_limit_exceeded');
  const empty = parseSitemapDocument('<urlset/>');
  assert.equal(empty.valid, true);
  assert.equal(empty.locationCount, 0);
  const overProtocolLimit = parseSitemapDocument(`<urlset>${Array.from({ length: 50_001 }, (_, index) => `<url><loc>https://example.com/${index}</loc></url>`).join('')}</urlset>`);
  assert.equal(overProtocolLimit.protocolLimitExceeded, true);
  assert.equal(parseSitemapDocument('<urlset><url></urlset>').valid, false);
  assert.equal(parseSitemapDocument('<html><loc>https://example.com/not-a-sitemap</loc></html>').documentType, 'html');
  assert.equal(parseSitemapDocument('<!DOCTYPE urlset><urlset/>').parseError, 'doctype_not_allowed');
});

test('crawler validates document roots, traverses indexes, prevents cycles and records deterministic coverage limits', async () => {
  await withServer({
    '/robots.txt': text(200, 'User-agent: *\nSitemap: __ORIGIN__/index.xml'),
    '/sitemap.xml': text(404, 'missing'),
    '/index.xml': xml(200, '<sitemapindex><sitemap><loc>__ORIGIN__/a.xml</loc></sitemap><sitemap><loc>__ORIGIN__/loop.xml</loc></sitemap></sitemapindex>'),
    '/a.xml': xml(200, '<urlset><url><loc>__ORIGIN__/a</loc></url><url><loc>__ORIGIN__/a</loc></url><url><loc>__ORIGIN__/b</loc></url></urlset>'),
    '/loop.xml': xml(200, '<sitemapindex><sitemap><loc>__ORIGIN__/index.xml</loc></sitemap></sitemapindex>')
  }, async ({ origin }) => {
    const fixture = setupRun(origin, { maxSitemapUrls: 1, maxSitemaps: 10 });
    const robots = await fetch(`${origin}/robots.txt`).then((response) => response.text());
    const summary = await discoverDomainAssets(fixture.db, getRunWithProject(fixture.db, fixture.runId), `${origin}/`, robots);
    assert.equal(summary.validFiles, 3);
    assert.equal(summary.cyclesDetected, 1);
    assert.equal(summary.totalListedUrls, 3);
    assert.equal(summary.uniqueListedUrls, 2);
    assert.equal(summary.duplicateListedUrls, 1);
    assert.equal(summary.plannedSitemapUrls, 1);
    assert.equal(summary.queuedSitemapUrls, 1);
    assert.ok(summary.limitReasons.includes('maximum_sitemap_urls'));
    assert.equal(summary.discoveryComplete, false);
    const stored = getRunWithProject(fixture.db, fixture.runId);
    assert.deepEqual(JSON.parse(stored.sitemapDiscoveryJson), summary);
    fixture.db.close();
  });
});

test('sitemap file budget counts failed fetch attempts and stops before unbounded child retries', async () => {
  await withServer({
    '/robots.txt': text(200, 'User-agent: *\nSitemap: __ORIGIN__/index.xml'),
    '/index.xml': xml(200, [
      '<sitemapindex>',
      '<sitemap><loc>http://127.0.0.1:1/one.xml</loc></sitemap>',
      '<sitemap><loc>http://127.0.0.1:1/two.xml</loc></sitemap>',
      '<sitemap><loc>http://127.0.0.1:1/three.xml</loc></sitemap>',
      '</sitemapindex>'
    ].join(''))
  }, async ({ origin }) => {
    const fixture = setupRun(origin, { maxSitemaps: 3, requestTimeoutMs: 100 });
    const robots = await fetch(`${origin}/robots.txt`).then((response) => response.text());
    const summary = await discoverDomainAssets(fixture.db, getRunWithProject(fixture.db, fixture.runId), `${origin}/`, robots);
    assert.equal(summary.filesAttempted, 3);
    assert.equal(summary.filesProcessed, 1);
    assert.equal(summary.failedFiles, 2);
    assert.ok(summary.limitReasons.includes('maximum_sitemap_files'));
    assert.equal(summary.discoveryComplete, false);
    const attemptedChildren = fixture.db.prepare("SELECT COUNT(*) AS count FROM domain_assets WHERE runId=? AND url LIKE 'http://127.0.0.1:1/%'").get(fixture.runId).count;
    assert.equal(attemptedChildren, 2);
    fixture.db.close();
  });
});

test('crawler rejects HTML soft sitemaps and exposes child fetch failures without queueing loc-like HTML', async () => {
  await withServer({
    '/robots.txt': text(200, 'User-agent: *\nSitemap: __ORIGIN__/index.xml'),
    '/sitemap.xml': text(404, 'missing'),
    '/index.xml': xml(200, '<sitemapindex><sitemap><loc>__ORIGIN__/child.xml</loc></sitemap></sitemapindex>'),
    '/child.xml': text(500, '<html><loc>__ORIGIN__/must-not-queue</loc></html>', 'text/html')
  }, async ({ origin }) => {
    const fixture = setupRun(origin);
    const robots = await fetch(`${origin}/robots.txt`).then((response) => response.text());
    const summary = await discoverDomainAssets(fixture.db, getRunWithProject(fixture.db, fixture.runId), `${origin}/`, robots);
    assert.equal(summary.failedFiles, 1);
    assert.equal(summary.discoveryComplete, false);
    assert.equal(summary.queuedSitemapUrls, 0);
    const child = fixture.db.prepare("SELECT metadataJson FROM domain_assets WHERE runId=? AND url LIKE '%child.xml'").get(fixture.runId);
    assert.equal(JSON.parse(child.metadataJson).sitemap.valid, false);
    fixture.db.close();
  });
});

test('bounded sitemap-style fetch cancels retention beyond the configured response limit', async () => {
  await withServer({ '/large.xml': xml(200, 'x'.repeat(4096)) }, async ({ origin }) => {
    const response = await fetchWithTimeout(`${origin}/large.xml`, { maxBytes: 128, abortOnMaxBytes: true });
    assert.equal(response.truncated, true);
    assert.equal(response.buffer.length, 128);
    assert.ok(response.sizeBytes > 128);
  });
});

test('robots and sitemap checks make absence optional, invalid representations actionable and technical failures score-free', () => {
  const absent = setupRun('https://absent.invalid');
  insertDomainAsset(absent.db, assetRow(absent.runId, 'robots', 404, '<html>missing</html>', { contentType: 'text/html' }));
  insertDomainAsset(absent.db, assetRow(absent.runId, 'sitemap', 404, '<html>missing</html>', { sourceType: 'sitemap', contentType: 'text/html', sitemap: { valid: false, documentType: 'unavailable' } }));
  const robotsAbsent = runCheck(absent, 'tech.robots_txt_present');
  assert.equal(robotsAbsent.status, 'OK');
  assert.equal(robotsAbsent.scoreEligible, false);
  const noSitemap = runCheck(absent, 'tech.sitemap_present');
  assert.equal(noSitemap.status, 'Warning');
  assert.equal(noSitemap.priority, 'Low');
  assert.equal(noSitemap.scoreEligible, false);
  assert.equal(runCheck(absent, 'tech.sitemap_in_robots').evaluationState, 'not_applicable');
  assert.equal(runGeoCheck(absent, 'geo.robots_blocks_txt_files').status, 'OK');
  assert.equal(runGeoCheck(absent, 'geo.ai_bots_policy_summary').status, 'OK');
  assert.equal(runGeoCheck(absent, 'geo.robots_mentions_gptbot').priority, 'Low');
  absent.db.close();

  const invalid = setupRun('https://invalid.invalid');
  insertDomainAsset(invalid.db, assetRow(invalid.runId, 'robots', 200, '<html>fallback</html>', { contentType: 'text/html' }));
  insertDomainAsset(invalid.db, assetRow(invalid.runId, 'sitemap', 200, '<html><loc>https://invalid.invalid/a</loc></html>', { sourceType: 'robots_sitemap', sitemap: { valid: false, documentType: 'html', parseError: 'unsupported_root:html' } }));
  assert.equal(runCheck(invalid, 'tech.robots_txt_present').status, 'Warning');
  assert.equal(runCheck(invalid, 'tech.sitemap_present').status, 'Warning');
  invalid.db.close();

  const mixed = setupRun('https://mixed.invalid');
  insertDomainAsset(mixed.db, {
    ...assetRow(mixed.runId, 'sitemap', 200, '<urlset/>', { sourceType: 'robots_sitemap', sitemap: { valid: true, documentType: 'urlset' } }),
    url: 'https://mixed.invalid/valid.xml'
  });
  insertDomainAsset(mixed.db, {
    ...assetRow(mixed.runId, 'sitemap', 404, 'missing', { sourceType: 'robots_sitemap', sitemap: { valid: false, documentType: 'unavailable' } }),
    url: 'https://mixed.invalid/broken.xml'
  });
  const mixedResult = runCheck(mixed, 'tech.sitemap_present');
  assert.equal(mixedResult.status, 'Warning');
  assert.equal(mixedResult.facts.validSitemapCount, 1);
  assert.equal(mixedResult.facts.deterministicDeclaredFailureCount, 1);
  mixed.db.close();

  const oversized = setupRun('https://oversized.invalid');
  insertDomainAsset(oversized.db, assetRow(oversized.runId, 'sitemap', 200, '<urlset/>', {
    sourceType: 'robots_sitemap',
    sitemap: { valid: true, documentType: 'urlset', protocolLimitExceeded: true }
  }));
  const oversizedResult = runCheck(oversized, 'tech.sitemap_present');
  assert.equal(oversizedResult.status, 'Warning');
  assert.equal(oversizedResult.facts.protocolLimitViolationCount, 1);
  oversized.db.close();

  const technical = setupRun('https://technical.invalid');
  insertDomainAsset(technical.db, assetRow(technical.runId, 'robots', null, '', { fetchError: 'timeout' }));
  insertDomainAsset(technical.db, assetRow(technical.runId, 'sitemap', null, '', { sourceType: 'robots_sitemap', fetchError: 'timeout', sitemap: { valid: false, documentType: 'unavailable' } }));
  assert.equal(runCheck(technical, 'tech.robots_txt_present').evaluationState, 'technical_error');
  assert.equal(runCheck(technical, 'tech.sitemap_present').evaluationState, 'technical_error');
  technical.db.close();
});

test('sitemap directive check accepts only absolute URLs and remains an optional score-free discovery signal', () => {
  const fixture = setupRun('https://directives.invalid');
  insertDomainAsset(fixture.db, assetRow(fixture.runId, 'robots', 200, 'User-agent: *\nSitemap: /relative.xml'));
  let result = runCheck(fixture, 'tech.sitemap_in_robots');
  assert.equal(result.status, 'Warning');
  assert.equal(result.scoreEligible, false);
  assert.equal(result.evidence.directives[0].valid, false);
  fixture.db.prepare('DELETE FROM domain_assets WHERE runId=?').run(fixture.runId);
  insertDomainAsset(fixture.db, assetRow(fixture.runId, 'robots', 200, 'User-agent: *\nSitemap: https://directives.invalid/map.xml'));
  result = runCheck(fixture, 'tech.sitemap_in_robots');
  assert.equal(result.status, 'OK');
  assert.equal(result.scoreEligible, false);
  fixture.db.close();
});

test('AI bot and llms.txt robots policies follow the score-capable standard while summary remains diagnostic', () => {
  const fixture = setupRun('https://policy.invalid');
  insertDomainAsset(fixture.db, assetRow(fixture.runId, 'robots', 200, [
    'User-agent: *',
    'Disallow: /*.txt$',
    'User-agent: GPTBot',
    'Disallow: /'
  ].join('\n')));
  const textPolicy = runGeoCheck(fixture, 'geo.robots_blocks_txt_files');
  const botPolicy = runGeoCheck(fixture, 'geo.ai_bots_policy_summary');
  assert.equal(textPolicy.status, 'Warning');
  assert.equal(textPolicy.scoreEligible, true);
  assert.equal(textPolicy.priority, 'Medium');
  assert.equal(botPolicy.status, 'OK');
  assert.equal(botPolicy.scoreEligible, false);
  fixture.db.close();
});

test('sitemap URL status check separates redirects, failures and incomplete coverage and remains run-isolated', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  const a = setupRun('https://a.invalid', {}, db);
  const b = setupRun('https://b.invalid', {}, db);
  seedSitemapQueue(a, '/direct', 200, 200, []);
  seedSitemapQueue(a, '/redirect', 301, 200, [{ url: 'https://a.invalid/redirect', statusCode: 301, location: 'https://a.invalid/final' }]);
  seedSitemapQueue(a, '/missing', 404, 404, []);
  seedSitemapQueue(b, '/foreign', 500, 500, []);
  a.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({ logicVersion: 'robots-sitemap-validation-v1', discoveryComplete: true, uniqueListedUrls: 3, sampleStrategy: 'all' }), a.runId);
  b.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({ logicVersion: 'robots-sitemap-validation-v1', discoveryComplete: true, uniqueListedUrls: 1, sampleStrategy: 'all' }), b.runId);
  let result = runCheck(a, 'tech.sitemap_urls_non_200');
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 2);
  assert.equal(result.facts.coverageRatio, 1);
  assert.ok(result.evidence.samples.every((row) => row.url.startsWith('https://a.invalid/')));

  a.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({ logicVersion: 'robots-sitemap-validation-v1', discoveryComplete: false, uniqueListedUrls: 5, sampleStrategy: 'deterministic_document_order_limit' }), a.runId);
  a.db.prepare("UPDATE pages SET initialStatusCode=200,statusCode=200 WHERE runId=?").run(a.runId);
  result = runCheck(a, 'tech.sitemap_urls_non_200');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  assert.equal(result.facts.coverageRatio, 0.6);

  a.db.prepare('UPDATE runs SET sitemapDiscoveryJson=NULL WHERE id=?').run(a.runId);
  result = runCheck(a, 'tech.sitemap_urls_non_200');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.facts.sampleStrategy, 'historical_planned_units');
  db.close();
});

test('orphan-like discovery stays score-free and unevaluated when sitemap or link coverage is partial', () => {
  const fixture = setupRun('https://orphan.invalid');
  seedSitemapQueue(fixture, '/candidate', 200, 200, []);
  fixture.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({
    logicVersion: 'robots-sitemap-validation-v1',
    discoveryComplete: false,
    plannedSitemapUrls: 1,
    uniqueListedUrls: 2,
    sampleStrategy: 'deterministic_document_order_limit'
  }), fixture.runId);
  const result = runCheck(fixture, 'tech.orphan_like_sitemap_urls');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  assert.equal(result.evidence.observedCandidateCount, 1);
  fixture.db.close();
});

test('sitemap URL status semantics distinguish deterministic non-200 from transient and technical measurements', () => {
  const fixture = setupRun('https://statuses.invalid');
  for (const status of [204, 302, 307, 308, 404, 410]) {
    seedSitemapQueue(fixture, `/status-${status}`, status, status >= 300 && status < 400 ? 200 : status, status >= 300 && status < 400 ? [{ url: `https://statuses.invalid/status-${status}`, statusCode: status, location: `https://statuses.invalid/final-${status}` }] : []);
  }
  seedSitemapQueue(fixture, '/rate-limit', 429, 429, []);
  seedSitemapQueue(fixture, '/one-shot-500', 500, 500, []);
  fixture.db.prepare("UPDATE crawl_queue SET status='failed', lastErrorType='timeout' WHERE runId=? AND url LIKE '%rate-limit'").run(fixture.runId);
  fixture.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({ logicVersion: 'robots-sitemap-validation-v1', discoveryComplete: true, uniqueListedUrls: 8, sampleStrategy: 'all' }), fixture.runId);
  const result = runCheck(fixture, 'tech.sitemap_urls_non_200');
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 6);
  assert.equal(result.evidence.inconclusiveMeasurements, 2);
  assert.equal(result.facts.failedMeasurements, 2);
  assert.equal(result.confidence, 'medium');
  fixture.db.close();
});

test('sitemap coverage facts remain aligned in detail, CSV, JSON and HTML and old databases gain additive columns', () => {
  const fixture = setupRun('https://parity.invalid');
  seedSitemapQueue(fixture, '/redirect', 301, 200, [{ url: 'https://parity.invalid/redirect', statusCode: 301, location: 'https://parity.invalid/final' }]);
  fixture.db.prepare('UPDATE runs SET sitemapDiscoveryJson=? WHERE id=?').run(JSON.stringify({ logicVersion: 'robots-sitemap-validation-v1', discoveryComplete: true, uniqueListedUrls: 1, sampleStrategy: 'all' }), fixture.runId);
  const result = runCheck(fixture, 'tech.sitemap_urls_non_200');
  insertCheckResults(fixture.db, fixture.runId, [result]);
  const stored = fixture.db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.sitemap_urls_non_200'").get(fixture.runId);
  const detail = getCheckDetail(fixture.db, fixture.runId, stored.id);
  assert.equal(detail.facts.coverageRatio, 1);
  const csv = collectCheckDetailCsv(fixture.db, fixture.runId, stored.id).csv;
  assert.match(csv, /Coverage Ratio/);
  const json = JSON.parse(collectFullAuditJson(fixture.db, fixture.runId, ['findings']).body);
  assert.equal(json.checkDetails.find((item) => item.checkId === 'tech.sitemap_urls_non_200').facts.coverageRatio, 1);
  const reportPath = generateReport(fixture.db, fixture.runId);
  const report = fs.readFileSync(reportPath, 'utf8');
  assert.match(report, /Sitemap URLs with non-200 status/);
  assert.match(report, /discoveryComplete/);
  fs.rmSync(reportPath, { force: true });

  fixture.db.exec('ALTER TABLE runs DROP COLUMN sitemapDiscoveryJson; ALTER TABLE domain_assets DROP COLUMN metadataJson;');
  initDatabase(fixture.db);
  assert.ok(fixture.db.prepare("PRAGMA table_info(runs)").all().some((row) => row.name === 'sitemapDiscoveryJson'));
  assert.ok(fixture.db.prepare("PRAGMA table_info(domain_assets)").all().some((row) => row.name === 'metadataJson'));
  fixture.db.close();
});

function setupRun(domain, overrides = {}, existingDb = null) {
  const db = existingDb || new Database(':memory:');
  if (!existingDb) initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run(domain, projectId);
  const runId = createRun(db, projectId, normalizeAuditConfig({ domain, auditType: 'tech', maxUrls: 100, maxDepth: 0, usePlaywright: false, storeAllLinks: true, ...overrides }));
  return { db, projectId, runId, domain };
}

function runCheck(fixture, id) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}

function runGeoCheck(fixture, id) {
  const check = geoChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}

function asset(statusCode, content, contentType = 'text/plain') {
  return { url: 'https://fixture.invalid/robots.txt', statusCode, content, responseHeadersJson: JSON.stringify({ 'content-type': contentType }) };
}

function assetRow(runId, type, statusCode, content, metadata = {}) {
  const path = type === 'robots' ? 'robots.txt' : 'sitemap.xml';
  const url = `https://${type}.invalid/${path}`;
  return {
    runId,
    type,
    url,
    statusCode,
    content,
    responseHeadersJson: JSON.stringify({ 'content-type': metadata.contentType || (type === 'robots' ? 'text/plain' : 'application/xml') }),
    metadataJson: JSON.stringify({
      initialStatusCode: statusCode,
      finalStatusCode: statusCode,
      finalUrl: url,
      redirectChain: [],
      truncated: false,
      measurementState: statusCode === null ? 'technical_error' : 'confirmed',
      measurementAttempts: statusCode === null
        ? [{ attempt: 1, method: 'GET', networkError: metadata.fetchError || 'fixture_error' }]
        : [{ attempt: 1, method: 'GET', initialStatusCode: statusCode, finalStatusCode: statusCode, finalUrl: url, redirectChain: [] }],
      ...metadata
    })
  };
}

function seedSitemapQueue(fixture, path, initialStatus, finalStatus, chain) {
  const url = new URL(path, fixture.domain).toString();
  fixture.db.prepare("INSERT INTO crawl_queue (runId,url,normalizedUrl,depth,sourceType,status,priority,attempts) VALUES (?,?,?,0,'sitemap','done',20,1)").run(fixture.runId, url, url);
  fixture.db.prepare(`
    INSERT INTO pages (runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,redirectChainJson,httpAttemptHistoryJson,contentType,indexable,title,h1Json,h1Count,pageType)
    VALUES (?,?,?,?,0,?,?,?,?,?,1,'Fixture','["Fixture"]',1,'other')
  `).run(fixture.runId, url, url, chain.at(-1)?.location || url, finalStatus, initialStatus, JSON.stringify(chain), JSON.stringify([{ attempt: 1, method: 'GET', initialStatus, finalStatus }]), 'text/html');
}

function text(status, body, contentType = 'text/plain') { return { status, body, contentType }; }
function xml(status, body) { return { status, body, contentType: 'application/xml' }; }

async function withServer(routes, callback) {
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url, 'http://fixture').pathname] || text(404, 'missing');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const body = typeof route.body === 'string' ? route.body.replaceAll('__ORIGIN__', origin) : route.body;
    response.writeHead(route.status, { 'content-type': route.contentType });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await callback({ origin: `http://127.0.0.1:${server.address().port}` }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
