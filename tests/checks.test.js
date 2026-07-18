import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { runChecks } from '../src/checks/checkEngine.js';
import { thresholds } from '../src/checks/config/thresholds.js';

test('threshold configuration is centralized and immutable', () => {
  assert.equal(thresholds.titleTooShort, 20);
  assert.equal(thresholds.titleTooLong, 65);
  assert.equal(thresholds.highTtfbMs, 800);
  assert.equal(Object.isFrozen(thresholds), true);
});

test('schema checks only apply to relevant page types and FAQ/video signals', async () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, { url: 'https://example.com/about', pageType: 'other' });

  await runChecks(db, runId);

  assert.equal(result(db, runId, 'tech.product_coverage_on_product_like_pages').status, 'NA');
  assert.equal(result(db, runId, 'tech.article_coverage_on_article_like_pages').status, 'NA');
  assert.equal(result(db, runId, 'tech.faqpage_missing_low_coverage').status, 'NA');
  assert.equal(result(db, runId, 'geo.faq_html_present_schema_missing').status, 'NA');
  assert.equal(result(db, runId, 'tech.videoobject_schema_present_missing').status, 'NA');
  db.close();
});

test('product, article and FAQ schema checks warn only for matching candidates', async () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, {
    url: 'https://example.com/shop/widget-a',
    pageType: 'product'
  });
  insertPage(db, runId, {
    url: 'https://example.com/blog/guide',
    pageType: 'article'
  });
  insertPage(db, runId, {
    url: 'https://example.com/faq',
    pageType: 'other',
    hasFaqPattern: 1
  });

  await runChecks(db, runId);

  const product = result(db, runId, 'tech.product_coverage_on_product_like_pages');
  const article = result(db, runId, 'tech.article_coverage_on_article_like_pages');
  const faqTech = result(db, runId, 'tech.faqpage_missing_low_coverage');
  const faqGeo = result(db, runId, 'geo.faq_html_present_schema_missing');
  assert.equal(product.status, 'Warning');
  assert.equal(product.affectedCount, 1);
  assert.equal(article.status, 'Warning');
  assert.equal(article.affectedCount, 1);
  assert.equal(faqTech.status, 'Warning');
  assert.equal(faqTech.affectedCount, 1);
  assert.equal(faqGeo.status, 'Warning');
  assert.equal(faqGeo.affectedCount, 1);
  db.close();
});

test('warning and error findings persist concrete evidence and capped samples', async () => {
  const db = setupDb();
  const runId = createRun(db);
  for (let i = 0; i < 12; i += 1) {
    insertPage(db, runId, {
      url: `https://example.com/missing-title-${i}`,
      pageType: 'other',
      title: '',
      h1Count: 0,
      schemaTypes: []
    });
  }

  await runChecks(db, runId);

  const rows = db.prepare(`
    SELECT checkId, status, affectedCount, sampleUrlsJson, evidenceJson
    FROM check_results
    WHERE runId = ? AND status IN ('Warning', 'Error')
  `).all(runId);

  assert.ok(rows.length > 0);
  for (const row of rows) {
    const evidence = JSON.parse(row.evidenceJson || '{}');
    const samples = JSON.parse(row.sampleUrlsJson || '[]');
    assert.ok(Object.keys(evidence).length > 0, row.checkId);
    assert.notDeepEqual(evidence, {}, row.checkId);
    assert.ok(samples.length <= 10, row.checkId);
    assert.ok(row.affectedCount >= 0, row.checkId);
  }
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db) {
  const project = db.prepare(`
    INSERT INTO projects (inputDomain, finalDomain, protocolBehaviorJson, wwwBehaviorJson, redirectChainJson)
    VALUES ('example.com', 'https://example.com', '[]', '{"candidates":[]}', '[]')
  `).run();
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, discoveredUrls, processedUrls,
      successfulUrls, failedUrls, skippedUrls
    )
    VALUES (?, 'completed', 'both', 100, 3, 1, 0, 'completed', 0, 0, 0, 0, 0)
  `).run(project.lastInsertRowid).lastInsertRowid;
}

function insertPage(db, runId, {
  url,
  pageType,
  title = 'Example page with a long enough title',
  h1Count = 1,
  schemaTypes = [],
  hasFaqPattern = 0
}) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, titleLength, h1Json, h1Count, h2Json,
      wordCountRaw, rawTextLength, rawHtmlSize, internalLinksCount,
      externalLinksCount, schemaTypesJson, imagesCount, imagesWithoutAltCount,
      responseHeadersJson, loadTimeMs, ttfbMs, consoleErrorsJson,
      renderedH1Json, renderedH1Count, renderedLinksCount, ogJson,
      featureFlagsJson, textFactsJson, pageType, hasFaqPattern
    )
    VALUES (
      @runId, @url, @url, @url, 1, 200, 'text/html; charset=utf-8',
      1, @title, @titleLength, '[]', @h1Count, '[]',
      250, 1500, 5000, 1,
      0, @schemaTypesJson, 0, 0,
      '{"content-type":"text/html; charset=utf-8"}', 10, 20, '[]',
      '[]', 0, 1, '{}',
      @featureFlagsJson, '{"normalization_version":"visible_text_v1","visible_text":{"length":1500}}', @pageType, @hasFaqPattern
    )
  `).run({
    runId,
    url,
    title,
    titleLength: title.length,
    h1Count,
    schemaTypesJson: JSON.stringify(schemaTypes),
    featureFlagsJson: JSON.stringify({
      articleElementCount: pageType === 'article' ? 1 : 0,
      articleLike: pageType === 'article',
      productLike: pageType === 'product'
    }),
    pageType,
    hasFaqPattern
  });
}

function result(db, runId, checkId) {
  return db.prepare('SELECT * FROM check_results WHERE runId = ? AND checkId = ?').get(runId, checkId);
}
