import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { processQueueItem } from '../src/crawler/pageProcessor.js';
import { templatePatternChecks } from '../src/analysis/templatePatternChecks.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { runChecks } from '../src/checks/checkEngine.js';
import { syntheticNotFoundCheck } from '../src/checks/http/notFoundCheck.js';
import {
  createProject,
  createRun,
  getRunWithProject,
  hydrateInternalLinkHttpFacts,
  insertCheckResults,
  updateRun,
  updateProject
} from '../src/db/repositories.js';
import { claimNextUrl, enqueueUrl } from '../src/queue/sqliteQueue.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { blocksTxtFiles } from '../src/utils/robots.js';
import { computeScores } from '../src/utils/scoring.js';
import { normalizeRequestUrl, normalizeUrl } from '../src/utils/url.js';

test('authored trailing slashes are requested while queue identity stays canonical', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/slash') {
      response.writeHead(308, { location: '/slash/' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="en"><head><title>Slash page</title></head><body><h1>Slash page</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixture = makeFixture(origin);
  try {
    assert.equal(normalizeUrl(`${origin}/slash/`), `${origin}/slash`);
    assert.equal(normalizeRequestUrl(`${origin}/slash/`), `${origin}/slash/`);
    enqueueUrl(fixture.db, { runId: fixture.runId, url: `${origin}/slash/`, sourceType: 'seed' });
    const item = claimNextUrl(fixture.db, fixture.runId);
    assert.equal(item.url, `${origin}/slash/`);
    assert.equal(item.normalizedUrl, `${origin}/slash`);
    await processQueueItem(fixture.db, fixture.run, fixture.run, item, null, null);
    const page = fixture.db.prepare('SELECT url, normalizedUrl, initialStatusCode, statusCode FROM pages WHERE runId=?').get(fixture.runId);
    assert.deepEqual(page, { url: `${origin}/slash/`, normalizedUrl: `${origin}/slash`, initialStatusCode: 200, statusCode: 200 });
    assert.equal(runTech('tech.redirect_pages', fixture).status, 'OK');

    fixture.db.prepare(`INSERT INTO page_links (runId,sourceUrl,targetUrl,linkedUrl,normalizedTargetUrl,linkType) VALUES (?, ?, ?, ?, ?, 'internal')`)
      .run(fixture.runId, `${origin}/source`, `${origin}/slash/`, `${origin}/slash/`, `${origin}/slash`);
    fixture.db.prepare(`INSERT INTO page_links (runId,sourceUrl,targetUrl,linkedUrl,normalizedTargetUrl,linkType) VALUES (?, ?, ?, ?, ?, 'internal')`)
      .run(fixture.runId, `${origin}/source`, `${origin}/slash`, `${origin}/slash`, `${origin}/slash`);
    hydrateInternalLinkHttpFacts(fixture.db, fixture.runId);
    const links = fixture.db.prepare('SELECT linkedUrl, initialStatusCode FROM page_links WHERE runId=? ORDER BY id').all(fixture.runId);
    assert.deepEqual(links, [
      { linkedUrl: `${origin}/slash/`, initialStatusCode: 200 },
      { linkedUrl: `${origin}/slash`, initialStatusCode: null }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('literal txt exclusions are not treated as a blanket txt block', () => {
  assert.equal(blocksTxtFiles('User-agent: *\nDisallow: /README.txt'), false);
  assert.equal(blocksTxtFiles('User-agent: *\nDisallow: /private/*.txt$'), false);
  assert.equal(blocksTxtFiles('User-agent: *\nDisallow: /*.txt$'), true);
  assert.equal(blocksTxtFiles('User-agent: *\nDisallow: /'), true);
});

test('image-alt accessible names count as non-empty heading content', () => {
  const extracted = extractHtml(
    '<!doctype html><html><head><title>Logo heading</title></head><body><h1><a href="/"><img src="logo.svg" alt="Example publication"></a></h1></body></html>',
    'https://example.invalid/',
    'https://example.invalid',
    {}
  );
  assert.equal(extracted.page.h1Count, 1);
  assert.deepEqual(JSON.parse(extracted.page.h1Json), ['Example publication']);
});

test('template schema roll-up accepts BlogPosting and remains score-free', () => {
  const fixture = makeFixture('https://articles.invalid');
  for (let index = 1; index <= 3; index += 1) {
    insertPage(fixture.db, fixture.runId, `https://articles.invalid/blog/post-${index}`, {
      pageType: 'article',
      templateClusterKey: 'article:/blog/{slug}',
      schemaTypesJson: JSON.stringify(['BlogPosting', 'BreadcrumbList'])
    });
  }
  const schema = runTemplate('template.schema_missing_pattern', fixture);
  assert.equal(schema.status, 'OK');
  assert.equal(schema.scoreEligible, false);

  for (let index = 1; index <= 3; index += 1) {
    fixture.db.prepare('UPDATE pages SET title=?, titleLength=? WHERE runId=? AND url=?')
      .run('X'.repeat(80), 80, fixture.runId, `https://articles.invalid/blog/post-${index}`);
  }
  const title = runTemplate('template.title_pattern_issue', fixture);
  assert.equal(title.status, 'Warning');
  assert.equal(title.priority, 'Low');
  assert.equal(title.scoreEligible, false);
  assert.match(title.scoreExclusionReason, /derived template roll-up/i);
});

test('missing protocol measurements fail closed as insufficient evidence', () => {
  const fixture = makeFixture('https://protocol.invalid', { protocolBehavior: [] });
  const https = runTech('tech.https_reachable', fixture);
  const redirect = runTech('tech.http_to_https_redirect', fixture);
  assert.equal(https.evaluationState, 'insufficient_evidence');
  assert.equal(https.scoreEligible, false);
  assert.equal(redirect.evaluationState, 'insufficient_evidence');
  assert.equal(redirect.scoreEligible, false);
});

test('score-free evaluated inventory contributes coverage without a penalty', () => {
  const scores = computeScores([
    {
      id: 'inventory', checkId: 'tech.third_party_scripts_detected', auditType: 'tech', category: 'Performance Light',
      status: 'Warning', priority: 'Low', evaluationState: 'fail', scoreEligible: false, confidence: 'medium',
      findingType: 'opportunity', affectedCount: 4, evidence: { samples: [{ url: 'https://example.invalid/' }] }
    },
    {
      id: 'core-pass', checkId: 'tech.https_reachable', auditType: 'tech', category: 'Server & Infrastructure',
      status: 'OK', priority: 'High', evaluationState: 'pass', scoreEligible: true, confidence: 'high',
      findingType: 'core_issue', affectedCount: 0, evidence: { httpsCandidates: [{ statusCode: 200 }] }
    }
  ]);
  assert.equal(scores.weightedCoverage, 100);
  assert.equal(scores.overallScore, 100);
  assert.equal(scores.breakdown.rootCauseCount, 0);
});

test('declared check priority controls scoring severity independently of display status', () => {
  const scores = computeScores([{
    id: 'medium-error', checkId: 'tech.h1_missing', auditType: 'tech', category: 'HTML & Meta',
    status: 'Error', priority: 'Medium', evaluationState: 'fail', scoreEligible: true, confidence: 'high',
    findingType: 'core_issue', affectedCount: 1, evidence: { sampleUrls: ['https://example.invalid/'] }
  }]);
  assert.equal(scores.breakdown.deductions[0].severity, 'medium');
  assert.equal(scores.breakdown.deductions[0].rawPenalty, 4.5);
});

test('calibrated optional checks cannot outrank measured core issues', () => {
  const tech = new Map(techChecks().map((check) => [check.id, check]));
  const geo = new Map(geoChecks().map((check) => [check.id, check]));
  for (const id of [
    'tech.hsts_header', 'tech.content_security_policy', 'tech.title_too_short', 'tech.title_too_long',
    'tech.raw_html_size_large', 'tech.too_many_js', 'tech.too_many_css',
    'tech.organization_missing', 'tech.website_missing', 'tech.breadcrumb_missing_low_coverage', 'tech.empty_alt_texts',
    'tech.images_without_width_height', 'tech.canonical_non_self'
  ]) assert.equal(tech.get(id).priority, 'Low', id);
  assert.equal(geo.get('geo.organization_schema_sameas').priority, 'Low');
  assert.equal(geo.get('geo.llms_txt_present').priority, 'Low');
  assert.equal(tech.get('tech.synthetic_not_found_handling').priority, 'High');
});

test('rendered H1 evidence prevents a raw-only missing-H1 finding', () => {
  const fixture = makeFixture('https://rendered.invalid');
  insertPage(fixture.db, fixture.runId, 'https://rendered.invalid/app', {
    h1Count: 0,
    renderedH1Count: 1,
    renderStatus: 'success'
  });
  assert.equal(runTech('tech.h1_missing', fixture).status, 'OK');
});

test('finding assessment preserves explicit Medium priority for Error display status', () => {
  const fixture = makeFixture('https://heading.invalid');
  insertPage(fixture.db, fixture.runId, 'https://heading.invalid/', { h1Count: 0 });
  const result = runTech('tech.h1_missing', fixture);
  assert.equal(result.status, 'Error');
  assert.equal(result.priority, 'Medium');
  assert.equal(result.assessment.severity, 'medium');
});

test('HTML scope gates exclude redirect responses even when their final response is 200 HTML', () => {
  const fixture = makeFixture('https://redirect-scope.invalid');
  const url = 'https://redirect-scope.invalid/alias';
  insertPage(fixture.db, fixture.runId, url, {
    h1Count: 0,
    canonical: 'https://redirect-scope.invalid/canonical'
  });
  fixture.db.prepare('UPDATE pages SET initialStatusCode=301, finalUrl=? WHERE runId=? AND url=?')
    .run('https://redirect-scope.invalid/canonical', fixture.runId, url);
  assert.equal(runTech('tech.h1_missing', fixture).evaluationState, 'not_applicable');
  assert.equal(runTech('tech.canonical_non_self', fixture).evaluationState, 'not_applicable');
});

test('navigation-link absence fails closed when retained link rows are truncated', () => {
  const fixture = makeFixture('https://navigation.invalid');
  insertPage(fixture.db, fixture.runId, 'https://navigation.invalid/');
  fixture.db.prepare('UPDATE pages SET linkRowsTruncated=1, storedLinkRowsCount=25, internalLinksCount=100 WHERE runId=?')
    .run(fixture.runId);
  const incomplete = runGeo('geo.about_linked', fixture);
  assert.equal(incomplete.evaluationState, 'insufficient_evidence');
  assert.equal(incomplete.scoreEligible, false);

  fixture.db.prepare('UPDATE pages SET linkRowsTruncated=0, storedLinkRowsCount=1, internalLinksCount=1 WHERE runId=?')
    .run(fixture.runId);
  fixture.db.prepare(`INSERT INTO page_links (runId,sourceUrl,targetUrl,linkedUrl,normalizedTargetUrl,linkType,anchorText) VALUES (?,?,?,?,?,'internal','About us')`)
    .run(fixture.runId, 'https://navigation.invalid/', 'https://navigation.invalid/about/', 'https://navigation.invalid/about/', 'https://navigation.invalid/about');
  assert.equal(runGeo('geo.about_linked', fixture).evaluationState, 'pass');
});

test('navigation-link absence fails closed when rendering adds links without retained detail rows', () => {
  const fixture = makeFixture('https://rendered-navigation.invalid');
  insertPage(fixture.db, fixture.runId, 'https://rendered-navigation.invalid/', { renderStatus: 'success' });
  fixture.db.prepare('UPDATE pages SET internalLinksCount=0, renderedLinksCount=12 WHERE runId=?').run(fixture.runId);
  const result = runGeo('geo.contact_linked', fixture);
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  assert.deepEqual(result.requirements.missingFacts, ['renderedInternalLinkRows']);
});

test('completed-run recalculation preserves previously collected synthetic HTTP evidence', async () => {
  const fixture = makeFixture('https://not-found.invalid');
  const check = syntheticNotFoundCheck({
    force: true,
    nonceFactory: () => 'calibration',
    request: async (url) => ({
      statusCode: url === 'https://not-found.invalid/' ? 200 : 404,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      body: url === 'https://not-found.invalid/' ? '<title>Home</title><main>Home</main>' : '<title>Missing</title>',
      sizeBytes: 32
    })
  });
  const collected = await check.run({ db: fixture.db, run: { ...fixture.run, status: 'running' }, project: fixture.project });
  assert.equal(collected.evaluationState, 'pass');
  insertCheckResults(fixture.db, fixture.runId, [{ ...collected, provenance: { collector: 'synthetic_not_found_http_probe' } }]);
  updateRun(fixture.db, fixture.runId, { status: 'completed' });

  await runChecks(fixture.db, fixture.runId);
  const stored = fixture.db.prepare('SELECT evaluationState, evidenceJson FROM check_results WHERE runId=? AND checkId=?')
    .get(fixture.runId, 'tech.synthetic_not_found_handling');
  assert.equal(stored.evaluationState, 'pass');
  assert.equal(JSON.parse(stored.evidenceJson).extractor, 'synthetic_not_found_http_probe');
});

function makeFixture(origin, options = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const config = normalizeAuditConfig({
    domain: origin,
    auditType: 'both',
    maxUrls: 20,
    maxDepth: 1,
    concurrency: 1,
    respectRobotsTxt: false,
    usePlaywright: false,
    enableTemplateSampling: false,
    storeAllLinks: true,
    storeAllImages: true,
    storeAllResources: true,
    storeResponseHeaders: true
  });
  const projectId = createProject(db, { inputDomain: origin });
  const runId = createRun(db, projectId, config);
  const protocolBehavior = options.protocolBehavior ?? [
    { startUrl: `${origin}/`, finalUrl: `${origin}/`, statusCode: 200, redirectsToHttps: origin.startsWith('https:') }
  ];
  updateProject(db, projectId, {
    finalDomain: origin,
    protocolBehaviorJson: JSON.stringify(protocolBehavior),
    wwwBehaviorJson: JSON.stringify({ selectedHost: new URL(origin).hostname, candidates: [] }),
    redirectChainJson: JSON.stringify([])
  });
  const run = getRunWithProject(db, runId);
  return { db, runId, run, project: { id: projectId, finalDomain: origin, protocolBehaviorJson: run.protocolBehaviorJson, wwwBehaviorJson: run.wwwBehaviorJson, redirectChainJson: run.redirectChainJson } };
}

function insertPage(db, runId, url, overrides = {}) {
  db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,contentType,indexable,
      title,titleLength,metaDescription,metaDescriptionLength,h1Json,h1Count,renderedH1Json,renderedH1Count,
      canonical,htmlLang,rawHtmlSize,pageType,schemaTypesJson,templateClusterKey,renderStatus
    ) VALUES (?,?,?,?,0,200,200,'text/html',1,?,30,?,120,'[]',?, '[]', ?, ?, 'en', 1024, ?, ?, ?, ?)
  `).run(
    runId, url, normalizeUrl(url), normalizeUrl(url),
    overrides.title ?? 'Representative page title',
    overrides.metaDescription ?? 'A representative description with enough detail for the calibration fixture.',
    overrides.h1Count ?? 1,
    overrides.renderedH1Count ?? 0,
    overrides.canonical ?? normalizeUrl(url),
    overrides.pageType ?? 'other',
    overrides.schemaTypesJson ?? '[]',
    overrides.templateClusterKey ?? null,
    overrides.renderStatus ?? 'not_executed'
  );
}

function runTech(id, fixture) {
  const check = techChecks().find((candidate) => candidate.id === id);
  assert.ok(check, `missing ${id}`);
  return check.run({ db: fixture.db, run: fixture.run, project: fixture.project });
}

function runTemplate(id, fixture) {
  const check = templatePatternChecks().find((candidate) => candidate.id === id);
  assert.ok(check, `missing ${id}`);
  return check.run({ db: fixture.db, run: fixture.run, project: fixture.project });
}

function runGeo(id, fixture) {
  const check = geoChecks().find((candidate) => candidate.id === id);
  assert.ok(check, `missing ${id}`);
  return check.run({ db: fixture.db, run: fixture.run, project: fixture.project });
}
