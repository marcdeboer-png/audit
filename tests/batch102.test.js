import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, insertCheckResults, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { parseReferenceAuditFiles } from '../src/validation/referenceAudit/referenceAuditParser.js';
import { classifyToolExtraFindings } from '../src/validation/referenceAudit/coverageClassifier.js';
import { mapReferenceItemToChecks } from '../src/validation/referenceAudit/referenceAuditMapper.js';
import { classifyManualItemCoverage } from '../src/validation/referenceAudit/coverageClassifier.js';
import { validateRunAgainstReference } from '../src/validation/referenceAudit/validationService.js';
import { buildValidationExportPayload } from '../src/validation/referenceAudit/validationExportService.js';
import { buildStorageRealityCheck } from '../src/analysis/storageRealityCheck.js';
import { collectFullAuditZip } from '../src/results/checkExportService.js';

test('Batch 10.2 parser merges OMfire-like multi CSV exports and reports ignored rows/columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-batch102-reference-'));
  const overview = path.join(dir, '01-overview.csv');
  const tech = path.join(dir, '02-technik.csv');
  fs.writeFileSync(overview, [
    'Audit Point,Finding,Bereich,Impact,Massnahme,Affected URLs,Affected Count,Data Source,OMfire Internal Note',
    'Technical SEO,,,,,,,,',
    '"Title zu lang","Produktseiten haben zu lange Title","HTML Head","Hoch","Title-Template kuerzen","https://example.com/p1; https://example.com/p2",200,"URL Facts","ignore me"'
  ].join('\n'), 'utf8');
  fs.writeFileSync(tech, [
    'Prüfpunkt / Thema,Beschreibung,Kategorie,Priorität,Recommendation',
    '"Canonical falsch","Kanonische URLs zeigen auf Filterseiten","Technical SEO","Medium","Canonical Pattern pruefen"'
  ].join('\n'), 'utf8');

  const parsed = parseReferenceAuditFiles([overview, tech]);
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.itemCount, 2);
  assert.equal(parsed.ignoredRows.length, 1);
  assert.equal(parsed.ignoredRows[0].reason, 'section_heading');
  assert.equal(parsed.importSummary.files.length, 2);
  assert.equal(parsed.importSummary.importedRows, 2);
  assert.ok(parsed.importSummary.ignoredColumns.includes('OMfire Internal Note'));
  assert.ok(parsed.items[0].sourceSheet.includes('01-overview'));
  assert.equal(parsed.items[0].priority, 'High');
  assert.equal(parsed.items[0].affectedCount, 200);
  assert.equal(parsed.items[1].category, 'technical-seo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Batch 10.2 tool extras classify false positives and indirect coverage separately', () => {
  const findings = [
    {
      id: 1,
      checkId: 'tech.title_too_long',
      status: 'Warning',
      priority: 'High',
      confidence: 'high',
      affectedCount: 10
    },
    {
      id: 2,
      checkId: 'tech.experimental_low_signal',
      status: 'Warning',
      priority: 'Low',
      confidence: 'low',
      affectedCount: 0
    }
  ];
  const coverageMatrix = [{
    coverageStatus: 'covered',
    mapping: { expectedCheckIds: ['tech.title_too_long'], possibleCheckIds: [] }
  }];
  const extras = classifyToolExtraFindings(findings, new Set(), coverageMatrix);
  assert.equal(extras.find((row) => row.checkId === 'tech.title_too_long').extraClassification, 'already_covered_indirectly');
  assert.equal(extras.find((row) => row.checkId === 'tech.experimental_low_signal').extraClassification, 'false_positive_candidate');
});

test('Batch 10.3 coverage classifies large manual scope as needs_larger_crawl on small samples', () => {
  const item = {
    id: 'manual-title-template',
    title: 'Title tag',
    description: '7,017 PDPs too long and a systematic PDP template issue.',
    category: 'HTML Head',
    priority: 'Medium',
    status: 'open',
    affectedCount: 7017
  };
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [{
    id: 1,
    checkId: 'tech.title_too_long',
    status: 'OK',
    priority: 'Medium',
    affectedCount: 0,
    category: 'HTML Head & Meta',
    checkName: 'Title too long',
    sampleUrlsJson: '[]'
  }], { run: { processedUrls: 120 } });
  assert.equal(coverage.coverageStatus, 'needs_larger_crawl');
});

test('Batch 10.3 manual OK item with matching OK tool check is covered', () => {
  const item = {
    id: 'manual-charset-ok',
    title: 'UTF-8 encoding',
    description: 'Charset in the HTTP header.',
    category: 'HTML Head',
    priority: 'High',
    status: 'ok'
  };
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [{
    id: 1,
    checkId: 'tech.charset_utf8_present',
    status: 'OK',
    priority: 'Medium',
    affectedCount: 0,
    category: 'HTML Head & Meta',
    checkName: 'Charset UTF-8 present',
    sampleUrlsJson: '[]'
  }], { run: { processedUrls: 120 } });
  assert.equal(coverage.coverageStatus, 'covered');
});

test('Batch 10.2 storage reality check separates run estimate from global DB and projects scale', () => {
  const db = setupDb();
  const runId = seedValidationRun(db);
  db.prepare(`
    INSERT INTO resources (runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty, responseHeadersJson)
    VALUES (?, 'https://example.com/a', 'https://cdn.example.com/app.js', 'script', 200, 120000, 'application/javascript', 1, '{"cache-control":"max-age=3600"}')
  `).run(runId);
  db.prepare(`
    INSERT INTO page_snapshots (runId, pageUrl, normalizedUrl, rawHtml, rawHtmlBytes)
    VALUES (?, 'https://example.com/a', 'https://example.com/a', '<html>debug</html>', 18)
  `).run(runId);

  const reality = buildStorageRealityCheck(db, runId, { dbPath: path.join(os.tmpdir(), 'does-not-exist.sqlite') });
  assert.equal(reality.runId, runId);
  assert.equal(reality.tableStats.find((row) => row.table === 'pages').rows, 1);
  assert.equal(reality.tableStats.find((row) => row.table === 'page_snapshots').rows, 1);
  assert.ok(reality.runSpecificEstimatedBytes > 0);
  assert.ok(reality.projections.estimated50kBytes > reality.projections.estimated10kBytes);
  assert.ok(reality.warnings.some((warning) => /snapshot/i.test(warning)));
  db.close();
});

test('Batch 10.2 validation exports include executive, false-positive/negative, roadmap and storage files', async () => {
  const db = setupDb();
  const runId = seedValidationRun(db);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-batch102-validation-'));
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
        title: 'Cache CDN Probleme',
        category: 'Performance',
        priority: 'Medium'
      }
    ]
  };
  const report = await validateRunAgainstReference(db, {
    runId,
    outDir,
    referenceFile: {
      filename: 'manual.json',
      content: JSON.stringify(reference)
    }
  });
  assert.equal(report.validationVersion, 2);
  assert.ok(report.referenceImportSummary);
  assert.ok(report.mappingConfidenceSummary);
  assert.ok(report.storageRealityCheck);
  assert.ok(report.checkRoadmap.length >= 1);
  assert.ok(report.scoreCalibrationNotes.length >= 1);

  const files = buildValidationExportPayload(report);
  assert.match(files['executive-validation-summary.md'], /Weighted coverage|Manual audit points/);
  assert.match(files['false-negatives.md'], /Cache CDN Probleme|False Negative/);
  assert.match(files['false-positives.md'], /false-positive candidates|False Positive/i);
  assert.match(files['check-roadmap.json'], /Cache CDN Probleme/);
  assert.match(files['storage-reality-check.md'], /Storage Reality Check/);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries['validation/executive-validation-summary.md']);
  assert.ok(zipEntries['validation/storage-reality-check.json']);
  assert.ok(zipEntries['validation/check-roadmap.md']);
  db.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('Batch 10.2 UI exposes extended validation export links and false-positive filter', () => {
  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /executive-validation-summary\.md/);
  assert.match(app, /false-negatives\.md/);
  assert.match(app, /false-positives\.md/);
  assert.match(app, /check-roadmap\.md/);
  assert.match(app, /storage-reality-check\.md/);
  assert.match(app, /extra:false_positive_candidate/);
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
    INSERT INTO pages (runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType, indexable, title, titleLength, metaDescription, metaDescriptionLength)
    VALUES (?, ?, ?, ?, 0, 200, 'text/html', 1, 'A very long example title for validation testing', 52, '', 0)
  `).run(runId, 'https://example.com/a', 'https://example.com/a', 'https://example.com/a');
  insertCheckResults(db, runId, [
    check('tech.title_too_long', 'HTML Head & Meta', 'Title too long', 'Warning', 'High', {
      affectedCount: 1,
      sampleUrls: ['https://example.com/a']
    }),
    check('tech.experimental_low_signal', 'QA', 'Experimental low signal', 'Warning', 'Low', {
      affectedCount: 0,
      sampleUrls: [],
      confidence: 'low'
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
    confidence: options.confidence || 'high',
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
