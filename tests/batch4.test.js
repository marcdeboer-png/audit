import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildTemplateClusters, urlPatternForPage } from '../src/analysis/templateClusterer.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { discoverDomainAssets, extractLocValues, isSitemapIndex } from '../src/crawler/sitemap.js';
import { getConfiguredDbPath, getDb, initDatabase, closeDb } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, insertPage, listTemplateClusters } from '../src/db/repositories.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { shardKeyForUrl, shardForUrl } from '../src/queue/sqliteQueue.js';

test('AUDIT_DB_PATH is respected and databases are isolated by path', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-db-b-'));
  const previous = process.env.AUDIT_DB_PATH;
  try {
    process.env.AUDIT_DB_PATH = path.join(dirA, 'audit.sqlite');
    let db = getDb();
    db.prepare("INSERT INTO projects (inputDomain) VALUES ('a.example')").run();
    assert.equal(getConfiguredDbPath(), path.join(dirA, 'audit.sqlite'));
    closeDb();

    process.env.AUDIT_DB_PATH = path.join(dirB, 'audit.sqlite');
    db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 0);
    db.prepare("INSERT INTO projects (inputDomain) VALUES ('b.example')").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, 1);
    closeDb();
  } finally {
    if (previous === undefined) delete process.env.AUDIT_DB_PATH;
    else process.env.AUDIT_DB_PATH = previous;
    closeDb();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('sitemap helpers extract loc values and detect sitemap indexes', () => {
  const xml = '<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>';
  assert.equal(isSitemapIndex(xml), true);
  assert.deepEqual(extractLocValues('<urlset><url><loc>https://example.com/a&amp;b=1</loc></url></urlset>'), ['https://example.com/a&b=1']);
});

test('sitemap processing queues normal, index and gzip sitemaps with limits', async () => {
  await withSitemapServer({
    '/sitemap.xml': sitemapXml(['/', '/blog/a', '/blog/b'])
  }, async ({ origin }) => {
    const db = setupDb();
    const run = createRunRow(db, { maxUrls: 10, sitemapBatchSize: 2 });
    await discoverDomainAssets(db, run, `${origin}/`);
    assert.equal(queueUrls(db, run.id).length, 3);
    assert.equal(getRunWithProject(db, run.id).sitemapUrlsQueued, 3);
    db.close();
  });

  await withSitemapServer({
    '/sitemap.xml': sitemapIndexXml(['/sitemap-a.xml', '/sitemap-b.xml']),
    '/sitemap-a.xml': sitemapXml(['/a']),
    '/sitemap-b.xml': sitemapXml(['/b'])
  }, async ({ origin }) => {
    const db = setupDb();
    const run = createRunRow(db, { maxUrls: 10, maxSitemaps: 3 });
    await discoverDomainAssets(db, run, `${origin}/`);
    assert.deepEqual(queueUrls(db, run.id).map((url) => new URL(url).pathname).sort(), ['/a', '/b']);
    assert.equal(getRunWithProject(db, run.id).sitemapFilesProcessed, 3);
    db.close();
  });

  await withSitemapServer({
    '/sitemap.xml': {
      body: (origin) => zlib.gzipSync(sitemapXml(['/gz-a', '/gz-b']).replaceAll('__ORIGIN__', origin)),
      headers: { 'content-type': 'application/gzip' }
    }
  }, async ({ origin }) => {
    const db = setupDb();
    const run = createRunRow(db, { maxUrls: 10 });
    await discoverDomainAssets(db, run, `${origin}/`);
    assert.deepEqual(queueUrls(db, run.id).map((url) => new URL(url).pathname).sort(), ['/gz-a', '/gz-b']);
    db.close();
  });

  await withSitemapServer({
    '/sitemap.xml': sitemapXml(['/a', '/b', '/c'])
  }, async ({ origin }) => {
    const db = setupDb();
    const run = createRunRow(db, { maxUrls: 10, maxSitemapUrls: 2 });
    await discoverDomainAssets(db, run, `${origin}/`);
    assert.equal(queueUrls(db, run.id).length, 2);
    assert.equal(getRunWithProject(db, run.id).sitemapUrlsDiscovered, 2);
    db.close();
  });

  await withSitemapServer({
    '/sitemap.xml': sitemapIndexXml(['/sitemap-a.xml']),
    '/sitemap-a.xml': sitemapXml(['/a'])
  }, async ({ origin }) => {
    const db = setupDb();
    const run = createRunRow(db, { maxUrls: 10, maxSitemaps: 1 });
    await discoverDomainAssets(db, run, `${origin}/`);
    assert.equal(queueUrls(db, run.id).length, 0);
    assert.equal(getRunWithProject(db, run.id).sitemapFilesProcessed, 1);
    db.close();
  });
});

test('template clustering stores clusters, page mappings and deterministic samples', () => {
  const db = setupDb();
  const run = createRunRow(db);
  insertTestPage(db, run.id, { url: 'https://example.com/blog/first-post', pageType: 'article', schemaTypes: ['Article'], wordCountRaw: 120 });
  insertTestPage(db, run.id, { url: 'https://example.com/blog/second-post', pageType: 'article', schemaTypes: [], wordCountRaw: 40 });
  insertTestPage(db, run.id, { url: 'https://example.com/produkt/widget-a', pageType: 'product', schemaTypes: ['Product'], wordCountRaw: 300 });

  assert.equal(urlPatternForPage({ url: 'https://example.com/blog/hello-world', pageType: 'article', schemaTypes: ['Article'] }), '/blog/{slug}');
  assert.equal(urlPatternForPage({ url: 'https://example.com/produkt/widget-a', pageType: 'product', schemaTypes: ['Product'] }), '/produkt/{slug}');

  const summary = buildTemplateClusters(db, run.id, { sampleUrlsPerTemplate: 2, maxTemplateSamplesTotal: 10 });
  assert.equal(summary.clusters, 2);

  const clusters = listTemplateClusters(db, run.id);
  const blog = clusters.find((cluster) => cluster.urlPattern === '/blog/{slug}');
  assert.equal(blog.urlCount, 2);
  assert.deepEqual(blog.schemaTypesSummary, { Article: 1 });
  assert.equal(blog.sampleUrls.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND templateClusterKey IS NOT NULL AND templateClusterId IS NOT NULL").get(run.id).count, 3);

  const csv = collectCsvExport(db, run.id, 'templates');
  assert.equal(csv.split('\n')[0], 'clusterKey,pageType,urlPattern,urlCount,indexableCount,nonIndexableCount,statusCodeSummary,schemaTypesSummary,avgWordCount,avgInternalLinks,avgExternalLinks,sampleUrls');
  db.close();
});

test('shard keys are deterministic', () => {
  assert.equal(shardKeyForUrl('https://example.com/blog/a'), 'example.com/blog');
  assert.deepEqual(shardForUrl('https://example.com/blog/a', 8), shardForUrl('https://example.com/blog/b', 8));
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRunRow(db, overrides = {}) {
  const projectId = createProject(db, { inputDomain: 'example.com' });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'example.com',
    auditType: 'both',
    maxUrls: 50,
    maxDepth: 2,
    concurrency: 1,
    respectRobotsTxt: false,
    usePlaywright: false,
    ...overrides
  }));
  return getRunWithProject(db, runId);
}

function insertTestPage(db, runId, { url, pageType, schemaTypes = [], wordCountRaw = 100 }) {
  insertPage(db, {
    runId,
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    sourceUrl: null,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    indexable: 1,
    title: `Title ${url}`,
    titleLength: 20,
    metaDescription: 'Description long enough',
    metaDescriptionLength: 23,
    h1Json: JSON.stringify(['Heading']),
    h1Count: 1,
    h2Json: JSON.stringify([]),
    canonical: url,
    htmlLang: 'en',
    viewport: 'width=device-width',
    metaRobots: null,
    xRobotsTag: null,
    wordCountRaw,
    wordCountRendered: null,
    rawTextLength: wordCountRaw * 5,
    renderedTextLength: null,
    rawHtmlSize: 1000,
    internalLinksCount: 4,
    externalLinksCount: 1,
    schemaTypesJson: JSON.stringify(schemaTypes),
    imagesCount: 0,
    imagesWithoutAltCount: 0,
    responseHeadersJson: '{}',
    loadTimeMs: 10,
    ttfbMs: 5,
    consoleErrorsJson: '[]',
    renderedH1Json: '[]',
    renderedH1Count: 0,
    renderedLinksCount: null,
    ogJson: '{}',
    favicon: null,
    manifest: null,
    featureFlagsJson: '{}',
    pageType,
    hasTables: 0,
    hasLists: 1,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0
  });
}

function queueUrls(db, runId) {
  return db.prepare(`
    SELECT normalizedUrl
    FROM crawl_queue
    WHERE runId = ? AND status = 'pending'
    ORDER BY normalizedUrl
  `).all(runId).map((row) => row.normalizedUrl);
}

function sitemapXml(paths) {
  return `<?xml version="1.0"?><urlset>${paths.map((pathValue) => `<url><loc>__ORIGIN__${pathValue}</loc></url>`).join('')}</urlset>`;
}

function sitemapIndexXml(paths) {
  return `<?xml version="1.0"?><sitemapindex>${paths.map((pathValue) => `<sitemap><loc>__ORIGIN__${pathValue}</loc></sitemap>`).join('')}</sitemapindex>`;
}

async function withSitemapServer(routes, callback) {
  const server = http.createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (['/llms.txt', '/llms-full.txt', '/index.md', '/index.md.txt', '/README.md'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const route = routes[req.url];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (typeof route === 'string') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(route.replaceAll('__ORIGIN__', origin));
      return;
    }

    res.writeHead(200, route.headers || { 'content-type': 'application/xml' });
    const rawBody = typeof route.body === 'function' ? route.body(origin) : route.body;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody).replaceAll('__ORIGIN__', origin));
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback({ origin: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
