import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runChecks } from '../src/checks/checkEngine.js';
import { initDatabase } from '../src/db/database.js';
import { getSamplingSummary } from '../src/db/repositories.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('BreadcrumbList coverage evaluates eligible detail pages and excludes homepage/legal pages', async () => {
  const db = setupDb();

  const okRunId = createRun(db, 'tech');
  insertPage(db, okRunId, { url: 'https://example.com/blog/post', pageType: 'article', schemaTypes: ['BreadcrumbList'] });
  await runChecks(db, okRunId);
  assert.equal(result(db, okRunId, 'tech.breadcrumb_missing_low_coverage').status, 'OK');

  const warningRunId = createRun(db, 'tech');
  insertPage(db, warningRunId, { url: 'https://example.com/blog/post', pageType: 'article' });
  await runChecks(db, warningRunId);
  const warning = result(db, warningRunId, 'tech.breadcrumb_missing_low_coverage');
  assert.equal(warning.status, 'Warning');
  assert.equal(JSON.parse(warning.evidenceJson).eligiblePages, 1);

  const excludedRunId = createRun(db, 'tech');
  insertPage(db, excludedRunId, { url: 'https://example.com/', pageType: 'homepage', depth: 0 });
  insertPage(db, excludedRunId, { url: 'https://example.com/datenschutz', pageType: 'legal' });
  await runChecks(db, excludedRunId);
  assert.equal(result(db, excludedRunId, 'tech.breadcrumb_missing_low_coverage').status, 'NA');

  db.close();
});

test('legal noindex is separated from content noindex findings', async () => {
  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/datenschutz', pageType: 'legal', metaRobots: 'noindex,follow' });
  insertPage(db, runId, { url: 'https://example.com/blog/post', pageType: 'article', metaRobots: 'noindex,follow' });

  await runChecks(db, runId);
  const noindex = result(db, runId, 'tech.noindex_pages');
  const evidence = JSON.parse(noindex.evidenceJson);
  const samples = JSON.parse(noindex.sampleUrlsJson);

  assert.equal(noindex.status, 'Warning');
  assert.equal(noindex.affectedCount, 1);
  assert.equal(evidence.legalNoindexCount, 1);
  assert.equal(evidence.contentNoindexCount, 1);
  assert.deepEqual(samples, ['https://example.com/blog/post']);

  db.close();
});

test('about-link heuristic requires clear target or concise anchor and link samples are deduped', async () => {
  const db = setupDb();
  const runId = createRun(db, 'geo');
  insertPage(db, runId, { url: 'https://example.com/', pageType: 'homepage', depth: 0 });
  insertLink(db, runId, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/leistungen',
    anchorText: 'Unser Unternehmen stellt Leistungen vor'
  });
  insertLink(db, runId, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/unternehmen',
    anchorText: 'Mehr'
  });
  insertLink(db, runId, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/unternehmen',
    anchorText: 'Mehr'
  });
  insertLink(db, runId, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/kontakt',
    anchorText: 'Kontakt'
  });
  insertLink(db, runId, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/kontakt',
    anchorText: 'Kontakt'
  });

  await runChecks(db, runId);
  const aboutEvidence = JSON.parse(result(db, runId, 'geo.about_linked').evidenceJson);
  const contactEvidence = JSON.parse(result(db, runId, 'geo.contact_linked').evidenceJson);

  assert.equal(result(db, runId, 'geo.about_linked').status, 'OK');
  assert.equal(aboutEvidence.samples.length, 1);
  assert.equal(aboutEvidence.matchSource, 'targetUrl');
  assert.equal(aboutEvidence.matchedNeedle, '/unternehmen');
  assert.equal(contactEvidence.samples.length, 1);

  db.close();
});

test('webmanifest and weak FAQ opportunities stay out of top core findings', async () => {
  const db = setupDb();
  const runId = createRun(db, 'tech');
  insertPage(db, runId, { url: 'https://example.com/blog/post', pageType: 'article', featureFlags: { hasWeakFaqPattern: true } });

  await runChecks(db, runId);
  const webmanifest = result(db, runId, 'tech.webmanifest_missing');
  const faq = result(db, runId, 'tech.faqpage_missing_low_coverage');
  assert.equal(webmanifest.priority, 'Low');
  assert.equal(webmanifest.findingType, 'opportunity');
  assert.equal(faq.status, 'NA');
  assert.equal(faq.findingType, 'opportunity');

  const { html } = generateReportHtml(db, runId);
  const coreSection = section(html, 'Action Items', 'Confirmed / Needs Fix Findings');
  assert.doesNotMatch(coreSection, /Webmanifest missing/);
  assert.doesNotMatch(coreSection, /FAQPage missing/);

  db.close();
});

test('sampling summary and report expose disabled/unavailable messages', () => {
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
    errorMessage: 'local browsers unavailable'
  });

  const summary = getSamplingSummary(db, runId);
  assert.equal(summary.renderingStatus, 'unavailable');
  assert.equal(summary.lighthouseStatus, 'unavailable');
  assert.equal(summary.renderingStatusMessage, 'Template rendering sampling unavailable. Reason: local browser/runtime unavailable. Fix: npx playwright install chromium.');
  assert.equal(summary.lighthouseStatusMessage, 'Template Lighthouse sampling unavailable. Reason: local Lighthouse run failed or was unavailable. Fix: npm install lighthouse chrome-launcher.');

  const { html } = generateReportHtml(db, runId);
  assert.match(html, /Template rendering sampling unavailable\. Reason: local browser\/runtime unavailable\. Fix: npx playwright install chromium\./);
  assert.match(html, /Template Lighthouse sampling unavailable\. Reason: local Lighthouse run failed or was unavailable\. Fix: npm install lighthouse chrome-launcher\./);

  db.close();
});

test('report status distinguishes completed reports from live interim reports', () => {
  const db = setupDb();
  const runningRunId = createRun(db, 'tech', { status: 'running', currentPhase: 'crawling' });
  const completedRunId = createRun(db, 'tech', { status: 'completed', currentPhase: 'completed' });

  const running = generateReportHtml(db, runningRunId);
  const completed = generateReportHtml(db, completedRunId);
  assert.match(running.html, /Status running \(Live \/ Interim report\)/);
  assert.match(completed.html, /Status completed/);

  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createRun(db, auditType = 'both', overrides = {}) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain) VALUES ('example.com', 'https://example.com')").run().lastInsertRowid;
  const row = {
    status: 'completed',
    auditType,
    currentPhase: 'completed',
    enablePlaywrightSampling: 0,
    enableLighthouseSampling: 0,
    samplesTotal: 0,
    samplesProcessed: 0,
    ...overrides
  };
  return db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency, respectRobotsTxt,
      currentPhase, enablePlaywrightSampling, enableLighthouseSampling, samplesTotal, samplesProcessed
    )
    VALUES (@projectId, @status, @auditType, 10, 2, 1, 0, @currentPhase, @enablePlaywrightSampling, @enableLighthouseSampling, @samplesTotal, @samplesProcessed)
  `).run({ ...row, projectId }).lastInsertRowid;
}

function insertPage(db, runId, {
  url,
  pageType = 'other',
  depth = 1,
  schemaTypes = [],
  metaRobots = '',
  featureFlags = {}
}) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, titleLength, metaDescription, metaDescriptionLength,
      h1Json, h1Count, h2Json, canonical, htmlLang, viewport, metaRobots,
      wordCountRaw, rawTextLength, rawHtmlSize, internalLinksCount, externalLinksCount,
      schemaTypesJson, imagesCount, imagesWithoutAltCount, responseHeadersJson, loadTimeMs,
      ttfbMs, consoleErrorsJson, renderedH1Json, renderedH1Count, renderedLinksCount,
      ogJson, featureFlagsJson, pageType, hasFaqPattern
    )
    VALUES (?, ?, ?, ?, ?, 200, 'text/html; charset=utf-8',
      1, 'Example Title', 13, 'Example description long enough for tests', 41,
      '["Example H1"]', 1, '[]', ?, 'en', 'width=device-width, initial-scale=1', ?,
      120, 600, 1000, 3, 1,
      ?, 0, 0, '{}', 10,
      20, '[]', '[]', 0, 3,
      '{}', ?, ?, 0)
  `).run(
    runId,
    url,
    url,
    url,
    depth,
    url,
    metaRobots,
    JSON.stringify(schemaTypes),
    JSON.stringify(featureFlags),
    pageType
  );
}

function insertLink(db, runId, { sourceUrl, targetUrl, anchorText }) {
  db.prepare(`
    INSERT INTO page_links (runId, sourceUrl, targetUrl, normalizedTargetUrl, linkType, anchorText)
    VALUES (?, ?, ?, ?, 'internal', ?)
  `).run(runId, sourceUrl, targetUrl, targetUrl, anchorText);
}

function insertSample(db, runId, { playwrightStatus, lighthouseStatus, errorMessage = '' }) {
  db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
    )
    VALUES (?, 'article::1', 'https://example.com/blog/post', 'https://example.com/blog/post', 'template_cluster_sample', ?, ?, ?)
  `).run(runId, playwrightStatus, lighthouseStatus, errorMessage);
}

function result(db, runId, checkId) {
  return db.prepare('SELECT * FROM check_results WHERE runId = ? AND checkId = ?').get(runId, checkId);
}

function generateReportHtml(db, runId) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-batch61-'));
  try {
    process.chdir(tempDir);
    const reportPath = generateReport(db, runId);
    return { html: fs.readFileSync(reportPath, 'utf8'), tempDir };
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function section(html, heading, nextHeading) {
  return html.split(`<h2>${heading}</h2>`)[1].split(`<h2>${nextHeading}</h2>`)[0];
}
