import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { getEvidenceJobType, estimateEvidenceJobStorage } from '../src/evidenceJobs/evidenceJobTypes.js';
import { dryRunEvidenceJob, createAndRunEvidenceJob, getEvidenceJobDetails } from '../src/evidenceJobs/evidenceJobRunner.js';
import { extractTargetedFacts } from '../src/evidenceJobs/targetedFactExtractors.js';
import { listTargetedEvidenceFacts } from '../src/evidenceJobs/evidenceJobRepository.js';
import { collectFullAuditZip } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('Batch 10.8 executable job types exist and keep low storage estimates', () => {
  for (const jobType of ['title_facts', 'meta_description_facts', 'h1_facts', 'canonical_robots_facts']) {
    const definition = getEvidenceJobType(jobType);
    assert.ok(definition, `${jobType} should exist`);
    assert.equal(definition.storesRawHtml, false);
    assert.equal(definition.storesRenderedHtml, false);
    assert.equal(estimateEvidenceJobStorage(jobType, 100).riskLevel, 'low');
  }
});

test('Batch 10.8 fact extractors extract compact title meta h1 canonical and robots facts', () => {
  const html = `<!doctype html><html><head>
    <title>Example Product 123 - Buy Now</title>
    <meta name="description" content="A useful product description for targeted evidence extraction.">
    <meta name="robots" content="noindex,nofollow">
    <link rel="canonical" href="/product-123">
  </head><body><h1>Product 123</h1><h1>Secondary</h1></body></html>`;
  const context = {
    url: 'https://example.com/product-123',
    finalUrl: 'https://example.com/product-123',
    statusCode: 200,
    contentType: 'text/html',
    headers: { 'x-robots-tag': 'nofollow' }
  };

  const title = extractTargetedFacts('title_facts', html, context);
  assert.equal(title.titleLength, 'Example Product 123 - Buy Now'.length);
  assert.equal(title.titleTooShort, false);
  assert.match(title.titleHash, /^[a-f0-9]{16}$/);
  assert.match(title.titlePattern, /product \{num\}/);

  const meta = extractTargetedFacts('meta_description_facts', html, context);
  assert.equal(meta.metaDescriptionMissing, false);
  assert.equal(meta.metaDescriptionTooShort, true);

  const h1 = extractTargetedFacts('h1_facts', html, context);
  assert.equal(h1.h1Count, 2);
  assert.equal(h1.h1Multiple, true);
  assert.equal(h1.firstH1, 'Product 123');

  const canonical = extractTargetedFacts('canonical_robots_facts', html, context);
  assert.equal(canonical.canonicalSelfReferencing, true);
  assert.equal(canonical.metaNoindex, true);
  assert.equal(canonical.xRobotsNofollow, true);
  assert.equal(canonical.indexability, 'blocked_by_robots');
});

test('Batch 10.8 dry run resolves URL set, applies maxUrls and stores no facts', async () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', ['https://example.com/a', 'https://example.com/b']);
  const dryRun = await dryRunEvidenceJob(db, runId, {
    jobType: 'title_facts',
    urlSource: 'current_run_urls',
    maxUrls: 1
  });

  assert.equal(dryRun.jobType, 'title_facts');
  assert.equal(dryRun.plannedUrlCount, 2);
  assert.equal(dryRun.effectiveUrlCount, 1);
  assert.equal(dryRun.maxUrls, 1);
  assert.equal(dryRun.canRun, true);
  assert.equal(dryRun.storesRawHtml, false);
  assert.ok(dryRun.estimatedTotalBytes > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM targeted_evidence_facts').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evidence_jobs').get().count, 0);
  db.close();
});

test('Batch 10.8 runner stores compact facts, counts failures and never stores raw HTML', async () => {
  const server = await startMockSite();
  const db = setupDb();
  const origin = server.origin;
  const runId = seedRun(db, origin, [`${origin}/a`, `${origin}/missing`, `${origin}/large`]);

  const titleJob = await createAndRunEvidenceJob(db, runId, {
    jobType: 'title_facts',
    urlSource: 'current_run_urls',
    maxUrls: 2,
    concurrency: 2
  });
  assert.equal(titleJob.status, 'completed');
  assert.equal(titleJob.urlCountProcessed, 2);
  assert.equal(titleJob.urlCountSucceeded, 1);
  assert.equal(titleJob.urlCountFailed, 1);
  assert.equal(titleJob.summary.rawHtmlStored, false);
  assert.equal(titleJob.summary.coverageRecalculated, false);

  const titleFacts = listTargetedEvidenceFacts(db, titleJob.jobId);
  assert.equal(titleFacts.length, 2);
  assert.equal(titleFacts.find((row) => row.normalizedUrl.endsWith('/a')).facts.title, 'Alpha Title For Evidence Runner');
  assert.equal(titleFacts.find((row) => row.normalizedUrl.endsWith('/missing')).error, 'HTTP 404');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM page_snapshots').get().count, 0);
  assert.equal(JSON.stringify(titleFacts).includes('<html'), false);

  const largeJob = await createAndRunEvidenceJob(db, runId, {
    jobType: 'meta_description_facts',
    urlSource: 'manual_url_list',
    urls: [`${origin}/large`],
    maxUrls: 1,
    maxResponseBytes: 1024
  });
  assert.equal(largeJob.urlCountFailed, 1);
  assert.match(largeJob.errors.join(' '), /maxResponseBytes/);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries['evidence-jobs/jobs.json']);
  assert.ok(zipEntries[`evidence-jobs/job-${titleJob.jobId}-summary.json`]);
  assert.ok(zipEntries[`evidence-jobs/job-${titleJob.jobId}-facts.csv`]);
  assert.ok(zipEntries['validation/evidence-job-impact.json']);
  assert.equal(zipEntries[`evidence-jobs/job-${titleJob.jobId}-facts.csv`].includes('<html'), false);

  db.close();
  await server.close();
});

test('Batch 10.8 API endpoints create dry runs, jobs and expose status', async () => {
  const site = await startMockSite();
  const temp = useTempAuditDb('batch108-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const runId = seedRun(seedDb, site.origin, [`${site.origin}/a`]);
  seedDb.close();

  const apiPort = 36000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: temp.dbPath, PORT: String(apiPort), SCHEDULER_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);
    const dryRun = await postJson(`http://127.0.0.1:${apiPort}/api/audits/${runId}/evidence-jobs/dry-run`, {
      jobType: 'h1_facts',
      urlSource: 'current_run_urls',
      maxUrls: 1
    });
    assert.equal(dryRun.canRun, true);
    assert.equal(dryRun.effectiveUrlCount, 1);

    const created = await postJson(`http://127.0.0.1:${apiPort}/api/audits/${runId}/evidence-jobs`, {
      jobType: 'canonical_robots_facts',
      urlSource: 'current_run_urls',
      maxUrls: 1
    });
    assert.equal(created.job.status, 'planned');
    const completed = await pollJob(apiPort, created.job.jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.factCount, 1);
    assert.equal(completed.facts[0].facts.canonicalSelfReferencing, true);

    const list = await fetchJson(`http://127.0.0.1:${apiPort}/api/audits/${runId}/evidence-jobs`);
    assert.equal(list.jobs.length, 1);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
    await site.close();
  }
});

test('Batch 10.8 UI source exposes dry run, start action and job history', () => {
  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /data-evidence-dry-run/);
  assert.match(app, /data-evidence-start/);
  assert.match(app, /Evidence Job History/);
  assert.match(app, /evidence-jobs\/dry-run/);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedRun(db, domain, urls) {
  const projectId = createProject(db, { inputDomain: domain, brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: domain });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain,
    auditType: 'both',
    maxUrls: Math.max(10, urls.length),
    maxDepth: 1,
    concurrency: 1,
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: urls.length,
    successfulUrls: urls.length,
    startedAt: '2026-07-04T08:00:00.000Z',
    finishedAt: '2026-07-04T08:00:02.000Z'
  });
  for (const url of urls) {
    db.prepare(`
      INSERT INTO pages (
        runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
        indexable, title, titleLength, metaDescription, metaDescriptionLength,
        h1Json, h1Count
      )
      VALUES (?, ?, ?, ?, 0, 200, 'text/html', 1, 'Seed', 4, 'Seed description', 16, '["Seed"]', 1)
    `).run(runId, url, url, url);
  }
  return runId;
}

async function startMockSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/a') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'index,follow'
      });
      res.end(`<!doctype html><html><head>
        <title>Alpha Title For Evidence Runner</title>
        <meta name="description" content="Alpha description for the targeted runner test case with useful length.">
        <link rel="canonical" href="/a">
      </head><body><h1>Alpha H1</h1></body></html>`);
      return;
    }
    if (req.url === '/large') {
      const body = '<!doctype html><html><head><title>Large</title></head><body>' + 'x'.repeat(4096) + '</body></html>';
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Missing</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function waitForApi(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/audits`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('API server did not start');
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function pollJob(port, jobId) {
  for (let i = 0; i < 20; i += 1) {
    const job = await fetchJson(`http://127.0.0.1:${port}/api/evidence-jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Evidence job ${jobId} did not complete`);
}

function readStoredZip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries[name] = buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    offset = dataStart + compressedSize;
  }
  return entries;
}
