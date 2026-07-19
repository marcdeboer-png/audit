import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, insertCheckResults } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import { templatePatternChecks } from '../src/analysis/templatePatternChecks.js';
import {
  canonicalHostRelationship,
  evaluateCanonicalPage,
  normalizeCanonicalComparable
} from '../src/checks/canonicalSemantics.js';
import { buildEffectiveDocumentState, createDocumentState } from '../src/extractors/documentState.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectCheckDetailCsv, collectFullAuditJson } from '../src/results/checkExportService.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('canonical URL normalization preserves meaningful differences and removes mechanical ones', () => {
  assert.equal(normalizeCanonicalComparable('/Path/%7eitem/#fragment', 'https://EXAMPLE.com:443/base'), 'https://example.com/Path/~item');
  assert.equal(normalizeCanonicalComparable('https://example.com/a/?b=2&a=1'), 'https://example.com/a?a=1&b=2');
  assert.notEqual(normalizeCanonicalComparable('https://example.com/index.html'), normalizeCanonicalComparable('https://example.com/'));
  assert.notEqual(normalizeCanonicalComparable('http://example.com/a'), normalizeCanonicalComparable('https://example.com/a'));
  assert.equal(canonicalHostRelationship('https://docs.example.co.uk/a', 'https://www.example.co.uk/').relationship, 'same_registrable_domain_subdomain');
  assert.equal(canonicalHostRelationship('https://example.com.evil.invalid/a', 'https://example.com/').relationship, 'cross_registrable_domain');
});

test('raw extraction preserves identical and conflicting canonical tag observations', () => {
  const identical = extractHtml('<html><head><link rel="canonical" href="/a/"><link rel="canonical" href="https://example.invalid/a"></head><body><main>ok</main></body></html>', 'https://example.invalid/a', 'example.invalid');
  const identicalState = JSON.parse(identical.page.rawDocumentStateJson);
  assert.deepEqual(identicalState.canonicalValues, ['https://example.invalid/a', 'https://example.invalid/a']);
  const identicalEvaluation = evaluateCanonicalPage({
    url: 'https://example.invalid/a', finalUrl: 'https://example.invalid/a',
    rawDocumentStateJson: identical.page.rawDocumentStateJson, canonical: identical.page.canonical
  }, 'https://example.invalid', false);
  assert.equal(identicalEvaluation.duplicateEquivalentTags, true);
  assert.equal(identicalEvaluation.conflict, false);

  const conflicting = extractHtml('<html><head><link rel="canonical" href="/a"><link rel="canonical" href="/b"></head><body><main>ok</main></body></html>', 'https://example.invalid/a', 'example.invalid');
  const evaluation = evaluateCanonicalPage({
    url: 'https://example.invalid/a', finalUrl: 'https://example.invalid/a',
    rawDocumentStateJson: conflicting.page.rawDocumentStateJson, canonical: conflicting.page.canonical
  }, 'https://example.invalid', false);
  assert.equal(evaluation.conflict, true);
  assert.deepEqual(evaluation.uniqueValues, ['https://example.invalid/a', 'https://example.invalid/b']);
});

test('canonical checks use effective state, final served URL and strict HTML scope', () => {
  const fixture = setupRun('https://example.invalid');
  addPage(fixture, '/self', { canonical: 'https://example.invalid/self/' });
  addPage(fixture, '/filter?color=blue', { canonical: 'https://example.invalid/filter' });
  addPage(fixture, '/legacy', { finalUrl: 'https://example.invalid/final', initialStatusCode: 301, canonical: 'https://example.invalid/final' });
  addPage(fixture, '/missing', { canonical: null });
  addPage(fixture, '/legal', { canonical: null, pageType: 'legal' });
  addPage(fixture, '/not-found', { canonical: null, statusCode: 404, initialStatusCode: 404, indexable: 0 });
  addPage(fixture, '/asset.json', { canonical: null, contentType: 'application/json' });
  addPage(fixture, '/conflict', { canonical: 'https://example.invalid/conflict', canonicalValues: ['https://example.invalid/conflict', 'https://example.invalid/elsewhere'] });
  addPage(fixture, '/rendered', { canonical: null, renderedCanonical: 'https://example.invalid/rendered' });
  const context = runContext(fixture);

  const missing = runTech('tech.canonical_missing', context);
  assert.equal(missing.affectedCount, 1);
  assert.deepEqual(missing.sampleUrls, ['https://example.invalid/missing']);
  const nonSelf = runTech('tech.canonical_non_self', context);
  assert.equal(nonSelf.affectedCount, 2);
  assert.deepEqual(nonSelf.sampleUrls.sort(), ['https://example.invalid/conflict', 'https://example.invalid/filter?color=blue']);
  assert.equal(nonSelf.scoreEligible, false);
  assert.equal(nonSelf.evidence.samples.find((row) => row.url.endsWith('/conflict')).issueType, 'conflicting_canonical_tags');
  fixture.db.close();
});

test('cross-registrable-domain canonical is measured without treating intent as an automatic defect', () => {
  const fixture = setupRun('https://example.co.uk');
  addPage(fixture, '/self', { canonical: 'https://www.example.co.uk/self' });
  addPage(fixture, '/docs', { canonical: 'https://docs.example.co.uk/docs' });
  addPage(fixture, '/syndicated', { canonical: 'https://publisher.invalid/original' });
  addPage(fixture, '/prefix-trap', { canonical: 'https://example.co.uk.evil.invalid/trap' });
  const result = runTech('tech.canonical_to_other_domain', runContext(fixture));
  assert.equal(result.affectedCount, 2);
  assert.equal(result.scoreEligible, false);
  assert.equal(result.reviewRecommended, true);
  assert.deepEqual(result.sampleUrls.sort(), ['https://example.co.uk/prefix-trap', 'https://example.co.uk/syndicated']);
  fixture.db.close();
});

test('canonical target status keeps initial redirects, final status and technical unknowns separate', () => {
  const fixture = setupRun('https://target.invalid');
  addPage(fixture, '/direct-source', { canonical: 'https://target.invalid/direct' });
  addPage(fixture, '/direct', { canonical: 'https://target.invalid/direct' });
  addPage(fixture, '/redirect-source', { canonical: 'https://target.invalid/alias' });
  addPage(fixture, '/alias', { finalUrl: 'https://target.invalid/final', initialStatusCode: 308, statusCode: 200, canonical: 'https://target.invalid/final', redirectChain: [{ statusCode: 308, url: 'https://target.invalid/alias', location: '/final' }, { statusCode: 200, url: 'https://target.invalid/final' }] });
  addPage(fixture, '/final', { canonical: 'https://target.invalid/final' });
  addPage(fixture, '/final-source', { canonical: 'https://target.invalid/final' });
  addPage(fixture, '/broken-source', { canonical: 'https://target.invalid/broken' });
  addPage(fixture, '/broken', { statusCode: 404, initialStatusCode: 404, indexable: 0, canonical: null });
  addPage(fixture, '/gone-source', { canonical: 'https://target.invalid/gone' });
  addPage(fixture, '/gone', { statusCode: 410, initialStatusCode: 410, indexable: 0, canonical: null });
  addPage(fixture, '/server-source', { canonical: 'https://target.invalid/server-error' });
  addPage(fixture, '/server-error', { statusCode: 500, initialStatusCode: 500, indexable: 0, canonical: null });
  addPage(fixture, '/json-source', { canonical: 'https://target.invalid/data' });
  addPage(fixture, '/data', { contentType: 'application/json', canonical: null });
  const result = runTech('tech.canonical_target_non_200', runContext(fixture));
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 5);
  assert.deepEqual(result.evidence.samples.map((row) => row.issueType).sort(), ['canonical_target_non_200', 'canonical_target_non_200', 'canonical_target_non_200', 'canonical_target_non_html', 'canonical_target_redirect']);
  const redirect = result.evidence.samples.find((row) => row.issueType === 'canonical_target_redirect');
  assert.equal(redirect.initialStatus, 308);
  assert.equal(redirect.finalStatus, 200);
  assert.equal(redirect.finalUrl, 'https://target.invalid/final');

  insertCheckResults(fixture.db, fixture.runId, [result]);
  const row = fixture.db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.canonical_target_non_200'").get(fixture.runId);
  const detail = getCheckDetail(fixture.db, fixture.runId, row.id);
  assert.equal(detail.rows.length, 5);
  assert.equal(detail.rows.find((item) => item.issueType === 'canonical_target_redirect').canonicalTargetInitialStatus, 308);
  const csv = collectCheckDetailCsv(fixture.db, fixture.runId, row.id).csv;
  assert.match(csv, /Canonical Target Initial Status/);
  assert.match(csv, /canonical_target_redirect/);
  const exported = JSON.parse(collectFullAuditJson(fixture.db, fixture.runId, ['findings', 'pages']).body);
  const exportedDetail = exported.checkDetails.find((item) => item.checkId === 'tech.canonical_target_non_200');
  assert.equal(exportedDetail.rows.length, 5);
  assert.equal(exportedDetail.rows.find((item) => item.issueType === 'canonical_target_redirect').canonicalTargetInitialStatus, 308);
  const reportPath = generateReport(fixture.db, fixture.runId);
  const report = fs.readFileSync(reportPath, 'utf8');
  assert.match(report, /Canonical target non-200 if known/);
  assert.match(report, /initially|initial/i);
  fs.rmSync(reportPath, { force: true });
  fixture.db.close();
});

test('unknown or historically incomplete target measurements are insufficient evidence', () => {
  const fixture = setupRun('https://unknown.invalid');
  addPage(fixture, '/internal', { canonical: 'https://unknown.invalid/not-crawled' });
  addPage(fixture, '/external', { canonical: 'https://publisher.invalid/original' });
  const result = runTech('tech.canonical_target_non_200', runContext(fixture));
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.evidence.unmeasuredTargets.length, 2);
  assert.deepEqual(result.evidence.unmeasuredTargets.map((row) => row.canonical).sort(), [
    'https://publisher.invalid/original',
    'https://unknown.invalid/not-crawled'
  ]);
  fixture.db.close();

  const historical = setupRun('https://historical.invalid');
  addPage(historical, '/source', { canonical: 'https://historical.invalid/target' });
  addPage(historical, '/target');
  historical.db.prepare("UPDATE pages SET initialStatusCode=NULL WHERE runId=? AND url='https://historical.invalid/target'").run(historical.runId);
  const historicalResult = runTech('tech.canonical_target_non_200', runContext(historical));
  assert.equal(historicalResult.evaluationState, 'insufficient_evidence');
  assert.ok(historicalResult.evidence.unmeasuredTargets.some((row) => row.reason === 'initial target status was not retained'));
  historical.db.close();

  const missingFinal = setupRun('https://missing-final.invalid');
  addPage(missingFinal, '/source', { canonical: 'https://missing-final.invalid/target' });
  addPage(missingFinal, '/target');
  missingFinal.db.prepare("UPDATE pages SET statusCode=NULL WHERE runId=? AND url='https://missing-final.invalid/target'").run(missingFinal.runId);
  const missingFinalResult = runTech('tech.canonical_target_non_200', runContext(missingFinal));
  assert.equal(missingFinalResult.evaluationState, 'insufficient_evidence');
  assert.ok(missingFinalResult.evidence.unmeasuredTargets.some((row) => row.reason === 'canonical target was not measured'));
  missingFinal.db.close();
});

test('canonical pattern requires homogeneous cause, minimum sample, evidence coverage and run isolation', () => {
  const fixture = setupRun('https://patterns.invalid');
  for (let index = 0; index < 20; index += 1) addPage(fixture, `/outlier-${index}`, { canonical: index === 0 ? null : `https://patterns.invalid/outlier-${index}`, templateClusterKey: 'outlier-template' });
  for (let index = 0; index < 20; index += 1) addPage(fixture, `/two-outliers-${index}`, { canonical: index < 2 ? null : `https://patterns.invalid/two-outliers-${index}`, templateClusterKey: 'two-outliers-template' });
  for (let index = 0; index < 2; index += 1) addPage(fixture, `/small-${index}`, { canonical: null, templateClusterKey: 'small-template' });
  for (let index = 0; index < 6; index += 1) addPage(fixture, `/majority-${index}`, { canonical: index < 4 ? null : `https://patterns.invalid/majority-${index}`, templateClusterKey: 'majority-template' });
  for (let index = 0; index < 6; index += 1) addPage(fixture, `/mixed-${index}`, { canonical: index < 3 ? null : 'https://patterns.invalid/consolidated', templateClusterKey: 'mixed-template' });
  for (let index = 0; index < 15; index += 1) addPage(fixture, `/full-${index}`, { canonical: null, templateClusterKey: 'full-template' });
  addPage(fixture, '/incomplete-1', { canonical: null, templateClusterKey: 'incomplete-template', metadataComplete: 0 });
  addPage(fixture, '/incomplete-2', { canonical: null, templateClusterKey: 'incomplete-template', metadataComplete: 0 });
  addPage(fixture, '/incomplete-3', { canonical: null, templateClusterKey: 'incomplete-template' });

  const other = setupRun('https://foreign.invalid', fixture.db);
  for (let index = 0; index < 8; index += 1) addPage(other, `/foreign-${index}`, { canonical: null, templateClusterKey: 'outlier-template' });

  const result = runTemplate('template.canonical_pattern_issue', runContext(fixture));
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 25);
  const patterns = result.evidence.patterns;
  assert.equal(patterns.some((row) => row.patternKey === 'outlier-template'), false);
  assert.equal(patterns.some((row) => row.patternKey === 'two-outliers-template'), false);
  assert.equal(patterns.some((row) => row.patternKey === 'small-template'), false);
  assert.equal(patterns.some((row) => row.patternKey === 'incomplete-template'), false);
  assert.equal(patterns.filter((row) => row.patternKey === 'mixed-template').length, 2);
  assert.equal(patterns.find((row) => row.patternKey === 'full-template').affectedCount, 15);
  assert.equal(patterns.find((row) => row.patternKey === 'full-template').sampleUrls.length, 10);
  assert.equal(result.scoreEligible, false);
  fixture.db.close();
});

function setupRun(domain, existingDb = null) {
  const db = existingDb || new Database(':memory:');
  if (!existingDb) initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run(domain, projectId);
  const runId = createRun(db, projectId, normalizeAuditConfig({ domain, auditType: 'tech', maxUrls: 100, maxDepth: 0, concurrency: 1, usePlaywright: false }));
  return { db, projectId, runId, domain };
}

function addPage(fixture, path, options = {}) {
  const url = path.startsWith('http') ? path : new URL(path, fixture.domain).toString();
  const finalUrl = options.finalUrl || url;
  const canonical = options.canonical === undefined ? finalUrl : options.canonical;
  const canonicalValues = options.canonicalValues ?? (canonical ? [canonical] : []);
  const raw = createDocumentState({ canonical, canonicalValues, title: 'Fixture', h1: ['Fixture'], visibleText: 'fixture content', mainText: 'fixture content' }, { url: finalUrl, source: 'raw_html', snapshotId: 'raw' });
  let effective = buildEffectiveDocumentState(raw, null, null, { renderStatus: 'not_executed', settlingStatus: 'not_executed' });
  let effectiveCanonical = canonical;
  if (Object.hasOwn(options, 'renderedCanonical')) {
    const rendered = createDocumentState({ canonical: options.renderedCanonical, canonicalValues: options.renderedCanonical ? [options.renderedCanonical] : [], title: 'Fixture', h1: ['Fixture'], visibleText: 'fixture content', mainText: 'fixture content' }, { url: finalUrl, source: 'settling_rendered_dom', snapshotId: 'settled' });
    effective = buildEffectiveDocumentState(raw, rendered, rendered, { renderStatus: 'success', settlingStatus: 'settled' });
    effectiveCanonical = options.renderedCanonical;
  }
  fixture.db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,redirectChainJson,
      contentType,indexable,noindex,nofollow,title,h1Json,h1Count,canonical,pageType,
      rawDocumentStateJson,effectiveDocumentStateJson,effectiveCanonical,
      metadataProvenanceComplete,renderStatus,settlingStatus,templateClusterKey
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    fixture.runId, url, normalizeCanonicalComparable(url), finalUrl, 0,
    options.statusCode ?? 200, options.initialStatusCode ?? options.statusCode ?? 200,
    JSON.stringify(options.redirectChain || []), options.contentType || 'text/html; charset=utf-8',
    options.indexable ?? 1, 0, 0, 'Fixture', '["Fixture"]', 1, canonical,
    options.pageType || 'other', JSON.stringify(raw), JSON.stringify(effective), effectiveCanonical,
    options.metadataComplete ?? 1, Object.hasOwn(options, 'renderedCanonical') ? 'success' : 'not_executed',
    Object.hasOwn(options, 'renderedCanonical') ? 'settled' : 'not_executed', options.templateClusterKey || null
  );
  return url;
}

function runContext(fixture) {
  const run = getRunWithProject(fixture.db, fixture.runId);
  return { db: fixture.db, run, project: run };
}

function runTech(id, context) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, id);
  return check.run.call(check, context);
}

function runTemplate(id, context) {
  const check = templatePatternChecks().find((item) => item.id === id);
  assert.ok(check, id);
  return check.run.call(check, context);
}
