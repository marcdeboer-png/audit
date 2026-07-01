import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runChecks, loadResultsWithScores } from '../src/checks/checkEngine.js';
import { initDatabase } from '../src/db/database.js';
import { getReviewSummary, getSamplingSummary } from '../src/db/repositories.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';

test('OK and informational NA checks are not open review tasks or action items', () => {
  const db = setupDb();
  const runId = createRun(db, 'both');
  insertCheckResult(db, runId, {
    checkId: 'tech.ok_positive',
    status: 'OK',
    finding: 'Positive control passed.',
    reviewRecommended: 1
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.not_applicable_info',
    status: 'NA',
    finding: 'Optional data unavailable.',
    findingType: 'info',
    confidence: 'low',
    reviewRecommended: 0
  });

  const summary = getReviewSummary(db, runId);
  assert.equal(summary.totalFindings, 2);
  assert.equal(summary.reviewableFindings, 0);
  assert.equal(summary.reviewRecommendedCount, 0);
  assert.equal(summary.open, 0);
  assert.equal(summary.notRequired, 2);

  const results = loadResultsWithScores(db, runId).results;
  assert.equal(results.find((row) => row.checkId === 'tech.ok_positive').displayReviewStatus, 'not_required');
  assert.equal(results.find((row) => row.checkId === 'tech.ok_positive').displayActionStatus, 'none');

  const html = generateReportHtml(db, runId);
  assert.doesNotMatch(section(html, 'Action Items', 'Confirmed / Needs Fix Findings'), /Positive control passed/);
  assert.match(section(html, 'Passed Checks', 'Not Applicable Checks'), /Positive control passed/);
  assert.match(section(html, 'All Findings', null), /Positive control passed/);
  db.close();
});

test('AI crawler policy checks are GEO opportunities, not core issues', async () => {
  const db = setupDb();
  const runId = createRun(db, 'geo');
  insertAsset(db, runId, 'robots', 'https://example.com/robots.txt', 200, 'User-agent: *\nAllow: /');
  insertAsset(db, runId, 'llms', 'https://example.com/llms.txt', 200, '# llms');
  insertAsset(db, runId, 'llms_full', 'https://example.com/llms-full.txt', 404, 'not found');

  await runChecks(db, runId);
  const gptbot = result(db, runId, 'geo.robots_mentions_gptbot');
  assert.equal(gptbot.category, 'AI Crawler Policy');
  assert.equal(gptbot.priority, 'Low');
  assert.equal(gptbot.findingType, 'opportunity');

  const html = generateReportHtml(db, runId);
  assert.match(section(html, 'GEO Opportunities', 'Security Best Practices'), /geo\.robots_mentions_gptbot/);
  assert.doesNotMatch(section(html, 'Action Items', 'Confirmed / Needs Fix Findings'), /geo\.robots_mentions_gptbot/);
  db.close();
});

test('llms-full 500 without reference is low optional opportunity', async () => {
  const db = setupDb();
  const runId = createRun(db, 'geo');
  insertAsset(db, runId, 'robots', 'https://example.com/robots.txt', 200, 'User-agent: *\nAllow: /');
  insertAsset(db, runId, 'llms', 'https://example.com/llms.txt', 200, '# llms');
  insertAsset(db, runId, 'llms_full', 'https://example.com/llms-full.txt', 500, 'server error');

  await runChecks(db, runId);
  const row = result(db, runId, 'geo.llms_full_txt_present');
  assert.equal(row.status, 'Warning');
  assert.equal(row.priority, 'Low');
  assert.equal(row.findingType, 'opportunity');
  assert.match(row.finding, /returned 500 instead of 2xx and is not referenced/);
  db.close();
});

test('sampling unavailable report uses concise reason/fix and avoids empty metric tables', () => {
  const db = setupDb();
  const runId = createRun(db, 'tech', {
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1,
    samplesTotal: 1,
    samplesProcessed: 1
  });
  insertSample(db, runId, {
    playwrightStatus: 'unavailable',
    lighthouseStatus: 'unavailable',
    errorMessage: "Cannot find package 'lighthouse' imported from /tmp/audit-fixture/very-long-stack.js"
  });

  const summary = getSamplingSummary(db, runId);
  assert.match(summary.renderingStatusMessage, /Template rendering sampling unavailable\. Reason:/);
  assert.match(summary.lighthouseStatusMessage, /Template Lighthouse sampling unavailable\. Reason: package lighthouse is not installed/);

  const html = generateReportHtml(db, runId);
  const templateSection = section(html, 'Template Performance & Rendering', 'Run Comparison');
  assert.match(templateSection, /Template samples were selected successfully, but performance metrics were not collected because Template Lighthouse sampling was unavailable\./);
  assert.doesNotMatch(templateSection, /<th>avgPerformanceScore<\/th>/);
  assert.match(templateSection, /<summary>Debug sample errors<\/summary>/);
  db.close();
});

test('HTML report and full exports use the same display review summary counts', () => {
  const db = setupDb();
  const runId = createRun(db, 'both');
  insertCheckResult(db, runId, {
    checkId: 'tech.ok_positive',
    status: 'OK',
    finding: 'Positive control passed.',
    confidence: 'low',
    reviewRecommended: 1,
    findingType: 'core_issue',
    reportGroupingKey: 'passed_checks'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.title_missing',
    category: 'HTML Head & Meta',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Title issue.',
    confidence: 'high',
    reviewRecommended: 1,
    findingType: 'core_issue'
  });
  insertCheckResult(db, runId, {
    checkId: 'geo.ai_bots_policy_summary',
    category: 'AI Crawler Policy',
    status: 'Warning',
    priority: 'Low',
    finding: 'AI bot policy is unclear.',
    confidence: 'high',
    reviewRecommended: 0,
    findingType: 'core_issue'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.webmanifest_missing',
    category: 'Browser Metadata Opportunity',
    status: 'Warning',
    priority: 'Low',
    finding: 'Webmanifest missing.',
    confidence: 'high',
    reviewRecommended: 0,
    findingType: 'core_issue'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.hsts_header',
    category: 'Security Best Practice',
    status: 'Warning',
    priority: 'Medium',
    finding: 'HSTS missing.',
    confidence: 'high',
    reviewRecommended: 0,
    findingType: 'core_issue'
  });

  const summary = getReviewSummary(db, runId);
  assert.equal(summary.reviewRecommendedCount, 1);
  assert.equal(summary.passedChecks, 1);
  assert.equal(summary.notRequired, 1);
  assert.equal(summary.actionItemCount, 1);
  assert.equal(summary.opportunityCount, 2);
  assert.equal(summary.securityBestPracticeCount, 1);

  const html = generateReportHtml(db, runId);
  assert.match(html, /Full Audit Downloads/);
  assert.match(html, new RegExp(`/api/audits/${runId}/export/full\\.zip`));
  assert.match(html, new RegExp(`download="audit-${runId}-full-audit\\.zip"`));
  assert.match(html, new RegExp(`/api/audits/${runId}/export/full\\.json`));
  assert.match(html, new RegExp(`download="audit-${runId}-full-audit\\.json"`));
  assert.match(html, /Download links require the local audit server to be running/);
  assert.match(html, /1 review-recommended finding\(s\) require review\./);
  assert.doesNotMatch(html, /5 review-recommended finding/);

  const passedSection = section(html, 'Passed Checks', 'Not Applicable Checks');
  assert.match(passedSection, /tech\.ok_positive/);
  assert.match(passedSection, /not_required/);
  assert.match(passedSection, /none/);
  assert.doesNotMatch(passedSection, /review recommended/);

  const geoSection = section(html, 'GEO Opportunities', 'Security Best Practices');
  assert.match(geoSection, /geo\.ai_bots_policy_summary/);
  assert.match(geoSection, /tech\.webmanifest_missing/);
  assert.match(geoSection, /opportunity/);
  assert.doesNotMatch(geoSection, /core_issue/);

  const securitySection = section(html, 'Security Best Practices', 'Media Findings');
  assert.match(securitySection, /tech\.hsts_header/);
  assert.match(securitySection, /best_practice/);
  assert.doesNotMatch(securitySection, /core_issue/);

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  assert.equal(fullJson.summary.reviewSummary.reviewRecommendedCount, summary.reviewRecommendedCount);
  assert.equal(fullJson.summary.display.reviewRecommendedCount, summary.reviewRecommendedCount);
  assert.equal(fullJson.summary.display.actionItemCount, summary.actionItemCount);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  const zipSummary = JSON.parse(zipEntries['summary/audit-summary.json']);
  assert.equal(zipSummary.reviewSummary.reviewRecommendedCount, summary.reviewRecommendedCount);
  assert.equal(zipSummary.display.actionItemCount, summary.actionItemCount);
  db.close();
});

test('Template Lighthouse unavailable is reported separately from completed template rendering', () => {
  const db = setupDb();
  const runId = createRun(db, 'tech', {
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1,
    samplesTotal: 1,
    samplesProcessed: 1
  });
  insertSample(db, runId, {
    playwrightStatus: 'success',
    lighthouseStatus: 'unavailable',
    errorMessage: 'Lighthouse: local Lighthouse run failed'
  });

  const summary = getSamplingSummary(db, runId);
  assert.equal(summary.renderingStatus, 'completed');
  assert.equal(summary.lighthouseStatus, 'unavailable');
  assert.match(summary.renderingStatusMessage, /Template rendering sampling completed/);
  assert.match(summary.lighthouseStatusMessage, /Template Lighthouse sampling unavailable/);

  const html = generateReportHtml(db, runId);
  const templateSection = section(html, 'Template Performance & Rendering', 'Run Comparison');
  assert.match(templateSection, /Template rendering sampling completed/);
  assert.match(templateSection, /Template Lighthouse sampling unavailable/);
  assert.doesNotMatch(templateSection, /Rendering sampling unavailable/);
  db.close();
});

test('findings CSV remains compatible and includes additive display semantics', () => {
  const db = setupDb();
  const runId = createRun(db, 'both');
  insertCheckResult(db, runId, { checkId: 'tech.warning', status: 'Warning', findingType: 'core_issue' });
  const csv = collectCsvExport(db, runId, 'findings');
  const header = csv.split('\n')[0].split(',');
  assert.ok(header.includes('checkId'));
  assert.ok(header.includes('effectiveStatus'));
  assert.ok(header.includes('displayStatus'));
  assert.ok(header.includes('displayReviewStatus'));
  assert.ok(header.includes('reportSection'));
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db, auditType = 'both', overrides = {}) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain, brandName) VALUES ('example.com', 'https://example.com', 'Example')").run().lastInsertRowid;
  const run = {
    status: 'completed',
    currentPhase: 'completed',
    enablePlaywrightSampling: 0,
    enableLighthouseSampling: 0,
    samplesTotal: 0,
    samplesProcessed: 0,
    ...overrides
  };
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, startedAt,
      enablePlaywrightSampling, enableLighthouseSampling, samplesTotal, samplesProcessed
    )
    VALUES (?, ?, ?, 20, 2, 1, 0, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
  `).run(
    projectId,
    run.status,
    auditType,
    run.currentPhase,
    run.enablePlaywrightSampling,
    run.enableLighthouseSampling,
    run.samplesTotal,
    run.samplesProcessed
  ).lastInsertRowid;
}

function insertCheckResult(db, runId, overrides = {}) {
  const row = {
    checkId: 'tech.fixture',
    category: 'Technical SEO',
    checkName: overrides.checkId || 'Fixture',
    status: 'Warning',
    priority: 'Medium',
    effort: 'M',
    score: 5,
    finding: 'Fixture finding',
    details: 'Fixture details.',
    recommendation: 'Fixture recommendation.',
    affectedCount: 1,
    sampleUrlsJson: '["https://example.com/"]',
    evidenceJson: '{"fixture":true}',
    reportGroupingKey: overrides.checkId || 'tech.fixture',
    findingType: 'core_issue',
    confidence: 'high',
    reviewRecommended: 0,
    ...overrides
  };
  db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson,
      evidenceJson, reportGroupingKey, findingType, confidence, reviewRecommended
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    row.checkId,
    row.category,
    row.checkName,
    row.status,
    row.priority,
    row.effort,
    row.score,
    row.finding,
    row.details,
    row.recommendation,
    row.affectedCount,
    row.sampleUrlsJson,
    row.evidenceJson,
    row.reportGroupingKey,
    row.findingType,
    row.confidence,
    row.reviewRecommended ? 1 : 0
  );
}

function insertAsset(db, runId, type, url, statusCode, content) {
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, ?, ?, ?, ?, '{}')
  `).run(runId, type, url, statusCode, content);
}

function insertSample(db, runId, { playwrightStatus, lighthouseStatus, errorMessage }) {
  db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterKey, url, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
    )
    VALUES (?, 'homepage:/', 'https://example.com/', 'fixture', ?, ?, ?)
  `).run(runId, playwrightStatus, lighthouseStatus, errorMessage);
}

function result(db, runId, checkId) {
  return db.prepare('SELECT * FROM check_results WHERE runId = ? AND checkId = ?').get(runId, checkId);
}

function generateReportHtml(db, runId) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-semantics-'));
  try {
    process.chdir(tempDir);
    return fs.readFileSync(generateReport(db, runId), 'utf8');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function section(html, heading, nextHeading) {
  const after = html.split(`<h2>${heading}</h2>`)[1] || '';
  return nextHeading ? after.split(`<h2>${nextHeading}</h2>`)[0] : after;
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
