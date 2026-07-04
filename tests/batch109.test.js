import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import {
  buildEvidenceImpactForRun,
  renderEvidenceImpactMarkdown
} from '../src/evidenceJobs/evidenceImpactService.js';
import {
  completeEvidenceJob,
  createEvidenceJob,
  insertTargetedEvidenceFact,
  listTargetedEvidenceFactsForRun
} from '../src/evidenceJobs/evidenceJobRepository.js';
import { collectFullAuditZip } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('Batch 10.9 targeted facts improve validation confidence without fake full-domain coverage', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', sampleUrls('https://example.com', 20));
  saveValidationReport(db, buildValidationReport(runId));
  seedCompletedJob(db, runId, 'title_facts', titleFacts('https://example.com', 20));
  seedCompletedJob(db, runId, 'meta_description_facts', metaFacts('https://example.com', 20));
  seedCompletedJob(db, runId, 'h1_facts', h1Facts('https://example.com', 20));
  seedCompletedJob(db, runId, 'canonical_robots_facts', canonicalFacts('https://example.com', 20));

  const impact = buildEvidenceImpactForRun(db, runId);
  assert.equal(impact.jobsConsidered.length, 4);
  assert.equal(impact.factsConsidered, 80);
  assert.ok(impact.manualItemsImpacted >= 4);

  const title = impact.changedItems.find((item) => item.manualItemId === 'manual-title');
  assert.equal(title.newStatus, 'covered_in_sample');
  assert.equal(title.previousStatus, 'partially_covered');
  assert.ok(title.newMatchReasons.includes('targeted_title_facts_available'));
  assert.ok(title.removedMissingReasons.includes('evidence_too_weak'));
  assert.ok(title.removedMissingReasons.includes('missing_affected_count'));
  assert.ok(title.remainingMissingReasons.includes('sample_too_small'));
  assert.ok(title.upgradeLimitations.some((limitation) => limitation.startsWith('limited_url_basis:')));
  assert.notEqual(title.newStatus, 'covered');

  const meta = impact.changedItems.find((item) => item.manualItemId === 'manual-meta');
  assert.ok(meta.newMatchReasons.includes('targeted_meta_description_facts_available'));
  assert.ok(meta.removedMissingReasons.includes('evidence_too_weak'));
  assert.ok(['medium', 'high'].includes(meta.newConfidence));

  const h1 = impact.changedItems.find((item) => item.manualItemId === 'manual-h1');
  assert.ok(h1.newMatchReasons.includes('targeted_h1_facts_available'));

  const canonical = impact.changedItems.find((item) => item.manualItemId === 'manual-canonical');
  assert.ok(canonical.newMatchReasons.includes('targeted_canonical_robots_facts_available'));

  assert.ok(impact.coverageAfter.coveragePercent >= impact.coverageBefore.coveragePercent);
  assert.equal(impact.coverageAfter.covered, 0);
  assert.ok(impact.coverageAfter.coveredInSample >= 1);
  db.close();
});

test('Batch 10.9 impact summaries expose duplicate, missing, h1 and robots signals', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', sampleUrls('https://example.com', 4));
  saveValidationReport(db, buildValidationReport(runId));
  seedCompletedJob(db, runId, 'title_facts', titleFacts('https://example.com', 4));
  seedCompletedJob(db, runId, 'meta_description_facts', metaFacts('https://example.com', 4));
  seedCompletedJob(db, runId, 'h1_facts', h1Facts('https://example.com', 4));
  seedCompletedJob(db, runId, 'canonical_robots_facts', canonicalFacts('https://example.com', 4));

  const impact = buildEvidenceImpactForRun(db, runId);
  assert.equal(impact.factSummaries.title_facts.tooLongCount, 1);
  assert.equal(impact.factSummaries.title_facts.duplicateHashGroups.length, 1);
  assert.equal(impact.factSummaries.meta_description_facts.missingCount, 1);
  assert.equal(impact.factSummaries.h1_facts.multipleCount, 1);
  assert.equal(impact.factSummaries.canonical_robots_facts.xRobotsNoindexCount, 1);
  assert.equal(impact.factSummaries.canonical_robots_facts.canonicalExternalCount, 1);

  const markdown = renderEvidenceImpactMarkdown(impact);
  assert.match(markdown, /Evidence Job Impact/);
  assert.match(markdown, /Changed Manual Items/);
  assert.match(markdown, /title_facts/);
  db.close();
});

test('Batch 10.9 full ZIP contains evidence impact exports and no raw HTML facts', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', sampleUrls('https://example.com', 3));
  saveValidationReport(db, buildValidationReport(runId));
  const job = seedCompletedJob(db, runId, 'title_facts', titleFacts('https://example.com', 3));

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries['validation/evidence-job-impact.json']);
  assert.ok(zipEntries['validation/evidence-job-impact.md']);
  assert.match(zipEntries['validation/validation-report.md'], /Evidence Job Impact/);
  assert.ok(zipEntries[`evidence-jobs/job-${job.jobId}-facts.csv`]);
  assert.equal(zipEntries[`evidence-jobs/job-${job.jobId}-facts.csv`].includes('<html'), false);
  db.close();
});

test('Batch 10.9 evidence impact API endpoint returns changed items', async () => {
  const temp = useTempAuditDb('batch109-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const runId = seedRun(seedDb, 'https://example.com', sampleUrls('https://example.com', 20));
  saveValidationReport(seedDb, buildValidationReport(runId));
  seedCompletedJob(seedDb, runId, 'title_facts', titleFacts('https://example.com', 20));
  seedDb.close();

  const apiPort = 37000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: temp.dbPath, PORT: String(apiPort), SCHEDULER_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);
    const impact = await fetchJson(`http://127.0.0.1:${apiPort}/api/audits/${runId}/evidence-impact`);
    assert.equal(impact.runId, runId);
    assert.equal(impact.jobsConsidered.length, 1);
    assert.equal(impact.factsConsidered, 20);
    assert.ok(impact.changedItems.some((item) => item.manualItemId === 'manual-title'));
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
  }
});

test('Batch 10.9 repository and UI expose run-level targeted fact impact', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', sampleUrls('https://example.com', 2));
  seedCompletedJob(db, runId, 'title_facts', titleFacts('https://example.com', 2));
  assert.equal(listTargetedEvidenceFactsForRun(db, runId).length, 2);
  assert.equal(listTargetedEvidenceFactsForRun(db, runId, { jobTypes: ['title_facts'] }).length, 2);

  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /Evidence Job Impact/);
  assert.match(app, /evidence-impact/);
  assert.match(app, /renderEvidenceImpactPanel/);
  db.close();
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
    maxUrls: Math.max(20, urls.length),
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

function seedCompletedJob(db, runId, jobType, facts) {
  const job = createEvidenceJob(db, {
    runId,
    validationId: null,
    jobType,
    label: jobType,
    urlSource: 'current_run_urls',
    urlCountPlanned: facts.length,
    maxUrls: facts.length,
    estimatedBytesPerUrl: 700,
    estimatedTotalBytes: facts.length * 700,
    factsToExtract: [jobType],
    storesRawHtml: false,
    storesRenderedHtml: false,
    summary: { rawHtmlStored: false }
  });
  for (const fact of facts) {
    insertTargetedEvidenceFact(db, {
      jobId: job.jobId,
      runId,
      jobType,
      ...fact
    });
  }
  return completeEvidenceJob(db, job.jobId, {
    urlCountProcessed: facts.length,
    urlCountSucceeded: facts.length,
    urlCountFailed: 0,
    actualStoredBytesEstimate: facts.reduce((sum, fact) => sum + JSON.stringify(fact.facts || {}).length, 0),
    summary: { rawHtmlStored: false, checkedUrls: facts.length }
  });
}

function saveValidationReport(db, report) {
  db.prepare(`
    INSERT INTO validation_reports (
      runId, referenceFilename, referenceFormat, sourceHash, outputDir,
      summaryJson, reportJson, benchmarkSummaryJson
    )
    VALUES (?, 'reference.json', 'json', 'test-hash', NULL, ?, ?, '{}')
  `).run(report.runId, JSON.stringify(report.validationSummary || {}), JSON.stringify(report));
}

function buildValidationReport(runId) {
  const coverageMatrix = [
    coverageRow('manual-title', 'Title Tags sind zu lang', 'Title', 'title_facts', ['evidence_too_weak', 'missing_affected_count', 'sample_too_small']),
    coverageRow('manual-meta', 'Meta Description fehlt oder ist zu kurz', 'Meta Description', 'meta_description_facts', ['evidence_too_weak', 'missing_affected_count', 'sample_too_small']),
    coverageRow('manual-h1', 'H1 fehlt oder ist mehrfach vorhanden', 'H1', 'h1_facts', ['evidence_too_weak', 'missing_affected_count']),
    coverageRow('manual-canonical', 'Canonical und Robots Signale sind inkonsistent', 'Canonical Robots', 'canonical_robots_facts', ['evidence_too_weak', 'missing_affected_count', 'sample_too_small'])
  ];
  return {
    runId,
    validationId: 1,
    generatedAt: '2026-07-04T08:10:00.000Z',
    referenceAudit: { filename: 'reference.json', format: 'json' },
    validationSummary: {
      manualItemCount: coverageMatrix.length,
      covered: 0,
      coveredInSample: 0,
      partiallyCovered: coverageMatrix.length,
      notCovered: 0,
      needsExternalData: 0,
      needsLargerCrawl: 0,
      needsHumanReview: 0,
      coveragePercent: 50,
      dataBasisLabel: 'Sample validation'
    },
    coverageMatrix,
    unmatchedToolFindings: [],
    checkRoadmap: [],
    unresolvedAuditQueue: { summary: { unresolvedCount: coverageMatrix.length }, points: [], evidenceJobPlan: { recommendedJobCount: 4, jobs: [] } },
    evidencePacks: {},
    evidenceJobPlan: { recommendedJobCount: 4, jobs: [] }
  };
}

function coverageRow(id, title, category, jobType, missingReasons) {
  return {
    manualItemId: id,
    manualItem: {
      id,
      title,
      category,
      priority: 'High',
      affectedUrls: ['https://example.com/page-1'],
      requiresExternalData: false,
      requiresHumanJudgment: false,
      requiresLlmJudgment: false
    },
    coverageStatus: 'partially_covered',
    confidence: 'medium',
    matchedCheckId: `check.${jobType}`,
    matchedCheckIds: [`check.${jobType}`],
    expectedCheckIds: [`expected.${jobType}`],
    matchScore: 60,
    evidenceMatchScore: 60,
    matchReasons: ['same_check_family'],
    missingReasons,
    partialReason: missingReasons[0],
    rationale: 'Needs targeted evidence.'
  };
}

function sampleUrls(origin, count) {
  return Array.from({ length: count }, (_, index) => `${origin}/page-${index + 1}`);
}

function titleFacts(origin, count) {
  return sampleUrls(origin, count).map((url, index) => ({
    url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    indexability: 'indexable',
    facts: {
      url,
      title: index === 0 ? 'Very Long Product Title With Too Many Words For Evidence Validation' : `Shared Product Title ${index > 1 ? 2 : index}`,
      titleLength: index === 0 ? 68 : 22,
      titleMissing: false,
      titleEmpty: false,
      titleTooShort: false,
      titleTooLong: index === 0,
      titleHash: index === 1 || index === 2 ? 'dup-title-hash' : `title-hash-${index}`,
      titlePattern: 'shared product title {num}'
    }
  }));
}

function metaFacts(origin, count) {
  return sampleUrls(origin, count).map((url, index) => ({
    url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    indexability: 'indexable',
    facts: {
      url,
      metaDescription: index === 0 ? '' : 'Compact targeted meta description for validation.',
      metaDescriptionLength: index === 0 ? 0 : 49,
      metaDescriptionMissing: index === 0,
      metaDescriptionEmpty: index === 0,
      metaDescriptionTooShort: index < 2,
      metaDescriptionTooLong: false,
      metaDescriptionHash: index === 2 || index === 3 ? 'dup-meta-hash' : `meta-hash-${index}`,
      metaDescriptionPattern: 'compact targeted meta description'
    }
  }));
}

function h1Facts(origin, count) {
  return sampleUrls(origin, count).map((url, index) => ({
    url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    indexability: 'indexable',
    facts: {
      url,
      h1Count: index === 0 ? 2 : 1,
      h1Texts: index === 0 ? ['Main', 'Secondary'] : ['Main'],
      firstH1: 'Main',
      h1Missing: false,
      h1Empty: false,
      h1Multiple: index === 0,
      h1Hash: index < 2 ? 'dup-h1-hash' : `h1-hash-${index}`,
      h1Pattern: 'main'
    }
  }));
}

function canonicalFacts(origin, count) {
  return sampleUrls(origin, count).map((url, index) => ({
    url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    indexability: index === 0 ? 'blocked_by_robots' : 'indexable',
    facts: {
      url,
      canonical: index === 1 ? 'https://external.example/canonical' : url,
      canonicalMissing: false,
      canonicalSelfReferencing: index !== 1,
      canonicalExternal: index === 1,
      metaRobots: index === 0 ? 'noindex,nofollow' : 'index,follow',
      metaNoindex: index === 0,
      metaNofollow: index === 0,
      xRobotsTag: index === 0 ? 'noindex' : '',
      xRobotsNoindex: index === 0,
      xRobotsNofollow: false,
      robotsConflict: index === 0
    }
  }));
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
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
