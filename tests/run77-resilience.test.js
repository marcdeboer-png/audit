import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDb } from '../src/db/database.js';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  getRunWithProject,
  hydrateInternalLinkHttpFacts,
  insertCheckResults
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { extractTextKinds } from '../src/extractors/visibleText.js';
import { detectPageType, hasArticleSchema } from '../src/extractors/pageType.js';
import { evaluateDataAvailability } from '../src/checks/availability.js';
import {
  RunScopeIntegrityError,
  assertCheckResultScope,
  assertRunStorageScope,
  createRunScope,
  requireRunId
} from '../src/scope/runScope.js';
import { buildCheckProvenance } from '../src/runtime/provenance.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { loadResultsWithScores, runChecks } from '../src/checks/checkEngine.js';
import { startAudit } from '../src/crawler/auditRunner.js';
import { fetchWithTimeout } from '../src/utils/http.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('run and project isolation is fail-closed across reports, exports and scope assertions', () => withFixtureDb('scope', ({ db, makeRun }) => {
  const a = makeRun('https://alpha.invalid');
  const b = makeRun('https://fressnapf.invalid');
  insertMinimalPage(db, a.runId, 'https://alpha.invalid/same-path', { title: 'Alpha' });
  insertMinimalPage(db, b.runId, 'https://fressnapf.invalid/same-path', {
    title: 'Foreign',
    statusCode: 200,
    initialStatusCode: 308,
    finalUrl: 'https://fressnapf.invalid/final'
  });
  insertCheckResults(db, a.runId, [resultFixture('tech.scope_a', 'https://alpha.invalid/same-path')]);
  insertCheckResults(db, b.runId, [resultFixture('tech.scope_b', 'https://fressnapf.invalid/same-path')]);

  const csv = collectCsvExport(db, a.runId, 'findings');
  assert.match(csv, /tech\.scope_a/);
  assert.doesNotMatch(csv, /scope_b|fressnapf/i);
  const exported = JSON.parse(collectFullAuditJson(db, a.runId, []).body);
  assert.equal(exported.urlInventory.length, 1);
  assert.equal(exported.urlInventory[0].runId, a.runId);
  assert.doesNotMatch(JSON.stringify(exported), /fressnapf/i);
  const scored = loadResultsWithScores(db, a.runId);
  assert.equal(scored.results.length, 1);
  assert.equal(scored.results[0].checkId, 'tech.scope_a');
  const redirectA = runCheck('tech.redirect_pages', { db, run: a.run, project: a.project });
  assert.equal(redirectA.affectedCount, 0);
  assert.doesNotMatch(JSON.stringify(redirectA), /fressnapf/i);
  const reportPath = generateReport(db, a.runId);
  const report = fs.readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(report, /fressnapf/i);
  fs.rmSync(reportPath, { force: true });

  insertCheckResults(db, a.runId, [resultFixture('tech.persisted_scope_leak', 'https://fressnapf.invalid/leak')]);
  const scopeSafeResults = loadResultsWithScores(db, a.runId).results;
  const suppressed = scopeSafeResults.find((row) => row.checkId === 'tech.persisted_scope_leak');
  assert.equal(suppressed.evaluationState, 'technical_error');
  assert.doesNotMatch(JSON.stringify(suppressed), /fressnapf/i);
  const safeCsv = collectCsvExport(db, a.runId, 'findings');
  assert.match(safeCsv, /technical_error/);
  assert.doesNotMatch(safeCsv, /fressnapf/i);
  const persistedRow = db.prepare(`SELECT id FROM check_results WHERE runId=? AND checkId='tech.persisted_scope_leak'`).get(a.runId);
  const safeDetail = getCheckDetail(db, a.runId, persistedRow.id);
  assert.equal(safeDetail.evaluationState, 'technical_error');
  assert.doesNotMatch(JSON.stringify(safeDetail), /fressnapf/i);

  assert.throws(() => requireRunId(undefined, 'fixture query'), RunScopeIntegrityError);
  const scope = createRunScope(a.run, a.project);
  assert.throws(() => assertCheckResultScope({ id: 'foreign', sampleUrls: ['https://fressnapf.invalid/leak'] }, scope), RunScopeIntegrityError);

  db.prepare(`INSERT INTO page_links (runId, sourceUrl, targetUrl, normalizedTargetUrl, linkType) VALUES (?, ?, ?, ?, 'internal')`)
    .run(a.runId, 'https://alpha.invalid/same-path', 'https://fressnapf.invalid/leak', 'https://fressnapf.invalid/leak');
  assert.throws(() => assertRunStorageScope(db, scope), RunScopeIntegrityError);
}));

test('two audit-runner executions keep URL inventories, findings and scores isolated end to end', async () => {
  const temp = useTempAuditDb('scope-e2e');
  const server = http.createServer((request, response) => {
    const host = request.headers.host;
    if (request.url.startsWith('/__audit-not-found-')) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<title>Not found</title><h1>Not found</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><title>${host}</title><meta name="description" content="Isolated fixture description"><link rel="canonical" href="http://${host}/"></head><body><h1>${host}</h1></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const common = {
      auditType: 'tech', maxUrls: 1, maxDepth: 0, concurrency: 1,
      respectRobotsTxt: false, usePlaywright: false, enableTemplateSampling: false,
      enablePlaywrightSampling: false, enableLighthouseSampling: false
    };
    const a = await startAudit({ domain: `http://127.0.0.1:${port}`, ...common }, { wait: true });
    const b = await startAudit({ domain: `http://localhost:${port}`, ...common }, { wait: true });
    const db = getDb();
    const aUrls = db.prepare('SELECT url FROM pages WHERE runId=?').all(a.runId).map((row) => row.url);
    const bUrls = db.prepare('SELECT url FROM pages WHERE runId=?').all(b.runId).map((row) => row.url);
    assert.equal(aUrls.length, 1);
    assert.equal(bUrls.length, 1);
    assert.ok(aUrls.every((url) => new URL(url).hostname === '127.0.0.1'));
    assert.ok(bUrls.every((url) => new URL(url).hostname === 'localhost'));
    assert.doesNotMatch(collectCsvExport(db, a.runId, 'findings'), /localhost/);
    assert.doesNotMatch(JSON.stringify(loadResultsWithScores(db, a.runId)), /localhost/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    temp.cleanup();
  }
});

test('HTTP collection preserves the initial redirect status and a redirect-only chain', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/alias') {
      response.writeHead(308, { location: '/final' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>Final</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const redirected = await fetchWithTimeout(`${origin}/alias`);
    assert.equal(redirected.initialStatusCode, 308);
    assert.equal(redirected.statusCode, 200);
    assert.equal(redirected.redirectChain.length, 1);
    assert.equal(redirected.redirectChain[0].statusCode, 308);
    assert.equal(redirected.redirectChain[0].location, `${origin}/final`);
    const direct = await fetchWithTimeout(`${origin}/final`);
    assert.equal(direct.initialStatusCode, 200);
    assert.equal(direct.redirectChain.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('visible text excludes scripts, hydration, hidden nodes and SVG while preserving semantic byline and time', () => {
  const html = `<!doctype html><html><head><title>Metadata author</title></head><body>
    <script>window.__DATA__={author:'Script Ghost',date:'2024-01-01',type:'Article'}</script>
    <script type="application/ld+json">{"@type":"BlogPosting","author":"Schema Ghost","datePublished":"2024-02-02"}</script>
    <script id="__NEXT_DATA__" type="application/json">{"author":"Hydration Ghost"}</script>
    <style>.secret{display:none}</style><noscript>Noscript author</noscript><template>Template author</template>
    <div hidden>Hidden author 2024-03-03</div><div aria-hidden="true">ARIA author</div>
    <details><summary>Visible summary</summary><p>Collapsed author 2024-04-04</p></details>
    <dialog>Closed dialog author</dialog>
    <svg><text>SVG technical author</text></svg>
    <article><h1>Visible article</h1><p class="byline">Written by Ada Lovelace</p><time>18.07.2026</time><p>Visible body.</p></article>
  </body></html>`;
  const text = extractTextKinds(html);
  assert.match(text.rawText, /Script Ghost|Hydration Ghost/);
  assert.match(text.visibleText, /Ada Lovelace/);
  assert.match(text.visibleText, /Visible summary/);
  assert.doesNotMatch(text.visibleText, /Script Ghost|Schema Ghost|Hydration Ghost|Noscript|Template author|Hidden author|ARIA author|Collapsed author|Closed dialog|SVG technical/);
  const extracted = extractHtml(html, 'https://example.invalid/blog/visible-article', 'example.invalid');
  assert.equal(extracted.page.hasAuthorPattern, 1);
  assert.equal(extracted.page.hasVisibleDate, 1);
  assert.equal(extracted.page.pageType, 'article');
  assert.equal(extracted.page.wordCountRaw, 13);
  const facts = JSON.parse(extracted.page.textFactsJson);
  assert.equal(facts.normalization_version, 'visible_text_v1');
  assert.ok(facts.raw_text.length > facts.visible_text.length);
  assert.ok(facts.structured_data_text.length > 0);
  assert.ok(facts.metadata_text.length > 0);
});

test('availability distinguishes null, empty, zero and stable repeated measurements', () => {
  const facts = { nil: null, empty: '', zero: 0, disabled: false };
  assert.equal(evaluateDataAvailability({ facts, requiredFacts: ['nil'] }).evaluationState, 'insufficient_evidence');
  assert.equal(evaluateDataAvailability({ facts, requiredFacts: ['empty', 'zero', 'disabled'] }).evaluationState, 'pass');
  assert.equal(evaluateDataAvailability({ facts: { bytes: 0 }, requiredFacts: ['bytes'], measurements: [0], minimumMeasurements: 1 }).evaluationState, 'pass');
  assert.equal(evaluateDataAvailability({ facts: { bytes: 0 }, requiredFacts: ['bytes'], measurements: [], minimumMeasurements: 1 }).evaluationState, 'insufficient_evidence');
});

test('redirect aliases, article subtypes, page scopes, alt states, references and full counts are corrected', () => withFixtureDb('checks', ({ db, makeRun }) => {
  const fixture = makeRun('https://checks.invalid', { usePlaywright: true, playwrightMode: 'all' });
  const { runId, run, project } = fixture;
  insertMinimalPage(db, runId, 'https://checks.invalid/source');
  insertMinimalPage(db, runId, 'https://checks.invalid/alias', {
    statusCode: 200,
    initialStatusCode: 308,
    finalUrl: 'https://checks.invalid/final',
    redirectChainJson: JSON.stringify([
      { url: 'https://checks.invalid/alias', statusCode: 308, location: 'https://checks.invalid/final' },
      { url: 'https://checks.invalid/final', statusCode: 200, location: null }
    ])
  });
  insertMinimalPage(db, runId, 'https://checks.invalid/direct');
  db.prepare(`INSERT INTO page_links (runId, sourceUrl, targetUrl, normalizedTargetUrl, linkType) VALUES (?, ?, ?, ?, 'internal')`)
    .run(runId, 'https://checks.invalid/source', 'https://checks.invalid/alias#section', 'https://checks.invalid/alias');
  db.prepare(`INSERT INTO page_links (runId, sourceUrl, targetUrl, normalizedTargetUrl, linkType) VALUES (?, ?, ?, ?, 'internal')`)
    .run(runId, 'https://checks.invalid/source', 'https://checks.invalid/direct?x=1', 'https://checks.invalid/direct');
  hydrateInternalLinkHttpFacts(db, runId);
  const redirectResult = runCheck('tech.internal_links_to_3xx', { db, run, project });
  assert.equal(redirectResult.affectedCount, 1);
  assert.equal(redirectResult.evidence.uniqueTargets, 1);
  assert.equal(redirectResult.evidence.samples[0].initial_status, 308);
  assert.equal(redirectResult.evidence.samples[0].final_status, 200);

  insertMinimalPage(db, runId, 'https://checks.invalid/blog/post', { pageType: 'article', schemaTypesJson: JSON.stringify(['BlogPosting']) });
  insertMinimalPage(db, runId, 'https://checks.invalid/blog/', { pageType: 'blog_index', schemaTypesJson: JSON.stringify([]) });
  assert.equal(hasArticleSchema(['BlogPosting']), true);
  assert.equal(detectPageType({ url: 'https://checks.invalid/blog/page/2', schemaTypes: ['BlogPosting'] }), 'blog_index');
  const article = runCheck('tech.article_coverage_on_article_like_pages', { db, run, project });
  assert.equal(article.status, 'OK');
  assert.equal(article.facts?.affectedCount ?? article.affectedCount, 0);
  assert.notEqual(detectPageType({ url: 'https://checks.invalid/cookie-vanilla-product', title: 'Cookie Vanilla Product' }), 'legal');
  insertMinimalPage(db, runId, 'https://checks.invalid/products/broken', { pageType: 'product', statusCode: 404, initialStatusCode: 404, indexable: 0 });
  assert.equal(runCheck('tech.product_coverage_on_product_like_pages', { db, run, project }).evaluationState, 'not_applicable');

  insertImage(db, runId, 'missing.png', { altAttributePresent: 0, altValue: null, altValueTrimmed: null });
  insertImage(db, runId, 'empty.png', { altAttributePresent: 1, altValue: '', altValueTrimmed: '' });
  insertImage(db, runId, 'space.png', { altAttributePresent: 1, altValue: '   ', altValueTrimmed: '' });
  insertImage(db, runId, 'decorative.png', { altAttributePresent: 1, altValue: '', altValueTrimmed: '', decorative: 1 });
  assert.equal(runCheck('tech.images_without_alt', { db, run, project }).affectedCount, 1);
  assert.equal(runCheck('tech.empty_alt_texts', { db, run, project }).affectedCount, 2);

  db.prepare(`INSERT INTO domain_assets (runId,type,url,statusCode,content) VALUES (?, 'llms_full', ?, 404, ?)`).run(runId, 'https://checks.invalid/llms-full.txt', 'https://checks.invalid/llms-full.txt');
  assert.equal(runGeoCheck('geo.llms_full_txt_present', { db, run, project }).evaluationState, 'not_applicable');
  db.prepare(`INSERT INTO page_links (runId,sourceUrl,targetUrl,normalizedTargetUrl,linkType) VALUES (?, ?, ?, ?, 'internal')`)
    .run(runId, 'https://checks.invalid/source', 'https://checks.invalid/llms-full.txt', 'https://checks.invalid/llms-full.txt');
  assert.equal(runGeoCheck('geo.llms_full_txt_present', { db, run, project }).status, 'Warning');

  for (let index = 0; index < 15; index += 1) insertMinimalPage(db, runId, `https://checks.invalid/duplicate-${index}`, { title: 'Duplicate title' });
  const duplicates = runCheck('tech.duplicate_titles', { db, run, project });
  assert.equal(duplicates.affectedCount, 15);
  assert.equal(duplicates.evidence.displayedSamples, 1);

  insertMinimalPage(db, runId, 'https://checks.invalid/logo.svg', { contentType: 'image/svg+xml', statusCode: 200, indexable: 0, h1Count: 0 });
  assert.notEqual(runCheck('tech.h1_missing', { db, run, project }).sampleUrls.includes('https://checks.invalid/logo.svg'), true);
  insertMinimalPage(db, runId, 'https://checks.invalid/impressum', { pageType: 'legal', noindex: 1, indexable: 0, metaRobots: 'noindex' });
  const noindex = runCheck('tech.noindex_pages', { db, run, project });
  assert.equal(noindex.status, 'NA');
  assert.equal(noindex.scoreEligible, false);
}));

test('resource, TTFB, Lighthouse and browser availability gates never turn missing data into pass', () => withFixtureDb('availability', ({ db, makeRun }) => {
  const fixture = makeRun('https://availability.invalid', {
    usePlaywright: true,
    playwrightMode: 'all',
    enableTemplateSampling: true,
    enablePlaywrightSampling: true,
    enableLighthouseSampling: true
  });
  const { runId, run, project } = fixture;
  insertMinimalPage(db, runId, 'https://availability.invalid/');
  db.prepare(`INSERT INTO resources (runId,pageUrl,resourceUrl,resourceType,sizeBytes,sizeMeasurementError,isThirdParty) VALUES (?, ?, ?, 'script', NULL, NULL, 0)`)
    .run(runId, 'https://availability.invalid/', 'https://availability.invalid/app.js');
  assert.equal(runCheck('tech.large_js_total', { db, run, project }).evaluationState, 'insufficient_evidence');
  db.prepare(`UPDATE resources SET sizeBytes = 0, sizeMeasurementKind = 'observed_bytes' WHERE runId = ?`).run(runId);
  assert.equal(runCheck('tech.large_js_total', { db, run, project }).status, 'OK');
  db.prepare(`UPDATE resources SET sizeBytes = NULL, sizeMeasurementKind = NULL, sizeMeasurementError = 'download_failed' WHERE runId = ?`).run(runId);
  assert.equal(runCheck('tech.large_js_total', { db, run, project }).evaluationState, 'technical_error');

  db.prepare(`INSERT INTO resources (runId,pageUrl,resourceUrl,resourceType,sizeBytes,isThirdParty) VALUES (?, ?, ?, 'stylesheet', NULL, 0)`)
    .run(runId, 'https://availability.invalid/', 'https://availability.invalid/app.css');
  assert.equal(runCheck('tech.large_css_total', { db, run, project }).evaluationState, 'insufficient_evidence');

  db.prepare(`INSERT INTO resources (runId,pageUrl,resourceUrl,resourceType,sizeBytes,sizeMeasurementKind,contentType,isThirdParty) VALUES (?, ?, ?, 'image', NULL, NULL, NULL, 0)`)
    .run(runId, 'https://availability.invalid/', 'https://availability.invalid/image');
  assert.equal(runCheck('tech.large_image_resources', { db, run, project }).evaluationState, 'insufficient_evidence');
  db.prepare(`UPDATE resources SET sizeBytes=400000,sizeMeasurementKind='observed_bytes',contentType='image/jpeg' WHERE runId=? AND resourceType='image'`).run(runId);
  assert.equal(runCheck('tech.large_image_resources', { db, run, project }).status, 'Warning');
  insertImage(db, runId, 'unknown-format', { altAttributePresent: 1, altValue: 'Image', altValueTrimmed: 'Image' });
  assert.equal(runCheck('tech.modern_image_format_coverage_low', { db, run, project }).evaluationState, 'insufficient_evidence');

  db.prepare('UPDATE pages SET ttfbMs=100 WHERE runId=?').run(runId);
  assert.equal(runCheck('tech.high_ttfb', { db, run, project }).evaluationState, 'insufficient_evidence');
  for (const [attempt, ttfbMs] of [[1, 100], [2, 110], [3, 120]]) {
    db.prepare(`INSERT INTO http_timing_measurements (runId,url,attempt,warmup,ttfbMs,location,measurementMode) VALUES (?, ?, ?, 0, ?, 'local', 'GET')`)
      .run(runId, 'https://availability.invalid/', attempt, ttfbMs);
  }
  db.prepare(`UPDATE http_timing_measurements SET location=NULL WHERE runId=? AND attempt=3`).run(runId);
  assert.equal(runCheck('tech.high_ttfb', { db, run, project }).evaluationState, 'insufficient_evidence');
  db.prepare(`UPDATE http_timing_measurements SET location='local' WHERE runId=? AND attempt=3`).run(runId);
  assert.equal(runCheck('tech.high_ttfb', { db, run, project }).status, 'OK');

  db.prepare(`INSERT INTO template_sample_results (runId,templateClusterKey,url,playwrightStatus,lighthouseStatus) VALUES (?, 'home', ?, 'success', 'success')`)
    .run(runId, 'https://availability.invalid/');
  db.prepare(`INSERT INTO lighthouse_results (runId,templateClusterKey,url,device,performanceScore) VALUES (?, 'home', ?, 'mobile', .9)`)
    .run(runId, 'https://availability.invalid/');
  db.prepare(`INSERT INTO template_performance_summary (runId,templateClusterKey,sampleCount,lighthouseSuccessCount,avgPerformanceScore,minPerformanceScore) VALUES (?, 'home', 1, 1, .9, .9)`).run(runId);
  assert.equal(runCheck('template.low_lighthouse_performance', { db, run, project }).evaluationState, 'insufficient_evidence');
  assert.equal(runCheck('template.high_lcp', { db, run, project }).evaluationState, 'insufficient_evidence');
  db.prepare(`INSERT INTO template_sample_results (runId,templateClusterKey,url,playwrightStatus,lighthouseStatus) VALUES (?, 'home', ?, 'success', 'success')`)
    .run(runId, 'https://availability.invalid/second');
  db.prepare(`INSERT INTO lighthouse_results (runId,templateClusterKey,url,device,performanceScore,largestContentfulPaintMs) VALUES (?, 'home', ?, 'mobile', .85, 4500)`)
    .run(runId, 'https://availability.invalid/second');
  db.prepare(`UPDATE lighthouse_results SET largestContentfulPaintMs=4400 WHERE runId=? AND url='https://availability.invalid/'`).run(runId);
  db.prepare(`UPDATE template_performance_summary SET sampleCount=2,lighthouseSuccessCount=2,avgPerformanceScore=.875,minPerformanceScore=.85,avgLcpMs=4450 WHERE runId=?`).run(runId);
  assert.equal(runCheck('template.low_lighthouse_performance', { db, run, project }).status, 'OK');
  assert.equal(runCheck('template.high_lcp', { db, run, project }).status, 'Error');
  db.prepare(`INSERT INTO lighthouse_results (runId,templateClusterKey,url,device,performanceScore,largestContentfulPaintMs) VALUES (?, 'home', ?, 'mobile', .1, 9000)`)
    .run(runId, 'https://availability.invalid/unexpected');
  assert.equal(runCheck('template.low_lighthouse_performance', { db, run, project }).evaluationState, 'technical_error');
  db.prepare(`DELETE FROM lighthouse_results WHERE runId=? AND url='https://availability.invalid/unexpected'`).run(runId);
  db.prepare(`UPDATE lighthouse_results SET device=NULL WHERE runId=? AND url='https://availability.invalid/second'`).run(runId);
  assert.equal(runCheck('template.high_lcp', { db, run, project }).evaluationState, 'technical_error');
  db.prepare(`UPDATE lighthouse_results SET device='mobile' WHERE runId=? AND url='https://availability.invalid/second'`).run(runId);

  db.prepare(`UPDATE pages SET renderStatus='technical_error', navigationError='timeout', consoleErrorsJson='[]' WHERE runId=?`).run(runId);
  assert.equal(runCheck('tech.console_errors_present', { db, run, project }).evaluationState, 'technical_error');
  insertMinimalPage(db, runId, 'https://availability.invalid/rendered', { renderStatus: 'success', consoleErrorsJson: JSON.stringify(['real console.error']) });
  const consoleResult = runCheck('tech.console_errors_present', { db, run, project });
  assert.equal(consoleResult.status, 'Warning');
  assert.equal(consoleResult.evidence.navigationErrorsExcluded, 1);
}));

test('runtime provenance is persisted in finding details and JSON exports', async () => withFixtureDb('provenance', async ({ db, makeRun }) => {
  const fixture = makeRun('https://provenance.invalid');
  insertMinimalPage(db, fixture.runId, 'https://provenance.invalid/');
  await runChecks(db, fixture.runId);
  const row = db.prepare('SELECT * FROM check_results WHERE runId=? ORDER BY id LIMIT 1').get(fixture.runId);
  const provenance = JSON.parse(row.provenanceJson);
  assert.equal(provenance.runId, fixture.runId);
  assert.equal(provenance.projectId, fixture.projectId);
  assert.equal(provenance.primaryHost, 'provenance.invalid');
  assert.equal(provenance.checkId, row.checkId);
  assert.ok(provenance.configHash);
  const detail = getCheckDetail(db, fixture.runId, row.id);
  assert.equal(detail.provenance.runId, fixture.runId);
  const exported = JSON.parse(collectFullAuditJson(db, fixture.runId, []).body);
  assert.ok(JSON.stringify(exported).includes('provenance.invalid'));
  assert.ok(JSON.stringify(exported).includes('configHash'));
}));

test('additive migration upgrades a legacy schema and keeps old runs readable without invented provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-legacy-migration-'));
  const dbPath = path.join(dir, 'legacy.sqlite');
  let db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const projectId = db.prepare("INSERT INTO projects (inputDomain,finalDomain) VALUES ('old.invalid','https://old.invalid')").run().lastInsertRowid;
  const runId = db.prepare("INSERT INTO runs (projectId,status,auditType,maxUrls,maxDepth,concurrency,respectRobotsTxt,currentPhase) VALUES (?,'completed','tech',1,0,1,0,'completed')").run(projectId).lastInsertRowid;
  db.exec('DROP INDEX IF EXISTS idx_runs_scoring_version; DROP INDEX IF EXISTS idx_check_results_run_root_cause;');
  for (const column of ['runtimeGitCommit', 'runtimeBuildVersion', 'runtimeConfigHash', 'runtimeProvenanceJson', 'scoringVersion', 'deduplicationVersion', 'coverageModelVersion', 'checkLogicVersion', 'scoreStatus', 'overallScore', 'techScore', 'geoScore', 'scoreBreakdownJson', 'scoreComputedAt']) {
    db.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
  }
  for (const column of ['checkVersion', 'provenanceJson', 'rootCauseId', 'rootCauseKey', 'rootCauseFamily', 'scopeType', 'occurrenceCount', 'affectedUrlCount', 'displayedSampleCount', 'primaryCheckId', 'deduplicationConfidence', 'deduplicationReason', 'rootCauseMembershipsJson']) db.exec(`ALTER TABLE check_results DROP COLUMN ${column}`);
  db.close();

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const old = getRunWithProject(db, runId);
  assert.equal(old.runtimeGitCommit, null);
  assert.equal(old.scoringVersion, null);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('check_results') WHERE name='provenanceJson'").get());
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('check_results') WHERE name='rootCauseMembershipsJson'").get());
  const provenance = buildCheckProvenance({ run: old, project: { id: Number(projectId), finalDomain: 'https://old.invalid' }, check: { id: 'tech.old', version: 1 }, result: { evaluationState: 'pass' } });
  assert.equal(provenance.gitCommit, null);
  assert.equal(provenance.runId, Number(runId));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function withFixtureDb(label, callback) {
  const temp = useTempAuditDb(label);
  const db = getDb();
  const makeRun = (domain, overrides = {}) => {
    const config = normalizeAuditConfig({ domain, maxUrls: 50, maxDepth: 2, ...overrides });
    const projectId = Number(createProject(db, { inputDomain: domain }));
    const runId = Number(createRun(db, projectId, config));
    db.prepare(`UPDATE projects SET finalDomain=? WHERE id=?`).run(domain, projectId);
    const run = getRunWithProject(db, runId);
    return { runId, projectId, run, project: { id: projectId, inputDomain: domain, finalDomain: domain } };
  };
  let output;
  try {
    output = callback({ db, makeRun });
  } catch (error) {
    temp.cleanup();
    throw error;
  }
  if (output && typeof output.then === 'function') return output.finally(() => temp.cleanup());
  temp.cleanup();
  return output;
}

function insertMinimalPage(db, runId, url, overrides = {}) {
  const row = {
    finalUrl: url,
    statusCode: 200,
    initialStatusCode: 200,
    redirectChainJson: JSON.stringify([{ url, statusCode: 200, location: null }]),
    contentType: 'text/html; charset=utf-8',
    indexable: 1,
    noindex: 0,
    nofollow: 0,
    title: `Title ${url}`,
    h1Count: 1,
    schemaTypesJson: JSON.stringify([]),
    pageType: 'other',
    wordCountRaw: 100,
    rawTextLength: 500,
    visibleTextLength: 500,
    renderStatus: 'not_executed',
    consoleErrorsJson: '[]',
    pageErrorsJson: '[]',
    requestFailuresJson: '[]',
    ...overrides
  };
  db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,redirectChainJson,
      contentType,indexable,noindex,nofollow,title,h1Count,schemaTypesJson,pageType,
      wordCountRaw,rawTextLength,visibleTextLength,renderStatus,consoleErrorsJson,pageErrorsJson,
      requestFailuresJson,metaRobots
    ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(runId, url, url, row.finalUrl, row.statusCode, row.initialStatusCode, row.redirectChainJson,
    row.contentType, row.indexable, row.noindex, row.nofollow, row.title, row.h1Count, row.schemaTypesJson,
    row.pageType, row.wordCountRaw, row.rawTextLength, row.visibleTextLength, row.renderStatus,
    row.consoleErrorsJson, row.pageErrorsJson, row.requestFailuresJson, row.metaRobots || null);
}

function insertImage(db, runId, name, values) {
  db.prepare(`
    INSERT INTO page_images (
      runId,pageUrl,imageUrl,alt,hasAlt,altAttributePresent,altValue,altValueTrimmed,
      likelyDecorativeImage,likelyBadgeImage,likelyTrackingPixel,likelyIcon,isDecorativeCandidate,imageRole
    ) VALUES (?, 'https://checks.invalid/source', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
  `).run(runId, `https://checks.invalid/${name}`, values.altValue, values.altValueTrimmed ? 1 : 0,
    values.altAttributePresent, values.altValue, values.altValueTrimmed, values.decorative || 0,
    values.decorative || 0, values.decorative ? 'decorative' : 'content');
}

function runCheck(id, ctx) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check.run(ctx);
}

function runGeoCheck(id, ctx) {
  const check = geoChecks().find((item) => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check.run(ctx);
}

function resultFixture(id, url) {
  return {
    id,
    category: 'Fixture',
    name: id,
    status: 'OK',
    priority: 'Low',
    effort: 'S',
    score: 10,
    finding: 'fixture pass',
    recommendation: '',
    affectedCount: 0,
    sampleUrls: [url],
    evidence: { url },
    evaluationState: 'pass',
    scoreEligible: true,
    provenance: { runId: null, checkVersion: '1' }
  };
}
