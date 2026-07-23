import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { createProject, createRun, getRunWithProject, insertCheckResults, updateProject } from '../src/db/repositories.js';
import { normalizeUrl } from '../src/utils/url.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { launchBrowser, renderPage } from '../src/extractors/renderExtractor.js';
import { techChecks } from '../src/checks/tech/index.js';
import { templatePatternChecks } from '../src/analysis/templatePatternChecks.js';
import { collectHeadMetadataPopulation, duplicateHeadGroups, normalizeHeadComparisonKey } from '../src/checks/headSemantics.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('raw head and heading extraction preserves multiplicity, visibility and accessible-name provenance', () => {
  const html = `<!doctype html><html lang="de-DE"><head>
    <title> One </title><title>Two</title>
    <meta name="description" content="First"><meta NAME="description" content="Second">
  </head><body>
    <span id="label">Labelled heading</span>
    <h1 hidden>Hidden</h1><div style="display:none"><h1>Ancestor hidden</h1></div>
    <h1 aria-labelledby="label"></h1><h1><img alt="Image heading"></h1>
    <h1><svg aria-label="SVG heading"><title>Ignored fallback</title></svg></h1>
  </body></html>`;
  const extracted = extractHtml(html, 'https://head.invalid/', 'head.invalid');
  const state = JSON.parse(extracted.page.rawDocumentStateJson);
  const flags = JSON.parse(extracted.page.featureFlagsJson);
  assert.deepEqual(state.titleValues, ['One', 'Two']);
  assert.deepEqual(state.metaDescriptionValues, ['First', 'Second']);
  assert.deepEqual(state.h1, ['Labelled heading', 'Image heading', 'SVG heading']);
  assert.equal(flags.titleElementCount, 2);
  assert.equal(flags.metaDescriptionElementCount, 2);
  assert.equal(flags.staticallyHiddenH1Count, 2);
  assert.deepEqual(state.h1Facts.filter((fact) => fact.visible).map((fact) => fact.nameSource), ['aria_labelledby', 'image_alt', 'svg_accessible_name']);
});

test('head extraction distinguishes missing elements from present empty values and ignores body title', () => {
  const empty = extractHtml(`<!doctype html><html><head><title>  </title><meta name="description" content="  "></head><body><title>Body title</title><h1>Heading</h1></body></html>`, 'https://empty.invalid/', 'empty.invalid');
  const emptyState = JSON.parse(empty.page.rawDocumentStateJson);
  assert.deepEqual(emptyState.titleValues, ['']);
  assert.deepEqual(emptyState.metaDescriptionValues, ['']);
  assert.equal(emptyState.title, null);
  assert.equal(emptyState.metaDescription, null);
  assert.equal(JSON.parse(empty.page.featureFlagsJson).titleElementCount, 1);

  const missing = extractHtml('<!doctype html><html><head></head><body><h1>Heading</h1></body></html>', 'https://missing.invalid/', 'missing.invalid');
  const missingState = JSON.parse(missing.page.rawDocumentStateJson);
  assert.deepEqual(missingState.titleValues, []);
  assert.deepEqual(missingState.metaDescriptionValues, []);
});

test('settled browser H1 extraction accepts image alt and aria-labelledby while excluding hidden headings', { timeout: 20000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Rendered names</title></head><body>
      <span id="heading-name">Accessible label</span><h1 hidden>Hidden</h1>
      <h1 aria-labelledby="heading-name"></h1><h1><img alt="Image name"></h1>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  if (!browser) {
    await new Promise((resolve) => server.close(resolve));
    t.skip('Chromium unavailable');
    return;
  }
  try {
    const result = await renderPage(browser, origin, '127.0.0.1', 5000, null, {
      settling: { maxDurationMs: 1200, intervalMs: 200, stableSnapshots: 3, minimumObservationMs: 600 }
    });
    const settled = JSON.parse(result.settledRenderedStateJson);
    assert.deepEqual(settled.h1, ['Accessible label', 'Image name']);
    assert.equal(settled.h1Facts.filter((fact) => fact.visible).length, 2);
    assert.equal(settled.h1Facts.find((fact) => !fact.visible).name, 'Hidden');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing and length checks fail closed on scope and use standard score metadata', () => {
  const fixture = makeFixture('https://scope.invalid');
  insertPage(fixture, '/title', { title: null, h1Count: 1 });
  insertPage(fixture, '/description', { metaDescription: null, h1Count: 1 });
  insertPage(fixture, '/heading', { h1Count: 0 });
  insertPage(fixture, '/redirect', { initialStatusCode: 301, title: null, h1Count: 0 });
  insertPage(fixture, '/error', { statusCode: 404, initialStatusCode: 404, title: null, h1Count: 0 });
  insertPage(fixture, '/unknown-indexability', { indexable: null, title: null, h1Count: 0 });
  const title = runTech('tech.title_missing', fixture);
  assert.equal(title.affectedCount, 1);
  assert.equal(title.status, 'Error');
  const description = runTech('tech.meta_description_missing', fixture);
  assert.equal(description.affectedCount, 1);
  assert.equal(description.priority, 'Low');
  assert.equal(description.scoreEligible, true);
  const h1 = runTech('tech.h1_missing', fixture);
  assert.equal(h1.affectedCount, 1);
  assert.equal(h1.status, 'Warning');
  assert.equal(h1.priority, 'Medium');
  assert.equal(h1.scoreEligible, true);
  fixture.db.prepare("UPDATE pages SET title='Tiny', titleLength=4 WHERE runId=? AND url LIKE '%/title'").run(fixture.runId);
  assert.equal(runTech('tech.title_too_short', fixture).scoreEligible, true);
  fixture.db.close();
});

test('duplicate grouping uses effective NFKC whitespace normalization and excludes consolidated pages', () => {
  const fixture = makeFixture('https://duplicates.invalid');
  insertPage(fixture, '/a', { title: 'Café   Guide', metaDescription: 'Same description' });
  insertPage(fixture, '/b', { title: 'Cafe\u0301 Guide', metaDescription: 'Same  description' });
  insertPage(fixture, '/canonical-copy', { title: 'Café Guide', canonical: 'https://duplicates.invalid/a' });
  insertPage(fixture, '/noindex', { title: 'Café Guide', indexable: 0 });
  const title = runTech('tech.duplicate_titles', fixture);
  assert.equal(title.affectedCount, 2);
  assert.equal(title.evidence.canonicalizedPagesExcluded, 1);
  assert.equal(title.evidence.duplicateGroups[0].count, 2);
  assert.equal(title.evidence.normalization, 'NFKC + collapsed whitespace + locale-independent case folding');
  const description = runTech('tech.duplicate_meta_descriptions', fixture);
  assert.equal(description.affectedCount, 2);
  assert.equal(description.scoreEligible, true);
  assert.equal(normalizeHeadComparisonKey(' Cafe\u0301  Guide '), normalizeHeadComparisonKey('CAFÉ Guide'));
  fixture.db.close();
});

test('duplicate totals are complete before ten displayed samples and detail uses identical grouping', () => {
  const fixture = makeFixture('https://samples.invalid');
  for (let group = 0; group < 15; group += 1) {
    for (let item = 0; item < 2; item += 1) insertPage(fixture, `/g-${group}-${item}`, { title: `Duplicate ${group}` });
  }
  const result = runTech('tech.duplicate_titles', fixture);
  assert.equal(result.affectedCount, 30);
  assert.equal(result.evidence.totalGroups, 15);
  assert.equal(result.evidence.displayedSamples, 10);
  insertCheckResults(fixture.db, fixture.runId, [result]);
  const checkRow = fixture.db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.duplicate_titles'").get(fixture.runId);
  const detail = getCheckDetail(fixture.db, fixture.runId, checkRow.id);
  assert.equal(detail.rows.length, 30);
  const full = JSON.parse(collectFullAuditJson(fixture.db, fixture.runId, []).body);
  assert.ok(full.checkDetails.some((entry) => entry.checkId === 'tech.duplicate_titles' && entry.rows.length === 30));
  assert.match(collectCsvExport(fixture.db, fixture.runId, 'findings'), /tech\.duplicate_titles/);
  const reportPath = generateReport(fixture.db, fixture.runId);
  const report = fs.readFileSync(reportPath, 'utf8');
  assert.match(report, /Duplicate titles/);
  assert.match(report, /totalGroups/);
  fs.rmSync(reportPath, { force: true });
  fixture.db.close();
});

test('template head patterns use complete effective state and homogeneous causes', () => {
  const fixture = makeFixture('https://patterns.invalid');
  for (let index = 0; index < 3; index += 1) {
    insertPage(fixture, `/rendered-${index}`, {
      title: null,
      effectiveTitle: `Rendered unique title ${index}`,
      rawDocumentStateJson: JSON.stringify({ title: null, canonicalValues: [] }),
      metadataProvenanceComplete: 1,
      templateClusterKey: 'rendered-template'
    });
  }
  assert.equal(runTemplate('template.title_pattern_issue', fixture).status, 'OK');
  for (let index = 0; index < 4; index += 1) {
    insertPage(fixture, `/missing-${index}`, {
      title: null,
      effectiveTitle: null,
      rawDocumentStateJson: JSON.stringify({ title: null, canonicalValues: [] }),
      metadataProvenanceComplete: 1,
      templateClusterKey: 'missing-template'
    });
  }
  const pattern = runTemplate('template.title_pattern_issue', fixture);
  assert.equal(pattern.status, 'Warning');
  assert.equal(pattern.scoreEligible, false);
  assert.equal(pattern.evidence.patterns[0].issueType, 'title_missing');
  assert.equal(pattern.evidence.patterns[0].evidenceCoverage, 1);
  assert.match(pattern.evidence.rootCauseCandidates[0].family, /title_pattern/);
  fixture.db.close();
});

test('effective rendered metadata prevents raw-only missing findings while unstable render remains unavailable', () => {
  const fixture = makeFixture('https://rendered.invalid', { usePlaywright: true, playwrightMode: 'all' });
  insertPage(fixture, '/settled', {
    title: null, metaDescription: null, h1Count: 0,
    effectiveTitle: 'Rendered title', effectiveMetaDescription: 'Rendered description', effectiveH1Count: 1,
    rawDocumentStateJson: JSON.stringify({ title: null, h1: [] }), metadataProvenanceComplete: 1,
    renderStatus: 'success', settlingStatus: 'settled'
  });
  assert.equal(runTech('tech.title_missing', fixture).status, 'OK');
  assert.equal(runTech('tech.meta_description_missing', fixture).status, 'OK');
  assert.equal(runTech('tech.h1_missing', fixture).status, 'OK');
  insertPage(fixture, '/unstable', {
    title: null, h1Count: 0, rawDocumentStateJson: JSON.stringify({ title: null, h1: [] }),
    metadataProvenanceComplete: 0, renderStatus: 'unstable', settlingStatus: 'rendering_unstable'
  });
  assert.equal(runTech('tech.title_missing', fixture).evaluationState, 'insufficient_evidence');
  fixture.db.close();
});

test('effective language accepts a settled rendered value and successful-HTML scope excludes error documents', () => {
  const fixture = makeFixture('https://language.invalid', { usePlaywright: true, playwrightMode: 'all' });
  insertPage(fixture, '/rendered-language', {
    htmlLang: null, effectiveHtmlLang: 'de-DE', rawDocumentStateJson: '{"htmlLang":null}',
    metadataProvenanceComplete: 1, renderStatus: 'success', settlingStatus: 'settled'
  });
  insertPage(fixture, '/missing-language', {
    htmlLang: null, effectiveHtmlLang: null, rawDocumentStateJson: '{"htmlLang":null}',
    metadataProvenanceComplete: 1
  });
  insertPage(fixture, '/error-document', {
    statusCode: 404, initialStatusCode: 404, htmlLang: null, effectiveHtmlLang: null,
    rawDocumentStateJson: '{"htmlLang":null}', metadataProvenanceComplete: 1
  });
  const language = runTech('tech.html_lang_missing', fixture);
  assert.equal(language.affectedCount, 1);
  assert.deepEqual(language.sampleUrls, ['https://language.invalid/missing-language']);

  const errorOnly = makeFixture('https://semantic-error.invalid');
  insertPage(errorOnly, '/404', { statusCode: 404, initialStatusCode: 404, h1Count: 0 });
  assert.equal(runTech('tech.html_semantics_summary', errorOnly).status, 'NA');
  errorOnly.db.close();
  fixture.db.close();
});

test('head population exposes incomplete and canonicalized observations without inventing values', () => {
  const fixture = makeFixture('https://population.invalid');
  insertPage(fixture, '/complete', { title: 'Complete', rawDocumentStateJson: '{}', effectiveTitle: 'Complete', metadataProvenanceComplete: 1 });
  insertPage(fixture, '/incomplete', { title: null, rawDocumentStateJson: '{}', effectiveTitle: null, metadataProvenanceComplete: 0 });
  const population = collectHeadMetadataPopulation(fixture.db, fixture.runId, fixture.project.finalDomain, 'title');
  assert.equal(population.total, 2);
  assert.equal(population.incomplete, 1);
  assert.equal(duplicateHeadGroups(population.rows).length, 0);
  fixture.db.close();
});

test('mixed legacy and effective head states cannot produce a silent missing-check pass', () => {
  const fixture = makeFixture('https://mixed-state.invalid');
  insertPage(fixture, '/current', {
    title: 'Current representative title', rawDocumentStateJson: '{"title":"Current representative title"}',
    effectiveTitle: 'Current representative title', effectiveH1Count: 1, effectiveH1Json: '["Current heading"]',
    metadataProvenanceComplete: 1
  });
  insertPage(fixture, '/legacy-without-provenance', {
    title: 'Legacy title', h1Count: 2, h1Json: '["One","Two"]', rawDocumentStateJson: null,
    effectiveTitle: null, metadataProvenanceComplete: 0
  });
  for (const id of ['tech.title_missing', 'tech.title_too_short', 'tech.h1_missing', 'tech.multiple_h1']) {
    const result = runTech(id, fixture);
    assert.equal(result.evaluationState, 'insufficient_evidence', id);
    assert.equal(result.requirements.missingFacts.includes('stableEffectiveDocumentState'), true, id);
  }
  fixture.db.close();
});

test('multiple-H1 detail parity preserves successful noindex inventory while missing-H1 keeps content scope', () => {
  const fixture = makeFixture('https://h1-detail.invalid');
  insertPage(fixture, '/noindex-multiple', { indexable: 0, h1Count: 2, h1Json: '["One","Two"]' });
  insertPage(fixture, '/noindex-missing', { indexable: 0, h1Count: 0, h1Json: '[]' });
  const multiple = runTech('tech.multiple_h1', fixture);
  assert.equal(multiple.affectedCount, 1);
  const missing = runTech('tech.h1_missing', fixture);
  assert.equal(missing.evaluationState, 'not_applicable');
  insertCheckResults(fixture.db, fixture.runId, [multiple]);
  const row = fixture.db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.multiple_h1'").get(fixture.runId);
  const detail = getCheckDetail(fixture.db, fixture.runId, row.id);
  assert.deepEqual(detail.rows.map((item) => item.url), ['https://h1-detail.invalid/noindex-multiple']);
  fixture.db.close();
});

function makeFixture(origin, overrides = {}) {
  const db = new Database(':memory:');
  initDatabase(db);
  const config = normalizeAuditConfig({
    domain: origin, auditType: 'both', maxUrls: 100, maxDepth: 1, concurrency: 1,
    respectRobotsTxt: false, usePlaywright: false, enableTemplateSampling: false,
    storeAllLinks: true, storeAllImages: true, storeAllResources: true, storeResponseHeaders: true,
    ...overrides
  });
  const projectId = createProject(db, { inputDomain: origin });
  const runId = createRun(db, projectId, config);
  updateProject(db, projectId, { finalDomain: origin, protocolBehaviorJson: '[]', wwwBehaviorJson: '{}', redirectChainJson: '[]' });
  const run = getRunWithProject(db, runId);
  return { db, runId, run, project: run };
}

function insertPage(fixture, path, overrides = {}) {
  const url = new URL(path, fixture.project.finalDomain).toString();
  const row = {
    statusCode: 200, initialStatusCode: 200, contentType: 'text/html', indexable: 1,
    title: 'Representative page title', metaDescription: 'Representative description for the page.',
    h1Count: 1, h1Json: '["Representative heading"]', canonical: normalizeUrl(url), htmlLang: 'en',
    pageType: 'other', pageTypeConfidence: 'high', renderStatus: 'not_executed', settlingStatus: 'not_executed',
    metadataProvenanceComplete: 0, rawDocumentStateJson: null, effectiveTitle: null,
    effectiveMetaDescription: null, effectiveHtmlLang: null, effectiveH1Count: null, effectiveH1Json: null, templateClusterKey: null,
    ...overrides
  };
  fixture.db.prepare(`INSERT INTO pages (
    runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,contentType,indexable,
    title,titleLength,metaDescription,metaDescriptionLength,h1Json,h1Count,canonical,htmlLang,
    pageType,pageTypeConfidence,renderStatus,settlingStatus,metadataProvenanceComplete,rawDocumentStateJson,
    effectiveTitle,effectiveMetaDescription,effectiveHtmlLang,effectiveH1Count,effectiveH1Json,templateClusterKey
  ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fixture.runId, url, normalizeUrl(url), normalizeUrl(url), row.statusCode, row.initialStatusCode, row.contentType, row.indexable,
    row.title, row.title?.length || 0, row.metaDescription, row.metaDescription?.length || 0, row.h1Json, row.h1Count,
    row.canonical, row.htmlLang, row.pageType, row.pageTypeConfidence, row.renderStatus, row.settlingStatus,
    row.metadataProvenanceComplete, row.rawDocumentStateJson, row.effectiveTitle, row.effectiveMetaDescription, row.effectiveHtmlLang,
    row.effectiveH1Count, row.effectiveH1Json, row.templateClusterKey
  );
}

function runTech(id, fixture) {
  const check = techChecks().find((candidate) => candidate.id === id);
  assert.ok(check, id);
  return check.run({ db: fixture.db, run: fixture.run, project: fixture.project });
}

function runTemplate(id, fixture) {
  const check = templatePatternChecks().find((candidate) => candidate.id === id);
  assert.ok(check, id);
  return check.run({ db: fixture.db, run: fixture.run, project: fixture.project });
}
