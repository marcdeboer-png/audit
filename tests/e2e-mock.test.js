import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startAudit } from '../src/crawler/auditRunner.js';
import { getDb, resetInterruptedWork } from '../src/db/database.js';
import { getRunWithProject } from '../src/db/repositories.js';
import { useTempAuditDb } from './helpers/testDb.js';

const tempDb = useTempAuditDb('e2e');
after(() => tempDb.cleanup());

test('runs an end-to-end audit against a local mock site', async () => {
  const server = http.createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\nUser-agent: GPTBot\nAllow: /\n`);
      return;
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset><url><loc>${host}/</loc></url><url><loc>${host}/about</loc></url><url><loc>${host}/blog/post</loc></url></urlset>`);
      return;
    }
    if (req.url === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('# Mock Site\n\n- Home\n- About\n');
      return;
    }
    if (req.url === '/llms-full.txt' || req.url === '/index.md' || req.url === '/index.md.txt' || req.url === '/README.md') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url === '/about') {
      html(res, 'About Mock Brand', `
        <h1>About Mock Brand</h1>
        <p>Written by Audit Team on 2026-01-01.</p>
        <table><tr><td>Signal</td><td>Value</td></tr></table>
        <a href="/contact">Contact</a>
      `);
      return;
    }
    if (req.url === '/blog/post') {
      html(res, 'Mock Blog Post With Article Schema', `
        <article>
          <h1>Mock Blog Post With Article Schema</h1>
          <h2>Why this exists</h2>
          <p>Written by Audit Team on 2026-01-02 with enough words to provide a small article-like page for the audit crawler.</p>
          <ul><li>First point</li><li>Second point</li></ul>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Mock Blog Post"}</script>
        </article>
      `);
      return;
    }
    if (req.url === '/contact') {
      html(res, 'Contact Mock Brand', '<h1>Contact</h1><p>Contact page.</p>');
      return;
    }
    html(res, 'Mock Brand Home', `
      <h1>Mock Brand Home</h1>
      <h2>Overview</h2>
      <p>Mock homepage content with clear internal links and a visible date 2026-01-03.</p>
      <a href="/about">About</a>
      <a href="/blog/post">Blog</a>
      <a href="/privacy">Datenschutz</a>
      <a href="/impressum">Impressum</a>
      <img src="/hero.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Mock Brand"}</script>
      <script src="/app.js"></script>
    `);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const db = getDb();
  resetInterruptedWork(db);

  try {
    const { runId } = await startAudit({
      domain: `localhost:${port}`,
      brandName: 'Mock Brand',
      auditType: 'both',
      maxUrls: 8,
      maxDepth: 2,
      concurrency: 1,
      respectRobotsTxt: false
    }, { wait: true });

    const run = getRunWithProject(db, runId);
    assert.equal(run.status, 'completed');
    assert.ok(run.processedUrls >= 3);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count >= 3);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM check_results WHERE runId = ?').get(runId).count > 20);
    assert.ok(fs.existsSync(path.join(process.cwd(), 'reports', `run-${runId}.html`)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function html(res, title, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'max-age=60',
    'content-encoding': 'identity',
    'x-content-type-options': 'nosniff'
  });
  res.end(`<!doctype html>
    <html lang="en">
      <head>
        <title>${title}</title>
        <meta name="description" content="This is a mock page description used for deterministic local audit testing.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="/">
        <meta property="og:title" content="${title}">
        <meta property="og:description" content="Mock description">
        <meta property="og:image" content="/og.jpg">
        <meta property="og:url" content="/">
      </head>
      <body>${body}</body>
    </html>`);
}
