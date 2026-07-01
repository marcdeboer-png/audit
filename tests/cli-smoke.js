import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
const dbPath = path.join(tempDir, 'audit.sqlite');

const server = http.createServer((req, res) => {
  const host = `http://${req.headers.host}`;
  if (req.url === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`);
    return;
  }
  if (req.url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><urlset><url><loc>${host}/</loc></url><url><loc>${host}/about</loc></url></urlset>`);
    return;
  }
  if (req.url === '/llms.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('# CLI Smoke\n');
    return;
  }
  if (req.url === '/llms-full.txt' || req.url === '/index.md' || req.url === '/index.md.txt' || req.url === '/README.md') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'max-age=60',
    'content-encoding': 'identity'
  });
  res.end(`<!doctype html>
    <html lang="en">
      <head>
        <title>CLI Smoke ${req.url}</title>
        <meta name="description" content="CLI smoke test page with deterministic content for the audit tool.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="${host}${req.url}">
      </head>
      <body>
        <h1>CLI Smoke</h1>
        <p>Smoke content for local audit on 2026-01-01.</p>
        <a href="/about">About</a>
      </body>
    </html>`);
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const child = spawn('npm', [
    'run',
    'audit',
    '--',
    '--domain',
    `localhost:${port}`,
    '--maxUrls',
    '4',
    '--maxDepth',
    '1',
    '--concurrency',
    '1',
    '--type',
    'both',
    '--respectRobotsTxt',
    'false'
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AUDIT_DB_PATH: dbPath
    }
  });

  child.on('exit', (code) => {
    server.close(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.exit(code ?? 1);
    });
  });
});
