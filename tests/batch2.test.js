import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { deleteRun } from '../src/db/repositories.js';
import { collectCsvExport, csvEscape } from '../src/reports/csvExporter.js';
import { evaluateUrlPatterns, normalizeCrawlMode } from '../src/crawler/crawlConfig.js';
import { startAudit } from '../src/crawler/auditRunner.js';
import { getDb } from '../src/db/database.js';
import { useTempAuditDb } from './helpers/testDb.js';

const tempDb = useTempAuditDb('batch2');
after(() => tempDb.cleanup());

test('escapes CSV values according to RFC-style quoting', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a "quote"'), '"a ""quote"""');
  assert.equal(csvEscape('line\nbreak'), '"line\nbreak"');
});

test('CSV exports expose expected headers', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, 'https://example.com/');
  db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson
    )
    VALUES (?, 'tech.example', 'Tech', 'Example Check', 'Warning', 'Low', 'S', 5,
      'Finding, with comma', 'Details', 'Recommendation', 1, '["https://example.com/"]', '{"count":1}')
  `).run(runId);

  const findingsHeader = collectCsvExport(db, runId, 'findings').split('\n')[0];
  assert.ok(findingsHeader.startsWith('checkId,title,category,displayStatus,displayPriority,displayFindingType,displayReviewStatus,displayActionStatus,affectedCount,recommendation,rawStatus,rawPriority,rawFindingType,confidence,reportSection,reviewRecommended,evidenceJson,sampleUrls'));
  assert.ok(findingsHeader.includes(',checkName,status,priority,effort,score,finding,details,evidence,'));
  assert.ok(findingsHeader.includes(',reviewStatus,actionStatus,reviewerName,reviewNote,manualStatus,manualPriority,manualEffort,'));
  assert.equal(
    collectCsvExport(db, runId, 'pages').split('\n')[0],
    'url,finalUrl,statusCode,indexable,pageType,title,titleLength,metaDescription,metaDescriptionLength,h1Count,canonical,htmlLang,viewport,metaCharset,hasHeaderUtf8,hasMetaCharsetUtf8,metaRobots,xRobotsTag,wordCountRaw,wordCountRendered,internalLinksCount,externalLinksCount,schemaTypes,imagesCount,imagesWithoutAltCount,hasTables,hasLists,hasFaqPattern,hasVisibleDate,hasAuthorPattern,externalSourceLinksCount,hasVideoEmbed,loadTimeMs,ttfbMs'
  );
  assert.equal(
    collectCsvExport(db, runId, 'geo-signals').split('\n')[0],
    'url,pageType,hasTables,hasLists,hasFaqPattern,hasVisibleDate,hasAuthorPattern,externalSourceLinksCount,hasVideoEmbed,schemaTypes,hasOrganization,hasWebsite,hasBreadcrumbList,hasFAQPage,hasArticle,hasProduct,hasPerson,hasSpeakable'
  );
  db.close();
});

test('include and exclude patterns evaluate deterministically', () => {
  assert.equal(normalizeCrawlMode('sitemap_only'), 'sitemap_only');
  assert.equal(normalizeCrawlMode('template_sample'), 'template_sample');
  assert.equal(normalizeCrawlMode('bad'), 'hybrid');
  assert.deepEqual(
    evaluateUrlPatterns('https://example.com/blog/post', { includePatterns: ['blog'], excludePatterns: [] }),
    { allowed: true, reason: 'allowed' }
  );
  assert.equal(
    evaluateUrlPatterns('https://example.com/shop/item', { includePatterns: ['blog'], excludePatterns: [] }).allowed,
    false
  );
  assert.equal(
    evaluateUrlPatterns('https://example.com/private/item', { includePatterns: [], excludePatterns: ['/private/'] }).allowed,
    false
  );
});

test('crawlMode template_sample queues a small cross-section per sitemap URL template', async () => {
  const server = await startTemplateSitemapServer();
  try {
    const { runId } = await startAudit({
      domain: `localhost:${server.port}`,
      auditType: 'both',
      maxUrls: 20,
      maxDepth: 3,
      concurrency: 1,
      respectRobotsTxt: false,
      crawlMode: 'template_sample',
      sampleUrlsPerTemplate: 2,
      maxTemplateSamplesTotal: 20,
      usePlaywright: false,
      playwrightMode: 'off'
    }, { wait: true });
    const db = getDb();
    const urls = db.prepare('SELECT url FROM pages WHERE runId = ? ORDER BY url').all(runId).map((row) => row.url);
    assert.equal(urls.some((url) => url.includes('/p/product-1')), true);
    assert.equal(urls.some((url) => url.includes('/c/cat-1')), true);
    assert.equal(urls.some((url) => url.includes('/magazin/hund/article-1')), true);
    assert.equal(urls.filter((url) => url.includes('/p/product-')).length, 2);
    assert.equal(urls.filter((url) => url.includes('/c/cat-')).length, 2);
    assert.equal(urls.filter((url) => url.includes('/magazin/hund/article-')).length, 2);
    assert.equal(urls.some((url) => url.includes('/linked-only')), false);
  } finally {
    await server.close();
  }
});

test('deleteRun removes run-owned data', () => {
  const db = setupDb();
  const runId = createRun(db);
  insertPage(db, runId, 'https://example.com/');
  db.prepare("INSERT INTO crawl_queue (runId, url, normalizedUrl, depth, sourceType, status) VALUES (?, 'https://example.com/', 'https://example.com/', 0, 'seed', 'done')").run(runId);
  db.prepare("INSERT INTO run_logs (runId, level, message) VALUES (?, 'info', 'hello')").run(runId);
  assert.equal(deleteRun(db, runId), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE id = ?').get(runId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crawl_queue WHERE runId = ?').get(runId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_logs WHERE runId = ?').get(runId).count, 0);
  db.close();
});

test('crawlMode sitemap_only avoids internal link discovery and Playwright stays off', async () => {
  const server = await startMockServer();
  try {
    const { runId } = await startAudit({
      domain: `localhost:${server.port}`,
      auditType: 'both',
      maxUrls: 10,
      maxDepth: 3,
      concurrency: 1,
      respectRobotsTxt: false,
      crawlMode: 'sitemap_only',
      usePlaywright: false,
      playwrightMode: 'off'
    }, { wait: true });
    const db = getDb();
    const crawledUrls = db.prepare('SELECT url FROM pages WHERE runId = ? ORDER BY url').all(runId).map((row) => row.url);
    assert.ok(crawledUrls.some((url) => url.endsWith('/sitemap-page')));
    assert.equal(crawledUrls.some((url) => url.endsWith('/linked-only')), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_logs WHERE runId = ? AND message LIKE '%Playwright rendering unavailable%'").get(runId).count, 0);
  } finally {
    await server.close();
  }
});

test('crawlMode internal_links_only stores sitemaps but does not crawl sitemap-only URLs', async () => {
  const server = await startMockServer();
  try {
    const { runId } = await startAudit({
      domain: `localhost:${server.port}`,
      auditType: 'both',
      maxUrls: 10,
      maxDepth: 3,
      concurrency: 1,
      respectRobotsTxt: false,
      crawlMode: 'internal_links_only',
      usePlaywright: false,
      playwrightMode: 'off'
    }, { wait: true });
    const db = getDb();
    const crawledUrls = db.prepare('SELECT url FROM pages WHERE runId = ? ORDER BY url').all(runId).map((row) => row.url);
    assert.ok(crawledUrls.some((url) => url.endsWith('/linked-only')));
    assert.equal(crawledUrls.some((url) => url.endsWith('/sitemap-page')), false);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM domain_assets WHERE runId = ? AND type = 'sitemap'").get(runId).count > 0);
  } finally {
    await server.close();
  }
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain) VALUES ('example.com', 'https://example.com')").run().lastInsertRowid;
  return db.prepare(`
    INSERT INTO runs (projectId, status, auditType, maxUrls, maxDepth, concurrency, respectRobotsTxt, currentPhase)
    VALUES (?, 'completed', 'both', 10, 2, 1, 0, 'completed')
  `).run(projectId).lastInsertRowid;
}

function insertPage(db, runId, url) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, titleLength, metaDescription, metaDescriptionLength,
      h1Json, h1Count, h2Json, htmlLang, wordCountRaw, rawTextLength,
      rawHtmlSize, internalLinksCount, externalLinksCount, schemaTypesJson,
      imagesCount, imagesWithoutAltCount, responseHeadersJson, loadTimeMs,
      ttfbMs, consoleErrorsJson, renderedH1Json, renderedH1Count,
      renderedLinksCount, ogJson, featureFlagsJson, pageType
    )
    VALUES (?, ?, ?, ?, 0, 200, 'text/html; charset=utf-8',
      1, 'Example Title', 13, 'Example description', 19,
      '[]', 1, '[]', 'en', 100, 500,
      1000, 1, 0, '["Organization"]',
      0, 0, '{}', 10,
      20, '[]', '[]', 0,
      1, '{}', '{}', 'homepage')
  `).run(runId, url, url, url);
}

function startMockServer() {
  const server = http.createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`);
      return;
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset><url><loc>${host}/sitemap-page</loc></url></urlset>`);
      return;
    }
    if (['/llms.txt', '/llms-full.txt', '/index.md', '/index.md.txt', '/README.md'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const body = req.url === '/'
      ? '<a href="/linked-only">Linked Only</a>'
      : '<p>Leaf page</p>';
    res.end(`<!doctype html><html lang="en"><head><title>Mock ${req.url}</title><meta name="description" content="Mock page description long enough."><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Mock</h1>${body}</body></html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function startTemplateSitemapServer() {
  const server = http.createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`);
      return;
    }
    if (req.url === '/sitemap.xml') {
      const locs = [
        '/',
        '/p/product-1',
        '/p/product-2',
        '/p/product-3',
        '/p/product-4',
        '/c/cat-1',
        '/c/cat-2',
        '/c/cat-3',
        '/magazin/hund/article-1',
        '/magazin/hund/article-2',
        '/magazin/hund/article-3'
      ].map((path) => `<url><loc>${host}${path}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset>${locs}</urlset>`);
      return;
    }
    if (['/llms.txt', '/llms-full.txt', '/index.md', '/index.md.txt', '/README.md'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>${req.url}</title><meta name="description" content="Template sample fixture page."><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>${req.url}</h1><a href="/linked-only">Linked only</a></body></html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}
