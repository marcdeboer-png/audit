import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import http from 'node:http';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, replacePageArtifacts } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { classifyPageType, hasArticleSchema, hasProductSchema } from '../src/extractors/pageType.js';
import {
  analyzeStructuredDataBlocks,
  collectSchemaEntities,
  isArticleSchemaType,
  isProductSchemaType,
  normalizeSchemaType,
  schemaTypeIsA
} from '../src/extractors/structuredData.js';
import { normalizeSchemasForStorage } from '../src/storage/retention.js';
import { launchBrowser, renderPage } from '../src/extractors/renderExtractor.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';

test('JSON-LD extraction handles objects, arrays, graphs, nested entities, IDs and multiple types', () => {
  const analysis = analyzeStructuredDataBlocks([
    { scriptType: 'application/ld+json', body: JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@id': '#article', '@type': ['BlogPosting', 'TechArticle'], headline: 'Escaped <title>', author: { '@id': '#author' } },
        { '@id': '#author', '@type': 'Person', name: 'Ada' },
        { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1 }] }
      ]
    }) },
    { scriptType: 'application/ld+json', body: JSON.stringify([
      { '@type': 'ProductGroup', name: 'Family' },
      { '@type': 'IndividualProduct', sku: 'A-1' }
    ]) }
  ], { source: 'raw' });
  assert.equal(analysis.blocksFound, 2);
  assert.equal(analysis.failedBlocks, 0);
  assert.deepEqual(analysis.types, ['BlogPosting', 'BreadcrumbList', 'IndividualProduct', 'ListItem', 'Person', 'ProductGroup', 'TechArticle']);
  const article = analysis.rows.find((row) => row.schemaType === 'BlogPosting');
  assert.equal(article.entityId, '#article');
  assert.equal(article.entityLinked, 1);
  assert.ok(JSON.parse(article.propertiesJson).includes('headline'));
  assert.ok(JSON.parse(article.referencedEntityIdsJson).includes('#author'));
  assert.equal(collectSchemaEntities(JSON.parse(analysis.blockBodies[0])).length, 4);
});

test('JSON-LD syntax states distinguish authored syntax errors, empty blocks, wrong script types and hydration JSON', () => {
  const analysis = analyzeStructuredDataBlocks([
    { scriptType: 'application/ld+json', body: '{"@type":"Article",}' },
    { scriptType: 'application/ld+json', body: '{/*comment*/"@type":"Article"}' },
    { scriptType: 'application/ld+json', body: '{“@type”:“Article”}' },
    { scriptType: 'application/ld+json', body: '{"@type":"Article"' },
    { scriptType: 'application/ld+json', body: '   ' },
    { scriptType: 'application/json', body: '{"@type":"Article"}' },
    { scriptType: '', body: 'window.__NEXT_DATA__={"@type":"Article"}' }
  ]);
  assert.equal(analysis.failedBlocks, 4);
  assert.equal(analysis.emptyBlocks, 1);
  assert.equal(analysis.blocksFound, 5);
  assert.ok(analysis.rows.filter((row) => row.parseStatus === 'error').every((row) => row.parseErrorType === 'json_syntax_error'));
  assert.ok(analysis.rows.filter((row) => row.parseStatus === 'error').every((row) => row.snippetHash?.length === 64));
  assert.deepEqual(JSON.parse(analysis.rows[0].extractionStatesJson), ['json_ld_block_found', 'json_ld_parse_failed']);
  assert.equal(analysis.rows[0].entityCompletenessStatus, 'not_evaluated');

  const extracted = extractHtml('<script type="application/json">{"@type":"Product"}</script><script>window.x={"@type":"Article"}</script>', 'https://fixture.invalid/', 'fixture.invalid');
  assert.equal(JSON.parse(extracted.page.structuredDataFactsJson).blocksFound, 0);
  assert.deepEqual(JSON.parse(extracted.page.schemaTypesJson), []);
});

test('schema hierarchy is exact, case-sensitive and recognises Article and Product subtypes', () => {
  for (const type of ['Article', 'BlogPosting', 'LiveBlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'Report', 'SocialMediaPosting']) {
    assert.equal(isArticleSchemaType(type), true, type);
  }
  for (const type of ['Product', 'ProductGroup', 'IndividualProduct', 'ProductModel', 'SomeProducts']) {
    assert.equal(isProductSchemaType(type), true, type);
  }
  assert.equal(hasArticleSchema(['https://schema.org/BlogPosting']), true);
  assert.equal(hasProductSchema(['schema:ProductGroup']), true);
  assert.equal(schemaTypeIsA('Corporation', 'Organization'), true);
  assert.equal(schemaTypeIsA('CollectionPage', 'WebPage'), true);
  assert.equal(isArticleSchemaType('blogposting'), false);
  assert.equal(isProductSchemaType('NotAProduct'), false);
  assert.equal(normalizeSchemaType('https://schema.org/Product/'), 'Product');
});

test('page-type classification excludes archives and product listings while retaining strong detail evidence', () => {
  assert.equal(classifyPageType({ url: 'https://example.invalid/blog/news', schemaTypes: ['BlogPosting'] }).pageType, 'blog_index');
  assert.equal(classifyPageType({ url: 'https://example.invalid/category/news', schemaTypes: ['Article'] }).pageType, 'category');
  assert.equal(classifyPageType({ url: 'https://example.invalid/themes/toys', schemaTypes: ['Product', 'ItemList'], bodyText: 'Add to cart €10' }).pageType, 'category');
  const article = classifyPageType({ url: 'https://example.invalid/blog/real-story', schemaTypes: ['NewsArticle'], rawHtml: '<article><h1>Story</h1></article>' });
  assert.deepEqual([article.pageType, article.confidence], ['article', 'high']);
  const product = classifyPageType({ url: 'https://example.invalid/us/product/widget', h1: ['Widget'], bodyText: 'Widget $499 Add to cart' });
  assert.deepEqual([product.pageType, product.confidence], ['product', 'high']);
  const slugOnly = classifyPageType({ url: 'https://example.invalid/p/ambiguous' });
  assert.deepEqual([slugOnly.pageType, slugOnly.confidence], ['product', 'medium']);
});

test('Article coverage accepts subtypes, excludes archives, uses rendered effective types and fails only high-confidence articles', () => {
  const fixture = setupRun('https://articles.invalid');
  addPage(fixture, '/article', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: ['Article'] });
  addPage(fixture, '/blog-post', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: ['BlogPosting'] });
  addPage(fixture, '/news', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: ['NewsArticle'] });
  addPage(fixture, '/rendered', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: [], effectiveSchemaTypes: ['TechArticle'] });
  addPage(fixture, '/missing', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: [] });
  addPage(fixture, '/ambiguous', { pageType: 'article', pageTypeConfidence: 'medium', schemaTypes: [] });
  addPage(fixture, '/archive', { pageType: 'blog_index', pageTypeConfidence: 'high', schemaTypes: [] });
  const tech = runTech(fixture, 'tech.article_coverage_on_article_like_pages');
  const geo = runGeo(fixture, 'geo.article_blog_pages_article_schema');
  assert.equal(tech.status, 'Warning');
  assert.equal(tech.affectedCount, 1);
  assert.deepEqual(tech.sampleUrls, ['https://articles.invalid/missing']);
  assert.equal(tech.evidence.uncertainCandidates, 1);
  assert.equal(geo.affectedCount, 1);
  assert.equal(geo.scoreEligible, false);
  assert.equal(tech.rootCauseKey, geo.rootCauseKey);
  assert.equal(tech.reportGroupingKey, geo.reportGroupingKey);
  fixture.db.close();
});

test('Product coverage accepts Product-family presence, excludes listing pages and does not treat Offer alone as Product', () => {
  const fixture = setupRun('https://products.invalid');
  addPage(fixture, '/p/direct', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: ['Product', 'Offer'] });
  addPage(fixture, '/p/group', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: ['ProductGroup'] });
  addPage(fixture, '/p/individual', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: ['IndividualProduct'] });
  addPage(fixture, '/p/model', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: ['ProductModel'] });
  addPage(fixture, '/p/offer-only', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: ['Offer'] });
  addPage(fixture, '/p/missing', { pageType: 'product', pageTypeConfidence: 'high', schemaTypes: [] });
  addPage(fixture, '/p/uncertain', { pageType: 'product', pageTypeConfidence: 'medium', schemaTypes: [] });
  addPage(fixture, '/category', { pageType: 'category', pageTypeConfidence: 'high', schemaTypes: ['Product', 'ItemList'] });
  const result = runTech(fixture, 'tech.product_coverage_on_product_like_pages');
  assert.equal(result.status, 'Warning');
  assert.equal(result.affectedCount, 2);
  assert.deepEqual(result.sampleUrls, ['https://products.invalid/p/offer-only', 'https://products.invalid/p/missing']);
  assert.equal(result.evidence.uncertainCandidates, 1);
  assert.equal(result.evidence.propertyCompletenessEvaluated, false);
  fixture.db.close();
});

test('parse-error check deduplicates raw/rendered copies and keeps technical extraction failures score-free', () => {
  const fixture = setupRun('https://syntax.invalid');
  addPage(fixture, '/broken', { structuredDataFacts: { raw: { blocksFound: 1 } } });
  for (const source of ['raw', 'rendered']) addSchema(fixture, '/broken', {
    source, parseStatus: 'error', snippetHash: 'same-hash', blockIndex: 0,
    parseErrorType: 'json_syntax_error', parseErrorPosition: 18, parseError: 'Unexpected token'
  });
  let result = runTech(fixture, 'tech.json_ld_parse_errors');
  assert.equal(result.status, 'Error');
  assert.equal(result.affectedCount, 1);
  assert.equal(result.priority, 'Medium');
  assert.equal(result.evidence.samples[0].source, 'raw');
  assert.match(result.rootCauseKey, /^structured_data\.json_ld_syntax\./);
  fixture.db.prepare('DELETE FROM schemas WHERE runId=?').run(fixture.runId);
  addSchema(fixture, '/broken', { source: 'rendered', parseStatus: 'technical_error', technicalError: 'browser closed' });
  result = runTech(fixture, 'tech.json_ld_parse_errors');
  assert.equal(result.evaluationState, 'technical_error');
  assert.equal(result.scoreEligible, false);
  fixture.db.close();
});

test('successful extraction without JSON-LD is not applicable and missing extraction provenance is not a pass', () => {
  const noBlocks = setupRun('https://none.invalid');
  addPage(noBlocks, '/', { structuredDataFacts: { raw: { blocksFound: 0 } } });
  assert.equal(runTech(noBlocks, 'tech.json_ld_parse_errors').evaluationState, 'not_applicable');
  noBlocks.db.close();

  const emptyBlock = setupRun('https://empty.invalid');
  addPage(emptyBlock, '/', { structuredDataFacts: { raw: { blocksFound: 1, parsedBlocks: 0, emptyBlocks: 1 } } });
  addSchema(emptyBlock, '/', { source: 'raw', parseStatus: 'empty' });
  const emptyResult = runTech(emptyBlock, 'tech.json_ld_parse_errors');
  assert.equal(emptyResult.evaluationState, 'not_applicable');
  assert.match(emptyResult.finding, /empty application\/ld\+json/);
  emptyBlock.db.close();

  const legacy = setupRun('https://legacy.invalid');
  addPage(legacy, '/');
  const result = runTech(legacy, 'tech.json_ld_parse_errors');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  legacy.db.close();
});

test('unknown indexability cannot become a schema-missing fail', () => {
  const fixture = setupRun('https://scope.invalid');
  const url = addPage(fixture, '/article/unknown', { pageType: 'article', pageTypeConfidence: 'high', schemaTypes: [] });
  fixture.db.prepare('UPDATE pages SET indexable=NULL WHERE runId=? AND url=?').run(fixture.runId, url);
  const tech = runTech(fixture, 'tech.article_coverage_on_article_like_pages');
  const geo = runGeo(fixture, 'geo.article_blog_pages_article_schema');
  assert.equal(tech.evaluationState, 'insufficient_evidence');
  assert.equal(tech.scoreEligible, false);
  assert.equal(tech.evidence.unknownIndexabilityCandidates, 1);
  assert.equal(geo.evaluationState, 'insufficient_evidence');
  fixture.db.close();
});

test('new schema persistence retains compact provenance but no complete foreign JSON-LD body and remains run-isolated', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  const a = setupRun('https://a.invalid', db);
  const b = setupRun('https://b.invalid', db);
  addPage(a, '/');
  addPage(b, '/');
  const raw = '{"@type":"Organization","sameAs":["https://social.invalid/a"],"name":"A"}';
  const analysis = analyzeStructuredDataBlocks([{ scriptType: 'application/ld+json', body: raw }]);
  replacePageArtifacts(db, a.runId, 'https://a.invalid/', { schemas: normalizeSchemasForStorage({}, analysis.rows) });
  replacePageArtifacts(db, b.runId, 'https://b.invalid/', { schemas: normalizeSchemasForStorage({}, analyzeStructuredDataBlocks([{ scriptType: 'application/ld+json', body: '{"@type":"Product"}' }]).rows) });
  const rows = db.prepare('SELECT * FROM schemas WHERE runId=?').all(a.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawJson, null);
  assert.equal(rows[0].snippetHash.length, 64);
  assert.equal(rows[0].rawJsonBytes, Buffer.byteLength(raw));
  assert.deepEqual(JSON.parse(rows[0].propertiesJson), ['name', 'sameAs']);
  assert.deepEqual(JSON.parse(rows[0].extractionStatesJson), ['json_ld_block_found', 'json_ld_parsed', 'schema_entity_extracted']);
  assert.equal(rows[0].entityCompletenessStatus, 'not_evaluated');
  assert.ok(rows.every((row) => row.pageUrl.startsWith('https://a.invalid/')));
  db.close();
});

test('browser extraction records rendered-only JSON-LD separately from raw evidence', async (t) => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('Playwright browser unavailable');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><main><h1>Rendered article</h1></main><script>
      setTimeout(() => { const s=document.createElement('script'); s.type='application/ld+json';
      s.textContent=JSON.stringify({'@type':'BlogPosting','headline':'Rendered'}); document.head.appendChild(s); }, 100);
    </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/article`;
  try {
    const raw = extractHtml(await fetch(url).then((response) => response.text()), url, '127.0.0.1');
    assert.deepEqual(JSON.parse(raw.page.schemaTypesJson), []);
    const rendered = await renderPage(browser, url, '127.0.0.1', 8000, null, {
      settling: { maxDurationMs: 1500, intervalMs: 100, stableSnapshots: 2, minimumObservationMs: 300, maxSnapshots: 10 }
    });
    assert.equal(rendered.renderStatus, 'success');
    assert.ok(rendered.renderedSchemas.some((row) => row.schemaType === 'BlogPosting' && row.source === 'rendered'));
    assert.ok(rendered.renderedStructuredDataFacts.schemaTypes.includes('BlogPosting'));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

function setupRun(domain, existingDb = null) {
  const db = existingDb || new Database(':memory:');
  if (!existingDb) initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run(domain, projectId);
  const runId = createRun(db, projectId, normalizeAuditConfig({ domain, auditType: 'both', maxUrls: 100, maxDepth: 0, concurrency: 1, usePlaywright: false }));
  return { db, projectId, runId, domain };
}

function addPage(fixture, path, options = {}) {
  const url = path.startsWith('http') ? path : new URL(path, fixture.domain).toString();
  fixture.db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,contentType,indexable,
      title,h1Json,h1Count,wordCountRaw,rawTextLength,visibleTextLength,textFactsJson,
      schemaTypesJson,effectiveSchemaTypesJson,structuredDataFactsJson,pageType,pageTypeConfidence,
      pageTypeSignalsJson,featureFlagsJson
    ) VALUES (?,?,?,?,0,200,200,'text/html; charset=utf-8',1,'Fixture','["Fixture"]',1,100,500,500,?,?,?,?,?,?,?,?)
  `).run(
    fixture.runId, url, url, url,
    JSON.stringify({ normalization_version: 'visible_text_v1', visible_text: { length: 500 } }),
    JSON.stringify(options.schemaTypes || []),
    JSON.stringify(options.effectiveSchemaTypes ?? options.schemaTypes ?? []),
    options.structuredDataFacts ? JSON.stringify(options.structuredDataFacts) : null,
    options.pageType || 'other', options.pageTypeConfidence || null,
    JSON.stringify(options.pageTypeSignals || []), JSON.stringify(options.featureFlags || {})
  );
  return url;
}

function addSchema(fixture, path, values) {
  const pageUrl = new URL(path, fixture.domain).toString();
  fixture.db.prepare(`
    INSERT INTO schemas (
      runId,pageUrl,schemaType,parseStatus,parseError,blockIndex,source,scriptType,bodyLength,
      snippetHash,parseErrorType,parseErrorPosition,technicalError,propertiesJson,
      referencedEntityIdsJson,entityLinked,extractionVersion
    ) VALUES (?,?,NULL,?,?,?,?,?,20,?,?,?,?,?,'[]',0,'structured-data-provenance-v1')
  `).run(
    fixture.runId, pageUrl, values.parseStatus, values.parseError || null,
    values.blockIndex ?? 0, values.source || 'raw', 'application/ld+json',
    values.snippetHash || null, values.parseErrorType || null, values.parseErrorPosition ?? null,
    values.technicalError || null, '[]'
  );
}

function runTech(fixture, id) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}

function runGeo(fixture, id) {
  const check = geoChecks().find((item) => item.id === id);
  assert.ok(check, id);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}
