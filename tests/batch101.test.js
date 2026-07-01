import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, insertCheckResults, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { parseReferenceAuditInput } from '../src/validation/referenceAudit/referenceAuditParser.js';
import { mapReferenceItemToChecks } from '../src/validation/referenceAudit/referenceAuditMapper.js';
import { classifyManualItemCoverage, classifyToolExtraFindings } from '../src/validation/referenceAudit/coverageClassifier.js';
import { validateRunAgainstReference } from '../src/validation/referenceAudit/validationService.js';
import { buildValidationExportPayload } from '../src/validation/referenceAudit/validationExportService.js';
import { collectFullAuditZip } from '../src/results/checkExportService.js';

test('Batch 10.1 reference parser reads CSV and JSON, tolerates missing fields and creates stable ids', () => {
  const csv = [
    'Title,Category,Priority,Affected URLs,Recommendation',
    '"Title zu lang","HTML Head","High","https://example.com/a; https://example.com/b","Template fixen"',
    '"CrUX LCP schlecht",Performance,Medium,,'
  ].join('\n');
  const parsed = parseReferenceAuditInput({ filename: 'manual.csv', content: csv });
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].category, 'html-head');
  assert.equal(parsed.items[0].affectedUrls.length, 2);
  assert.ok(parsed.items[0].id.startsWith('ref-'));
  assert.equal(parsed.items[1].recommendation, null);

  const json = parseReferenceAuditInput({
    filename: 'manual.json',
    content: JSON.stringify({ items: [{ title: 'H1 fehlt', category: 'Head', expectedToolCheckIds: ['tech.h1_missing'] }] })
  });
  assert.equal(json.items[0].expectedToolCheckIds[0], 'tech.h1_missing');
});

test('Batch 10.1 mapping maps common manual audit topics to existing tool checks', () => {
  const cases = [
    ['Title zu lang', 'tech.title_too_long'],
    ['Meta Description fehlt', 'tech.meta_description_missing'],
    ['H1 fehlt', 'tech.h1_missing'],
    ['Canonical falsch', 'tech.canonical_non_self'],
    ['Product Schema fehlt auf PDPs', 'tech.product_coverage_on_product_like_pages'],
    ['Security Header fehlen', 'tech.hsts_header'],
    ['llms.txt fehlt und AI Bots nicht geregelt', 'geo.llms_txt_present']
  ];
  for (const [title, expected] of cases) {
    const mapping = mapReferenceItemToChecks({ id: title, title, category: title });
    assert.equal(mapping.expectedCheckIds.includes(expected), true, `${title} maps to ${expected}`);
  }
});

test('Batch 10.1 coverage classifier covers core statuses and tool extras', () => {
  const item = {
    id: 'manual-title',
    title: 'Title zu lang',
    category: 'html-head',
    priority: 'High',
    affectedUrls: ['https://example.com/a'],
    affectedCount: 1
  };
  const mapping = mapReferenceItemToChecks(item);
  const finding = {
    id: 1,
    checkId: 'tech.title_too_long',
    status: 'Warning',
    priority: 'High',
    affectedCount: 1,
    sampleUrlsJson: JSON.stringify(['https://example.com/a']),
    category: 'HTML Head & Meta',
    checkName: 'Title too long',
    finding: 'Title too long'
  };
  const covered = classifyManualItemCoverage(item, mapping, [finding]);
  assert.equal(covered.coverageStatus, 'covered');

  const missing = classifyManualItemCoverage({ ...item, id: 'manual-meta', title: 'Meta Description fehlt' }, mapReferenceItemToChecks({ title: 'Meta Description fehlt' }), []);
  assert.equal(missing.coverageStatus, 'false_negative_candidate');

  const external = classifyManualItemCoverage({ id: 'manual-crux', title: 'CrUX LCP schlecht', category: 'Performance' }, mapReferenceItemToChecks({ title: 'CrUX LCP schlecht', category: 'Performance' }), []);
  assert.equal(external.coverageStatus, 'needs_external_data');

  const llm = classifyManualItemCoverage({ id: 'manual-geo', title: 'GEO answerability sample', category: 'GEO' }, mapReferenceItemToChecks({ title: 'GEO answerability sample', category: 'GEO' }), []);
  assert.equal(llm.coverageStatus, 'needs_llm_review');

  const extras = classifyToolExtraFindings([{ ...finding, id: 2, checkId: 'tech.images_without_alt', confidence: 'medium' }], new Set());
  assert.equal(extras[0].coverageStatus, 'tool_finds_extra');
});

test('Batch 10.1 validation service creates reports, backlog, benchmark and full ZIP validation entries', async () => {
  const db = setupDb();
  const runId = seedValidationRun(db);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-batch101-validation-'));
  const reference = {
    items: [
      {
        title: 'Title zu lang',
        category: 'HTML Head',
        priority: 'High',
        affectedUrls: ['https://example.com/a'],
        affectedCount: 1
      },
      {
        title: 'Meta Description fehlt',
        category: 'HTML Head',
        priority: 'Medium'
      },
      {
        title: 'CrUX LCP schlecht',
        category: 'Performance',
        priority: 'Medium'
      },
      {
        title: 'GEO answerability sample braucht qualitative Bewertung',
        category: 'GEO',
        priority: 'Low'
      }
    ]
  };
  const report = await validateRunAgainstReference(db, {
    runId,
    outDir,
    referenceFile: {
      filename: 'reference.json',
      content: JSON.stringify(reference)
    }
  });

  assert.equal(report.validationSummary.manualItemCount, 4);
  assert.equal(report.validationSummary.covered, 1);
  assert.equal(report.validationSummary.falseNegativeCandidates, 1);
  assert.equal(report.validationSummary.needsExternalData, 1);
  assert.equal(report.validationSummary.needsLlmReview, 1);
  assert.ok(report.nextCheckBacklog.length >= 3);
  assert.equal(report.unmatchedToolFindings.some((row) => row.checkId === 'tech.images_without_alt'), true);
  assert.ok(report.benchmarkSummary.urlFacts >= 1);

  const files = buildValidationExportPayload(report);
  assert.match(files['validation-report.html'], /Enterprise Validation Report/);
  assert.match(files['validation-report.md'], /Coverage Matrix/);
  assert.match(files['coverage-matrix.csv'], /coverageStatus/);
  assert.match(files['tool-gap-backlog.json'], /Meta Description fehlt/);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries['validation/validation-report.html']);
  assert.ok(zipEntries['validation/coverage-matrix.csv']);
  assert.ok(zipEntries['summary/benchmark-summary.json']);
  db.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('Batch 10.1 UI source exposes validation route, upload, filters and export links', () => {
  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /#validation\/\$\{runId\}/);
  assert.match(app, /Enterprise Validation/);
  assert.match(app, /validation-form/);
  assert.match(app, /data-validation-filter/);
  assert.match(app, /coverage-matrix\.csv/);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedValidationRun(db) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 10,
    maxDepth: 1,
    concurrency: 1,
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 1,
    successfulUrls: 1,
    startedAt: '2026-07-01T08:00:00.000Z',
    finishedAt: '2026-07-01T08:00:02.000Z'
  });
  db.prepare(`
    INSERT INTO pages (runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType, indexable, title, titleLength)
    VALUES (?, ?, ?, ?, 0, 200, 'text/html', 1, 'A very long example title for validation testing', 52)
  `).run(runId, 'https://example.com/a', 'https://example.com/a', 'https://example.com/a');
  insertCheckResults(db, runId, [
    check('tech.title_too_long', 'HTML Head & Meta', 'Title too long', 'Warning', 'High', {
      affectedCount: 1,
      sampleUrls: ['https://example.com/a'],
      evidence: { threshold: 60, samples: ['https://example.com/a'] }
    }),
    check('tech.images_without_alt', 'Media SEO', 'Images without alt', 'Warning', 'Medium', {
      affectedCount: 2,
      sampleUrls: ['https://example.com/image-page'],
      evidence: { missingAlt: 2 }
    }),
    check('tech.hsts_header', 'Security Best Practice', 'HSTS present', 'OK', 'Low', {
      affectedCount: 0,
      sampleUrls: [],
      evidence: { checked: true }
    })
  ]);
  return runId;
}

function check(id, category, name, status, priority, options = {}) {
  return {
    id,
    category,
    name,
    status,
    priority,
    effort: 'S',
    finding: `${name} finding`,
    details: `${name} details`,
    recommendation: `${name} recommendation`,
    affectedCount: options.affectedCount || 0,
    sampleUrls: options.sampleUrls || [],
    evidence: options.evidence || { checked: true },
    findingType: status === 'OK' ? 'info' : 'issue',
    confidence: 'high',
    reviewRecommended: status !== 'OK'
  };
}

function readStoredZip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    entries[name] = buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    offset = dataStart + compressedSize;
  }
  return entries;
}
