import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { upsertFindingReview } from '../src/db/repositories.js';
import { collectCsvExport, listCsvExports } from '../src/reports/csvExporter.js';
import { generateReport } from '../src/reports/reportGenerator.js';

test('report snapshot structure keeps central sections in order and evidence collapsed', () => {
  const db = setupDb();
  const runId = createFixtureRun(db);
  const html = generateReportHtml(db, runId);

  assert.deepEqual(h2Headings(html), [
    'Executive Summary',
    'Full Audit Downloads',
    'Action Items',
    'Confirmed / Needs Fix Findings',
    'GEO Opportunities',
    'Security Best Practices',
    'Media Findings',
    'Template Performance & Rendering',
    'Run Comparison',
    'Review Summary',
    'Technical Appendix',
    'Passed Checks',
    'Not Applicable Checks',
    'All Findings'
  ]);

  assert.match(html, /<h2>Executive Summary<\/h2>/);
  assert.match(html, /Action Items/);
  assert.match(html, /Review Progress|reviewProgress/);
  assert.match(html, /<details><summary>Evidence/);
  assert.match(html, /<details><summary>1 sample/);
  assert.match(html, /Status completed/);
  assert.match(html, /Opportunities are optional improvements, not necessarily errors\./);
  assert.match(html, /Template Lighthouse sampling unavailable\. Reason:/);
  assert.match(html, /Score methodology:/);

  const coreSection = section(html, 'Action Items', 'Confirmed / Needs Fix Findings');
  assert.match(coreSection, /Core title issue/);
  assert.doesNotMatch(coreSection, /False positive core issue/);
  assert.doesNotMatch(coreSection, /Security header issue/);
  assert.doesNotMatch(coreSection, /GEO opportunity issue/);

  const templateSection = section(html, 'Template Performance & Rendering', 'Run Comparison');
  assert.doesNotMatch(templateSection, /<th>performance<\/th>/);
  assert.match(templateSection, /Template samples were selected successfully, but performance metrics were not collected because Template Lighthouse sampling was unavailable\./);

  assert.doesNotMatch(stripDetailsContent(html), /\bundefined\b|\bnull\b/);
  db.close();
});

test('running report is marked live interim and escaped finding text cannot inject HTML', () => {
  const db = setupDb();
  const runId = createFixtureRun(db, { status: 'running', currentPhase: 'checking' });
  const html = generateReportHtml(db, runId);

  assert.match(html, /Status running \(Live \/ Interim report\)/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  db.close();
});

test('CSV export headers remain available for every export type', () => {
  const db = setupDb();
  const runId = createFixtureRun(db);

  for (const type of listCsvExports()) {
    const header = collectCsvExport(db, runId, type).split('\n')[0];
    assert.ok(header.length > 0, `${type} should expose a CSV header`);
  }

  const findingsHeader = collectCsvExport(db, runId, 'findings').split('\n')[0];
  assert.ok(findingsHeader.includes('effectiveStatus'));
  assert.ok(findingsHeader.includes('reportGroupingKey'));
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createFixtureRun(db, overrides = {}) {
  const projectId = db.prepare("INSERT INTO projects (inputDomain, finalDomain, brandName) VALUES ('example.com', 'https://example.com', 'Example')").run().lastInsertRowid;
  const run = {
    status: 'completed',
    currentPhase: 'completed',
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1,
    samplesTotal: 1,
    samplesProcessed: 1,
    ...overrides
  };
  const runId = db.prepare(`
    INSERT INTO runs (
      projectId, status, auditType, maxUrls, maxDepth, concurrency,
      respectRobotsTxt, currentPhase, processedUrls, successfulUrls, failedUrls,
      enablePlaywrightSampling, enableLighthouseSampling, samplesTotal, samplesProcessed,
      startedAt
    )
    VALUES (@projectId, @status, 'both', 20, 2, 1,
      0, @currentPhase, 3, 3, 0,
      @enablePlaywrightSampling, @enableLighthouseSampling, @samplesTotal, @samplesProcessed,
      CURRENT_TIMESTAMP)
  `).run({ ...run, projectId }).lastInsertRowid;

  insertPage(db, runId, 'https://example.com/');
  insertTemplateCluster(db, runId);
  insertSamplingUnavailable(db, runId);
  insertAssets(db, runId);

  const falsePositiveId = insertCheckResult(db, runId, {
    checkId: 'tech.false_positive_core',
    category: 'Technical SEO',
    status: 'Error',
    priority: 'High',
    finding: 'False positive core issue'
  });
  upsertFindingReview(db, runId, falsePositiveId, { reviewStatus: 'false_positive', actionStatus: 'wont_do' });

  insertCheckResult(db, runId, {
    checkId: 'tech.title_missing',
    category: 'HTML Head & Meta',
    status: 'Error',
    priority: 'High',
    finding: 'Core title issue',
    affectedCount: 3,
    score: 25
  });
  insertCheckResult(db, runId, {
    checkId: 'geo.speakable_present',
    category: 'GEO Opportunities',
    status: 'Warning',
    priority: 'Low',
    finding: 'GEO opportunity issue',
    findingType: 'opportunity',
    reportGroupingKey: 'schema.speakable'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.article_coverage_on_article_like_pages',
    category: 'Structured Data',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Schema coverage issue',
    findingType: 'opportunity',
    reportGroupingKey: 'schema.article'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.hsts_header',
    category: 'Security Best Practice',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Security header issue',
    findingType: 'best_practice'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.images_without_alt',
    category: 'Media SEO',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Media image issue'
  });
  insertCheckResult(db, runId, {
    checkId: 'template.console_errors',
    category: 'Template Performance & Rendering',
    status: 'Warning',
    priority: 'Medium',
    finding: 'Template rendering issue'
  });
  insertCheckResult(db, runId, {
    checkId: 'tech.escaped_text',
    category: 'Technical SEO',
    status: 'Warning',
    priority: 'Low',
    finding: '<script>alert(1)</script>',
    recommendation: 'Avoid <img src=x onerror=alert(1)>',
    evidenceJson: '{"html":"<img src=x onerror=alert(1)>"}'
  });

  return runId;
}

function insertPage(db, runId, url) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
      indexable, title, titleLength, metaDescription, metaDescriptionLength,
      h1Json, h1Count, h2Json, canonical, htmlLang, viewport,
      wordCountRaw, rawTextLength, rawHtmlSize, internalLinksCount, externalLinksCount,
      schemaTypesJson, imagesCount, imagesWithoutAltCount, responseHeadersJson, loadTimeMs,
      ttfbMs, consoleErrorsJson, renderedH1Json, renderedH1Count, renderedLinksCount,
      ogJson, featureFlagsJson, pageType, hasLists
    )
    VALUES (?, ?, ?, ?, 0, 200, 'text/html; charset=utf-8',
      1, 'Fixture Page', 12, 'Fixture description long enough for report tests', 48,
      '["Fixture"]', 1, '[]', ?, 'en', 'width=device-width, initial-scale=1',
      120, 600, 1000, 2, 1,
      '["Organization"]', 0, 0, '{}', 10,
      20, '[]', '[]', 0, 2,
      '{}', '{}', 'homepage', 1)
  `).run(runId, url, url, url, url);
}

function insertTemplateCluster(db, runId) {
  db.prepare(`
    INSERT INTO template_clusters (
      runId, clusterKey, pageType, urlPattern, urlCount, indexableCount,
      nonIndexableCount, statusCodeSummaryJson, schemaTypesSummaryJson,
      avgWordCount, avgInternalLinks, avgExternalLinks, sampleUrlsJson
    )
    VALUES (?, 'homepage::root', 'homepage', '/', 1, 1,
      0, '{"200":1}', '{"Organization":1}',
      120, 2, 1, '["https://example.com/"]')
  `).run(runId);
}

function insertSamplingUnavailable(db, runId) {
  db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
    )
    VALUES (?, 'homepage::root', 'https://example.com/', 'https://example.com/', 'template_cluster_sample', 'unavailable', 'unavailable', 'local browser unavailable')
  `).run(runId);
}

function insertAssets(db, runId) {
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES
      (?, 'robots', 'https://example.com/robots.txt', 200, 'User-agent: *\\nAllow: /', '{}'),
      (?, 'llms', 'https://example.com/llms.txt', 200, '# llms', '{}')
  `).run(runId, runId);
}

function insertCheckResult(db, runId, overrides = {}) {
  const row = {
    checkId: 'tech.fixture',
    category: 'Technical SEO',
    checkName: 'Fixture Check',
    status: 'Warning',
    priority: 'Medium',
    effort: 'M',
    score: 55,
    finding: 'Fixture finding',
    details: 'Based on stored fixture evidence.',
    recommendation: 'Review fixture recommendation.',
    affectedCount: 1,
    sampleUrlsJson: '["https://example.com/"]',
    evidenceJson: '{"affectedCount":1,"sampleUrls":["https://example.com/"]}',
    reportGroupingKey: 'core.fixture',
    findingType: 'core_issue',
    confidence: 'high',
    reviewRecommended: 0,
    relatedCheckIdsJson: '[]',
    ...overrides
  };
  return db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson,
      reportGroupingKey, findingType, confidence, reviewRecommended, relatedCheckIdsJson
    )
    VALUES (
      @runId, @checkId, @category, @checkName, @status, @priority, @effort, @score,
      @finding, @details, @recommendation, @affectedCount, @sampleUrlsJson, @evidenceJson,
      @reportGroupingKey, @findingType, @confidence, @reviewRecommended, @relatedCheckIdsJson
    )
  `).run({ ...row, runId }).lastInsertRowid;
}

function generateReportHtml(db, runId) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-batch62-'));
  try {
    process.chdir(tempDir);
    const reportPath = generateReport(db, runId);
    return fs.readFileSync(reportPath, 'utf8');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function h2Headings(html) {
  return [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1]);
}

function section(html, heading, nextHeading) {
  return html.split(`<h2>${heading}</h2>`)[1].split(`<h2>${nextHeading}</h2>`)[0];
}

function stripDetailsContent(html) {
  return html.replace(/<details>[\s\S]*?<\/details>/g, '<details></details>');
}
