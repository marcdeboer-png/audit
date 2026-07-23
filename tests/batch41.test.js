import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runChecks } from '../src/checks/checkEngine.js';
import { initDatabase } from '../src/db/database.js';
import { detectPageType } from '../src/extractors/pageType.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';

test('check results persist only valid statuses and priorities', async () => {
  const db = setupDb();
  const runId = createRun(db, 'both');
  insertPage(db, runId, { url: 'https://example.com/', pageType: 'homepage' });

  await runChecks(db, runId);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM check_results WHERE runId = ? AND priority NOT IN ('High', 'Medium', 'Low', 'Info')").get(runId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM check_results WHERE runId = ? AND status NOT IN ('OK', 'Warning', 'Error', 'NA')").get(runId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM check_results WHERE runId = ? AND priority IN ('Warning', 'Error', 'OK')").get(runId).count, 0);
  db.close();
});

test('disabled llms-full.txt check is not executed for any asset state', async () => {
  const db = setupDb();
  const runId = createRun(db, 'geo');
  insertAsset(db, runId, 'llms', 'https://example.com/llms.txt', 200, '# Example\n\n## Documentation\n- [Home](https://example.com/)');
  insertAsset(db, runId, 'llms_full', 'https://example.com/llms-full.txt', 404, 'not found');

  await runChecks(db, runId);
  assert.equal(result(db, runId, 'geo.llms_txt_present').status, 'OK');
  assert.equal(result(db, runId, 'geo.llms_full_txt_present'), undefined);

  const referencedRunId = createRun(db, 'geo');
  insertAsset(db, referencedRunId, 'llms', 'https://example.com/llms.txt', 200, 'See https://example.com/llms-full.txt');
  insertAsset(db, referencedRunId, 'llms_full', 'https://example.com/llms-full.txt', 500, 'server error');
  await runChecks(db, referencedRunId);

  assert.equal(result(db, referencedRunId, 'geo.llms_full_txt_present'), undefined);

  const technicalRunId = createRun(db, 'geo');
  insertAsset(db, technicalRunId, 'llms', 'https://example.com/llms.txt', null, null);
  insertAsset(db, technicalRunId, 'llms_full', 'https://example.com/llms-full.txt', null, null);
  await runChecks(db, technicalRunId);
  assert.equal(result(db, technicalRunId, 'geo.llms_full_txt_present'), undefined);
  db.close();
});

test('an observed empty robots.txt body is not treated as missing evidence', async () => {
  const db = setupDb();
  const runId = createRun(db, 'geo');
  insertAsset(db, runId, 'robots', 'https://example.com/robots.txt', 200, '');

  await runChecks(db, runId);

  assert.equal(result(db, runId, 'geo.ai_bots_policy_summary').status, 'OK');
  const bot = result(db, runId, 'geo.robots_mentions_gptbot');
  assert.equal(bot.status, 'Warning');
  assert.equal(bot.priority, 'Low');
  assert.equal(bot.evaluationState, 'fail');
  assert.equal(bot.scoreEligible, 1);
  db.close();
});

test('page type detection separates index pages and conservative product/article details', () => {
  assert.equal(detectPageType({ url: 'https://example.com/blog' }), 'blog_index');
  assert.equal(detectPageType({ url: 'https://example.com/magazin' }), 'article_index');
  assert.equal(detectPageType({ url: 'https://example.com/category' }), 'category_index');
  assert.equal(detectPageType({ url: 'https://example.com/shop' }), 'product_index');
  assert.equal(detectPageType({ url: 'https://example.com/blog/post-one' }), 'other');
  assert.equal(detectPageType({ url: 'https://example.com/blog/post-one', rawHtml: '<article><h1>Post one</h1></article>' }), 'article');
  assert.notEqual(detectPageType({ url: 'https://example.com/leistungen/produktberatung', title: 'Produkt Beratung' }), 'product');
  assert.notEqual(detectPageType({ url: 'https://example.com/leistungen/seo/local-seo', title: 'Local SEO Agentur' }), 'location');
  assert.equal(detectPageType({
    url: 'https://example.com/produkt/widget-a',
    bodyText: 'Preis 29 Euro. In den Warenkorb',
    rawHtml: '<button>Add to cart</button>'
  }), 'product');
});

test('article and product schema checks ignore index or weak product pages', async () => {
  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/blog', pageType: 'blog_index' });
  insertPage(db, runId, { url: 'https://example.com/shop', pageType: 'product_index' });
  insertPage(db, runId, { url: 'https://example.com/leistungen/produktberatung', pageType: 'other' });

  await runChecks(db, runId);

  assert.equal(result(db, runId, 'tech.article_coverage_on_article_like_pages').status, 'NA');
  assert.equal(result(db, runId, 'tech.product_coverage_on_product_like_pages').status, 'NA');
  db.close();
});

test('FAQPage check distinguishes weak question hints from strong FAQ structures', async () => {
  const weak = extractHtml('<main><h1>Guide</h1><h2>What should I know?</h2><p>This is a rhetorical section.</p></main>', 'https://example.com/blog/post', 'https://example.com');
  const strong = extractHtml(`
    <section class="faq">
      <h2>FAQ</h2>
      <details><summary>What is A?</summary><p>A answer.</p></details>
      <details><summary>What is B?</summary><p>B answer.</p></details>
    </section>
  `, 'https://example.com/faq', 'https://example.com');
  assert.equal(weak.page.hasFaqPattern, 0);
  assert.equal(JSON.parse(weak.page.featureFlagsJson).hasWeakFaqPattern, true);
  assert.equal(strong.page.hasFaqPattern, 1);

  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/blog/post', pageType: 'article', hasFaqPattern: 0, featureFlags: { hasWeakFaqPattern: true } });
  await runChecks(db, runId);
  const faq = result(db, runId, 'tech.faqpage_missing_low_coverage');
  assert.equal(faq.status, 'NA');
  assert.equal(faq.priority, 'Low');
  assert.equal(faq.findingType, 'opportunity');
  assert.equal(faq.reviewRecommended, 1);
  db.close();
});

test('decorative badge images are not counted as normal missing alt issues', async () => {
  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/', pageType: 'homepage' });
  db.prepare(`
    INSERT INTO page_images (
      runId, pageUrl, imageUrl, alt, hasAlt, width, height, extension,
      likelyDecorativeImage, likelyBadgeImage, likelyTrackingPixel, likelyIcon, imageRole,
      altAttributePresent, altValue, altValueTrimmed, isDecorativeCandidate
    )
    VALUES (?, 'https://example.com/', 'https://badge.example/trust-badge.png', NULL, 0, '16', '16', '.png', 1, 1, 0, 0, 'badge', 0, NULL, NULL, 1)
  `).run(runId);

  await runChecks(db, runId);
  const alt = result(db, runId, 'tech.images_without_alt');
  assert.equal(alt.status, 'OK');
  assert.equal(JSON.parse(alt.evidenceJson).ignoredDecorativeImages, 1);
  db.close();
});

test('modern image coverage uses response Content-Type before URL extensions', async () => {
  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/', pageType: 'homepage' });
  db.prepare(`
    INSERT INTO resources (runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty, responseHeadersJson)
    VALUES
      (?, 'https://example.com/', 'https://example.com/image-a.jpg', 'image', 200, 12000, 'image/webp', 0, '{}'),
      (?, 'https://example.com/', 'https://example.com/image-b.png', 'image', 200, 14000, 'image/webp', 0, '{}')
  `).run(runId, runId);

  await runChecks(db, runId);
  const modern = result(db, runId, 'tech.modern_image_format_coverage_low');
  assert.equal(modern.status, 'OK');
  assert.equal(JSON.parse(modern.evidenceJson).basis, 'resource_content_type');
  db.close();
});

test('security headers are best-practice findings and schema checks expose grouping metadata', async () => {
  const db = setupDb();
  const runId = createRun(db, 'both');
  insertPage(db, runId, { url: 'https://example.com/blog/post', pageType: 'article' });

  await runChecks(db, runId);

  const hsts = result(db, runId, 'tech.hsts_header');
  assert.equal(hsts.category, 'Security Best Practice');
  assert.equal(hsts.findingType, 'best_practice');
  assert.notEqual(hsts.priority, 'High');

  const techArticle = result(db, runId, 'tech.article_coverage_on_article_like_pages');
  const geoArticle = result(db, runId, 'geo.article_blog_pages_article_schema');
  assert.equal(techArticle.reportGroupingKey, 'schema.article');
  assert.equal(geoArticle.reportGroupingKey, 'schema.article');

  const findingsHeader = collectCsvExport(db, runId, 'findings').split('\n')[0];
  assert.ok(findingsHeader.startsWith('checkId,title,category,displayStatus,displayPriority,displayFindingType,displayReviewStatus,displayActionStatus,affectedCount,recommendation,rawStatus,rawPriority,rawFindingType,confidence,reportSection,reviewRecommended,evidenceJson,sampleUrls'));
  assert.ok(findingsHeader.includes(',checkName,status,priority,effort,score,finding,details,evidence,'));
  assert.ok(findingsHeader.includes(',effectiveStatus,effectivePriority,effectiveEffort,effectiveFinding,effectiveRecommendation,'));
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db, auditType = 'both') {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain) VALUES ('example.com', 'https://example.com')").run().lastInsertRowid;
  return db.prepare(`
    INSERT INTO runs (projectId, status, auditType, maxUrls, maxDepth, concurrency, respectRobotsTxt, currentPhase)
    VALUES (?, 'completed', ?, 10, 2, 1, 0, 'completed')
  `).run(projectId, auditType).lastInsertRowid;
}

function insertAsset(db, runId, type, url, statusCode, content) {
  const contentType = 'text/plain; charset=utf-8';
  const metadata = statusCode === null
    ? {
        logicVersion: type === 'llms' ? 'llms-txt-validation-v1' : 'robots-sitemap-validation-v1',
        fetchError: 'fixture_network_error',
        measurementState: 'technical_error',
        measurementAttempts: [{ attempt: 1, method: 'GET', networkError: 'fixture_network_error' }]
      }
    : {
        logicVersion: type === 'llms' ? 'llms-txt-validation-v1' : 'robots-sitemap-validation-v1',
        initialStatusCode: statusCode,
        finalStatusCode: statusCode,
        finalUrl: url,
        redirectChain: [],
        contentType,
        sizeBytes: Buffer.byteLength(content || ''),
        truncated: false,
        utf8Valid: true,
        measurementState: 'confirmed',
        measurementAttempts: [{
          attempt: 1,
          method: 'GET',
          initialStatusCode: statusCode,
          finalStatusCode: statusCode,
          finalUrl: url,
          redirectChain: [],
          contentType,
          responseBytes: Buffer.byteLength(content || ''),
          truncated: false
        }]
      };
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson, metadataJson)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    type,
    url,
    statusCode,
    content,
    JSON.stringify({ 'content-type': contentType }),
    JSON.stringify(metadata)
  );
}

function insertPage(db, runId, {
  url,
  pageType = 'other',
  schemaTypes = [],
  hasFaqPattern = 0,
  featureFlags = {}
}) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, titleLength, metaDescription, metaDescriptionLength,
      h1Json, h1Count, h2Json, htmlLang, wordCountRaw, rawTextLength,
      rawHtmlSize, internalLinksCount, externalLinksCount, schemaTypesJson,
      imagesCount, imagesWithoutAltCount, responseHeadersJson, loadTimeMs,
      ttfbMs, consoleErrorsJson, renderedH1Json, renderedH1Count,
      renderedLinksCount, ogJson, featureFlagsJson, pageType, hasFaqPattern
    )
    VALUES (?, ?, ?, ?, 1, 200, 'text/html; charset=utf-8',
      1, 'Example Title', 13, 'Example description long enough for tests', 41,
      '["Example H1"]', 1, '[]', 'en', 120, 600,
      1000, 3, 1, ?,
      0, 0, '{}', 10,
      20, '[]', '[]', 0,
      3, '{}', ?, ?, ?)
  `).run(runId, url, url, url, JSON.stringify(schemaTypes), JSON.stringify(featureFlags), pageType, hasFaqPattern);
}

function result(db, runId, checkId) {
  return db.prepare('SELECT * FROM check_results WHERE runId = ? AND checkId = ?').get(runId, checkId);
}
