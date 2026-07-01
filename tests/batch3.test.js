import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import http from 'node:http';
import { getDb, initDatabase, resetInterruptedWork } from '../src/db/database.js';
import {
  acquireRunLock,
  createProject,
  createRun,
  getRunHealth,
  getRunWithProject,
  heartbeatRun,
  recoverRun
} from '../src/db/repositories.js';
import { cancelAudit, normalizeAuditConfig, pauseAudit, resumeAudit, startAudit } from '../src/crawler/auditRunner.js';
import { HostRateLimiter } from '../src/crawler/hostRateLimiter.js';
import {
  classifyError,
  createHttpStatusError,
  nextRetryAt,
  shouldRetryError
} from '../src/crawler/retryPolicy.js';
import {
  claimNextUrlForLock,
  enqueueUrl,
  failUrlPermanent,
  scheduleRetry
} from '../src/queue/sqliteQueue.js';
import { useTempAuditDb } from './helpers/testDb.js';

const tempDb = useTempAuditDb('batch3');
after(() => tempDb.cleanup());

test('run lock prevents a second fresh lock and allows stale lock takeover', () => {
  const db = setupDb();
  const runId = createTestRun(db);

  assert.deepEqual(acquireRunLock(db, runId, 'lock-a'), { acquired: true, reason: 'acquired' });
  assert.deepEqual(acquireRunLock(db, runId, 'lock-b'), { acquired: false, reason: 'locked' });

  db.prepare("UPDATE runs SET heartbeatAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(runId);
  assert.deepEqual(acquireRunLock(db, runId, 'lock-b', { staleHeartbeatMs: 1000 }), { acquired: true, reason: 'acquired' });
  assert.equal(db.prepare('SELECT lockToken FROM runs WHERE id = ?').get(runId).lockToken, 'lock-b');
  db.close();
});

test('heartbeat updates worker count and run health exposes queue status', () => {
  const db = setupDb();
  const runId = createTestRun(db);
  acquireRunLock(db, runId, 'lock-a');
  assert.equal(heartbeatRun(db, runId, 'lock-a', 2), true);

  enqueueUrl(db, { runId, url: 'https://example.com/a', sourceType: 'seed' });
  const item = claimNextUrlForLock(db, runId, 'lock-a');
  scheduleRetry(db, item.id, {
    errorMessage: 'Retry later',
    nextAttemptAt: '2099-01-01T00:00:00.000Z',
    statusCode: 503,
    errorType: 'retryable',
    failedReason: 'HTTP status 503'
  });

  const health = getRunHealth(db, runId);
  assert.equal(health.health, 'healthy');
  assert.equal(health.workerCount, 2);
  assert.equal(health.waitingUrls, 1);
  db.close();
});

test('queue claims only one URL per claim and respects future waiting retries', () => {
  const db = setupDb();
  const runId = createTestRun(db);
  acquireRunLock(db, runId, 'lock-a');
  enqueueUrl(db, { runId, url: 'https://example.com/a', sourceType: 'seed', priority: 10 });
  enqueueUrl(db, { runId, url: 'https://example.com/b', sourceType: 'seed', priority: 9 });

  const first = claimNextUrlForLock(db, runId, 'lock-a');
  const second = claimNextUrlForLock(db, runId, 'lock-a');
  assert.notEqual(first.id, second.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crawl_queue WHERE runId = ? AND status = 'processing'").get(runId).count, 2);
  assert.equal(claimNextUrlForLock(db, runId, 'wrong-lock'), null);

  scheduleRetry(db, first.id, {
    errorMessage: 'Retry later',
    nextAttemptAt: '2099-01-01T00:00:00.000Z',
    statusCode: 503,
    errorType: 'retryable',
    failedReason: 'HTTP status 503'
  });
  assert.equal(claimNextUrlForLock(db, runId, 'lock-a'), null);

  db.prepare("UPDATE crawl_queue SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(first.id);
  const retried = claimNextUrlForLock(db, runId, 'lock-a');
  assert.equal(retried.id, first.id);
  assert.equal(retried.status, 'processing');
  assert.equal(retried.attempts, 2);
  db.close();
});

test('retry policy distinguishes retryable errors, max attempts and permanent failures', () => {
  const db = setupDb();
  const runId = createTestRun(db, { maxAttempts: 2, retryBaseDelayMs: 10, retryMaxDelayMs: 100 });
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const retryableError = createHttpStatusError(503, 'https://example.com/a');

  assert.equal(shouldRetryError({ attempts: 1 }, run, retryableError), true);
  assert.equal(shouldRetryError({ attempts: 2 }, run, retryableError), false);
  assert.equal(classifyError(new Error('timeout while fetching')).retryable, true);
  assert.ok(Date.parse(nextRetryAt({ attempts: 1 }, run)) >= Date.now());

  enqueueUrl(db, { runId, url: 'https://example.com/a', sourceType: 'seed' });
  acquireRunLock(db, runId, 'lock-a');
  const item = claimNextUrlForLock(db, runId, 'lock-a');
  failUrlPermanent(db, item.id, {
    errorMessage: 'Bad URL',
    statusCode: 404,
    errorType: 'permanent',
    failedReason: 'HTTP status 404'
  });
  const row = db.prepare('SELECT status, lastStatusCode, lastErrorType, failedReason FROM crawl_queue WHERE id = ?').get(item.id);
  assert.deepEqual(row, {
    status: 'failed',
    lastStatusCode: 404,
    lastErrorType: 'permanent',
    failedReason: 'HTTP status 404'
  });
  db.close();
});

test('recovery resets stale processing URLs and startup reset leaves runs paused', () => {
  const db = setupDb();
  const runId = createTestRun(db);
  acquireRunLock(db, runId, 'lock-a');
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  enqueueUrl(db, { runId, url: 'https://example.com/a', sourceType: 'seed' });
  const item = claimNextUrlForLock(db, runId, 'lock-a');
  db.prepare("UPDATE crawl_queue SET startedAt = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(item.id);

  const result = recoverRun(db, runId, { processingTimeoutMs: 1000 });
  assert.equal(result.resetProcessing, 1);
  assert.equal(db.prepare('SELECT status FROM crawl_queue WHERE id = ?').get(item.id).status, 'pending');
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status, 'paused');

  acquireRunLock(db, runId, 'lock-b');
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  claimNextUrlForLock(db, runId, 'lock-b');
  resetInterruptedWork(db);
  assert.equal(db.prepare('SELECT status FROM crawl_queue WHERE id = ?').get(item.id).status, 'pending');
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId).status, 'paused');
  db.close();
});

test('host limiter caps concurrent work per host', async () => {
  const limiter = new HostRateLimiter({ maxConcurrentPerHost: 1, crawlDelayMs: 0 });
  const releaseFirst = await limiter.acquire('https://example.com/a');
  let secondAcquired = false;
  const second = limiter.acquire('https://example.com/b').then((release) => {
    secondAcquired = true;
    return release;
  });

  await sleep(35);
  assert.equal(secondAcquired, false);
  releaseFirst();

  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});

test('host limiter can throttle global request starts by target pages per second', async () => {
  const limiter = new HostRateLimiter({ maxConcurrentPerHost: 2, crawlDelayMs: 0, targetPagesPerSecond: 20 });
  const releaseFirst = await limiter.acquire('https://example.com/a');
  const started = Date.now();
  const releaseSecond = await limiter.acquire('https://example.com/b');
  const elapsed = Date.now() - started;
  releaseFirst();
  releaseSecond();
  assert.ok(elapsed >= 35);
});

test('pause stops new claims and resume completes the run', async () => {
  const server = await startSlowAuditServer();
  const db = getDb();
  resetInterruptedWork(db);

  try {
    const { runId, promise } = await startAudit({
      domain: `localhost:${server.port}`,
      auditType: 'both',
      maxUrls: 4,
      maxDepth: 1,
      concurrency: 1,
      respectRobotsTxt: false,
      requestTimeoutMs: 5000,
      usePlaywright: false,
      playwrightMode: 'off'
    });

    await waitFor(() => queueCount(db, runId, 'processing') > 0, 3000);
    pauseAudit(runId);
    await promise;

    let run = getRunWithProject(db, runId);
    assert.equal(run.status, 'paused');
    assert.equal(queueCount(db, runId, 'processing'), 0);

    resumeAudit(runId);
    await waitFor(() => getRunWithProject(db, runId).status === 'completed', 5000);
    run = getRunWithProject(db, runId);
    assert.equal(run.status, 'completed');
    assert.ok(run.processedUrls > 0);
  } finally {
    await server.close();
  }
});

test('cancel stops workers without leaving processing URLs behind', async () => {
  const server = await startSlowAuditServer();
  const db = getDb();
  resetInterruptedWork(db);

  try {
    const { runId, promise } = await startAudit({
      domain: `localhost:${server.port}`,
      auditType: 'both',
      maxUrls: 4,
      maxDepth: 1,
      concurrency: 1,
      respectRobotsTxt: false,
      requestTimeoutMs: 5000,
      usePlaywright: false,
      playwrightMode: 'off'
    });

    await waitFor(() => queueCount(db, runId, 'processing') > 0, 3000);
    cancelAudit(runId);
    await promise;

    const run = getRunWithProject(db, runId);
    assert.equal(run.status, 'cancelled');
    assert.equal(queueCount(db, runId, 'processing'), 0);
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

function createTestRun(db, overrides = {}) {
  const projectId = createProject(db, {
    inputDomain: 'example.com',
    brandName: 'Example'
  });
  return createRun(db, projectId, normalizeAuditConfig({
    domain: 'example.com',
    auditType: 'both',
    maxUrls: 10,
    maxDepth: 2,
    concurrency: 2,
    respectRobotsTxt: false,
    usePlaywright: false,
    ...overrides
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueCount(db, runId, status) {
  return db.prepare('SELECT COUNT(*) AS count FROM crawl_queue WHERE runId = ? AND status = ?').get(runId, status).count;
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('Timed out waiting for condition');
}

function startSlowAuditServer() {
  const server = http.createServer(async (req, res) => {
    const host = `http://${req.headers.host}`;
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`);
      return;
    }
    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset><url><loc>${host}/</loc></url><url><loc>${host}/page-a</loc></url><url><loc>${host}/page-b</loc></url></urlset>`);
      return;
    }
    if (['/llms.txt', '/llms-full.txt', '/index.md', '/index.md.txt', '/README.md'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    await sleep(160);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html lang="en">
        <head>
          <title>Slow ${req.url}</title>
          <meta name="description" content="Slow local audit page for worker lifecycle tests.">
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body>
          <h1>Slow ${req.url}</h1>
          <a href="/page-a">Page A</a>
          <a href="/page-b">Page B</a>
        </body>
      </html>`);
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
