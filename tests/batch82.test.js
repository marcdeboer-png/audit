import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  updateProject,
  updateRun,
  upsertFindingReview
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { thresholds } from '../src/checks/config/thresholds.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectCheckDetailCsv, collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('full ZIP export contains summaries, CSVs, check CSVs, reports and warnings', () => {
  const db = setupDb();
  const fixture = seedBatch82Fixture(db);

  const payload = collectFullAuditZip(db, fixture.runId, ['findings', 'pages', 'reviews', 'status-summary']);
  assert.equal(payload.filename, `audit-${fixture.runId}-full-audit.zip`);
  const entries = readStoredZip(payload.buffer);

  assert.ok(entries['summary/audit-summary.json']);
  assert.ok(entries['summary/run-config.json']);
  assert.ok(entries['summary/review-summary.json']);
  assert.ok(entries['summary/schedule-context.json']);
  assert.ok(entries['csv/findings.csv'].includes('effectivePriority'));
  assert.ok(entries['csv/urls.csv'].includes('hasFaqPattern'));
  assert.ok(entries['csv/reviews.csv'].includes('displayReviewStatus'));
  assert.ok(entries['checks/audit-1-tech.title_too_short.csv'].includes('checkId,title,category,checkResultId,displayStatus'));
  assert.ok(entries['reports/audit-report.html'].includes('Review Summary'));
  assert.ok(entries['export-warnings.json']);
  assert.doesNotThrow(() => JSON.parse(entries['export-warnings.json']));

  const fallback = JSON.parse(collectFullAuditJson(db, fixture.runId, ['findings']).body);
  assert.equal(fallback.format, 'full-audit-json-fallback');
  assert.ok(fallback.files['findings.csv']);

  db.close();
});

test('full.zip API returns application zip and keeps JSON fallback available', async () => {
  const temp = useTempAuditDb('batch82-zip-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const fixture = seedBatch82Fixture(seedDb);
  seedDb.close();

  const apiPort = 35000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: temp.dbPath, PORT: String(apiPort), SCHEDULER_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);
    const zipResponse = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${fixture.runId}/export/full.zip`);
    assert.equal(zipResponse.status, 200);
    assert.match(zipResponse.headers.get('content-type') || '', /application\/zip/);
    assert.equal(zipResponse.headers.get('content-disposition'), `attachment; filename="audit-${fixture.runId}-full-audit.zip"`);
    const entries = readStoredZip(Buffer.from(await zipResponse.arrayBuffer()));
    assert.ok(entries['summary/audit-summary.json']);
    assert.ok(entries['csv/findings.csv']);
    assert.ok(entries['checks/audit-1-tech.hsts_header.csv']);
    assert.ok(entries['export-warnings.json']);

    const jsonResponse = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${fixture.runId}/export/full.json`);
    assert.equal(jsonResponse.status, 200);
    assert.match(jsonResponse.headers.get('content-type') || '', /application\/json/);
    assert.equal(jsonResponse.headers.get('content-disposition'), `attachment; filename="audit-${fixture.runId}-full-audit.json"`);
    assert.equal((await jsonResponse.json()).format, 'full-audit-json-fallback');

    const zipAlias = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${fixture.runId}/export/full-audit.zip`);
    assert.equal(zipAlias.status, 200);
    assert.match(zipAlias.headers.get('content-type') || '', /application\/zip/);
    assert.equal(zipAlias.headers.get('content-disposition'), `attachment; filename="audit-${fixture.runId}-full-audit.zip"`);

    const jsonAlias = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${fixture.runId}/export/full-audit.json`);
    assert.equal(jsonAlias.status, 200);
    assert.match(jsonAlias.headers.get('content-type') || '', /application\/json/);
    assert.equal(jsonAlias.headers.get('content-disposition'), `attachment; filename="audit-${fixture.runId}-full-audit.json"`);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
  }
});

test('per-check CSV headers and detail handlers are stable', () => {
  const db = setupDb();
  const fixture = seedBatch82Fixture(db);

  const titleCsv = collectCheckDetailCsv(db, fixture.runId, fixture.checks.titleTooShort).csv;
  assert.ok(titleCsv.startsWith('checkId,title,category,checkResultId,displayStatus,displayPriority,displayFindingType,displayReviewStatus,displayActionStatus,affectedCount,recommendation,rawStatus,rawPriority,rawFindingType,confidence,reportSection,reviewRecommended,status,priority,effectivePriority,findingType,reviewStatus,actionStatus,isActionable,displayReviewRecommended,URL,Title,Title Length'));
  assert.match(titleCsv, /tech\.title_too_short/);
  assert.match(titleCsv, /needs_fix/);

  const emptyCsv = collectCheckDetailCsv(db, fixture.runId, fixture.checks.emptyOk).csv;
  assert.match(emptyCsv, /No affected rows for this check/);

  const title = getCheckDetail(db, fixture.runId, fixture.checks.titleTooShort);
  assert.equal(title.rows[0].titleLength < thresholds.titleTooShort, true);

  const image = getCheckDetail(db, fixture.runId, fixture.checks.imageAlt);
  assert.equal(image.rows[0].imageUrl, 'https://example.com/missing-alt.jpg');

  const ttfb = getCheckDetail(db, fixture.runId, fixture.checks.highTtfb);
  assert.equal(Number(ttfb.rows[0].ttfbMs) > thresholds.highTtfbMs, true);

  const security = getCheckDetail(db, fixture.runId, fixture.checks.hsts);
  assert.equal(security.rows[0].missingHeader, 'strict-transport-security');

  const generic = getCheckDetail(db, fixture.runId, fixture.checks.generic);
  assert.equal(generic.rows.some((row) => row.evidenceKey === 'customEvidence'), true);

  db.close();
});

test('UI smoke covers compact start, card worklist, ZIP export and review detail panel', async () => {
  const fallback = () => {
    const appJs = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
    assert.match(appJs, /URL oder Domain/);
    assert.match(appJs, /Schnellcheck/);
    assert.match(appJs, /Advanced Settings/);
    assert.match(appJs, /Letzte Läufe/);
    assert.match(appJs, /Full Audit Export ZIP/);
    assert.match(appJs, />ToDo</);
    assert.match(appJs, /Technische Details/);
    assert.match(appJs, /Runtime-Provenienz/);
    assert.match(appJs, /Das ist der Prüfpunkt/);
    assert.match(appJs, /<h3>Review<\/h3>/);
    assert.match(appJs, /isActionItemResult/);
    assert.match(css, /\.check-card/);
  };

  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  } catch {
    fallback();
    return;
  }

  const appJs = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  const sunburstJs = fs.readFileSync(new URL('../src/public/sunburst.js', import.meta.url), 'utf8');
  const index = fs.readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const page = await browser.newPage();
  try {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: appJs });
      if (url.pathname === '/sunburst.js') return route.fulfill({ contentType: 'application/javascript', body: sunburstJs });
      if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (url.pathname === '/api/audits') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ audits: [] }) });
      if (url.pathname === '/api/audits/1/results') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(mockResultsPayload()) });
      if (url.pathname === '/api/audits/1/pages') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ page: 1, limit: 50, total: 0, pages: [] }) });
      if (url.pathname === '/api/audits/1/templates') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ templates: [] }) });
      if (url.pathname === '/api/audits/1/template-performance') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ templates: [], summary: {} }) });
      if (url.pathname === '/api/audits/1/check-results/101/details') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(mockCheckDetail()) });
      return route.fulfill({ contentType: 'text/html', body: index });
    });

    await page.goto('http://audit.local/#');
    assert.equal(await page.locator('input[name="domain"]').count(), 1);
    assert.equal(await page.getByText('Schnellcheck').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Advanced Settings' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Audit starten' }).count(), 1);
    assert.ok(await page.getByText('Letzte Läufe').count() >= 1);

    await page.goto('http://audit.local/#results/1');
    await page.waitForSelector('.check-card');
    assert.equal(await page.getByText('Full Audit Export ZIP').count(), 1);
    assert.equal(await page.locator('a[href="/api/audits/1/export/full.zip"][download="audit-1-full-audit.zip"]').count(), 1);
    assert.equal(await page.locator('a[href="/api/audits/1/export/full.json"][download="audit-1-full-audit.json"]').count(), 1);
    assert.equal(await page.getByText('Weitere CSV-Exports').count(), 1);
    assert.equal(await page.locator('.export-panel').count(), 0);
    assert.ok(await page.locator('.check-card').count() >= 2);
    assert.ok(await page.getByText('All good').count() >= 1);
    assert.ok(await page.getByText('Speakable opportunity').count() >= 1);
    assert.equal(await page.getByText('Title missing').first().isVisible(), true);
    assert.equal(await page.getByText('Empfehlung').first().isVisible(), true);
    assert.equal(await page.locator('a[href="/api/audits/1/check-results/101/export.csv"]').count(), 1);

    await page.getByRole('button', { name: 'OK' }).click();
    assert.ok(await page.getByText('All good').count() >= 1);
    assert.ok(await page.getByText('Passed opportunity').count() >= 1);
    assert.equal(await page.locator('.check-card .status').first().innerText(), 'OK');

    await page.getByRole('button', { name: 'ToDo' }).click();
    await page.waitForTimeout(100);
    const todoTitles = await page.locator('.check-card h3').allTextContents({ timeoutMs: 5000 });
    assert.equal(todoTitles.includes('All good'), false);

    await page.getByRole('button', { name: 'Details ansehen' }).first().click();
    await page.waitForSelector('#review-modal:not([hidden])');
    const modal = page.locator('#review-modal');
    await modal.getByText('Das ist der Prüfpunkt').waitFor();
    assert.equal(await modal.getByText('Das ist der Prüfpunkt').count(), 1);
    assert.equal(await modal.getByText('Das wurde gefunden').count(), 1);
    assert.equal(await modal.getByText('Betroffene URLs / Daten').count(), 1);
    assert.equal(await modal.locator('form#review-form h3', { hasText: 'Review' }).count(), 1);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedBatch82Fixture(db) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 20,
    maxDepth: 2,
    concurrency: 1,
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false,
    scheduledRunId: 12,
    triggerType: 'schedule_run_now'
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 2,
    successfulUrls: 2,
    scheduledRunId: 12,
    triggerType: 'schedule_run_now',
    startedAt: '2026-06-28T08:00:00.000Z',
    finishedAt: '2026-06-28T08:01:00.000Z'
  });

  insertPage(db, {
    runId,
    url: 'https://example.com/short',
    normalizedUrl: 'https://example.com/short',
    finalUrl: 'https://example.com/short',
    title: 'Short',
    titleLength: 5,
    ttfbMs: thresholds.highTtfbMs + 50,
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html' }),
    ogJson: JSON.stringify({ 'og:title': 'Short' })
  });
  insertPage(db, {
    runId,
    url: 'https://example.com/ok',
    normalizedUrl: 'https://example.com/ok',
    finalUrl: 'https://example.com/ok',
    title: 'Healthy Title For A Normal Page',
    titleLength: 31,
    responseHeadersJson: JSON.stringify({ 'strict-transport-security': 'max-age=31536000' }),
    ogJson: JSON.stringify({ 'og:title': 'OK', 'og:description': 'OK', 'og:image': '/og.jpg', 'og:url': 'https://example.com/ok' })
  });

  db.prepare(`
    INSERT INTO page_images (
      runId, pageUrl, imageUrl, alt, hasAlt, loading, width, height, extension, sizeBytes, imageRole,
      altAttributePresent, altValue, altValueTrimmed, isDecorativeCandidate
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0)
  `).run(runId, 'https://example.com/short', 'https://example.com/missing-alt.jpg', null, 0, 'eager', '', '', 'jpg', 1200, 'content');

  const checks = {
    titleTooShort: insertCheck(db, runId, 'tech.title_too_short', 'HTML Head & Meta', 'Title too short', 'Warning', 'Medium', 'issue', { sampleUrls: ['https://example.com/short'], evidence: { threshold: thresholds.titleTooShort } }),
    imageAlt: insertCheck(db, runId, 'tech.images_without_alt', 'Media SEO', 'Images without alt', 'Warning', 'Medium', 'issue', { sampleUrls: ['https://example.com/short'], evidence: { missingAlt: 1 } }),
    highTtfb: insertCheck(db, runId, 'tech.high_ttfb', 'Performance Light', 'High TTFB', 'Warning', 'Medium', 'issue', { sampleUrls: ['https://example.com/short'], evidence: { threshold: thresholds.highTtfbMs } }),
    hsts: insertCheck(db, runId, 'tech.hsts_header', 'Security Best Practice', 'HSTS present', 'Warning', 'Medium', 'best_practice', { sampleUrls: ['https://example.com/short'], evidence: { headerKey: 'strict-transport-security' } }),
    generic: insertCheck(db, runId, 'tech.custom_generic', 'Other', 'Generic fallback', 'Warning', 'Low', 'issue', { sampleUrls: ['https://example.com/short'], evidence: { customEvidence: 'present' } }),
    emptyOk: insertCheck(db, runId, 'tech.canonical_missing', 'Crawling & Indexing', 'Canonical missing', 'OK', 'Low', 'issue', { affectedCount: 0, sampleUrls: [], evidence: { checkedPages: 2 } })
  };

  upsertFindingReview(db, runId, checks.titleTooShort, {
    reviewStatus: 'needs_fix',
    actionStatus: 'planned',
    manualPriority: 'High',
    reviewerName: 'QA'
  });

  return { runId, checks };
}

function insertPage(db, page) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType, indexable,
      title, titleLength, metaDescription, metaDescriptionLength, h1Json, h1Count,
      canonical, wordCountRaw, wordCountRendered, rawHtmlSize, internalLinksCount,
      externalLinksCount, schemaTypesJson, imagesCount, imagesWithoutAltCount,
      responseHeadersJson, loadTimeMs, ttfbMs, pageType, hasTables, hasLists,
      hasFaqPattern, hasVisibleDate, hasAuthorPattern, externalSourceLinksCount,
      hasVideoEmbed, ogJson
    )
    VALUES (
      @runId, @url, @normalizedUrl, @finalUrl, @depth, @statusCode, @contentType, @indexable,
      @title, @titleLength, @metaDescription, @metaDescriptionLength, @h1Json, @h1Count,
      @canonical, @wordCountRaw, @wordCountRendered, @rawHtmlSize, @internalLinksCount,
      @externalLinksCount, @schemaTypesJson, @imagesCount, @imagesWithoutAltCount,
      @responseHeadersJson, @loadTimeMs, @ttfbMs, @pageType, @hasTables, @hasLists,
      @hasFaqPattern, @hasVisibleDate, @hasAuthorPattern, @externalSourceLinksCount,
      @hasVideoEmbed, @ogJson
    )
  `).run({
    depth: 0,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    indexable: 1,
    metaDescription: 'Fixture description',
    metaDescriptionLength: 19,
    h1Json: JSON.stringify(['H1']),
    h1Count: 1,
    canonical: page.normalizedUrl,
    wordCountRaw: 120,
    wordCountRendered: 120,
    rawHtmlSize: 5000,
    internalLinksCount: 1,
    externalLinksCount: 0,
    schemaTypesJson: '[]',
    imagesCount: 1,
    imagesWithoutAltCount: 1,
    loadTimeMs: 300,
    ttfbMs: 120,
    pageType: 'other',
    hasTables: 0,
    hasLists: 1,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0,
    ogJson: '{}',
    ...page
  });
}

function insertCheck(db, runId, checkId, category, checkName, status, priority, findingType, options = {}) {
  const affectedCount = options.affectedCount ?? 1;
  return db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson,
      reportGroupingKey, findingType, confidence, reviewRecommended, relatedCheckIdsJson
    )
    VALUES (?, ?, ?, ?, ?, ?, 'S', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'high', ?, '[]')
  `).run(
    runId,
    checkId,
    category,
    checkName,
    status,
    priority,
    status === 'OK' ? 100 : 60,
    `${checkName} finding`,
    `${checkName} details`,
    `${checkName} recommendation`,
    affectedCount,
    JSON.stringify(options.sampleUrls || []),
    JSON.stringify(options.evidence || {}),
    status === 'OK' ? 'passed_checks' : 'core',
    findingType,
    status !== 'OK' ? 1 : 0
  ).lastInsertRowid;
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

function mockResultsPayload() {
  return {
    run: { id: 1, triggerType: 'schedule_run_now', schedule: { name: 'Weekly Audit' }, comparisonId: 7 },
    scores: { techScore: 70, geoScore: 80, overallScore: 75 },
    reviewSummary: { reviewed: 0, reviewableFindings: 2, unreviewed: 2, needsFix: 0, falsePositive: 0, done: 0, reviewRecommendedCount: 1, passedChecks: 1, notRequired: 1 },
    samplingSummary: { samplesProcessed: 0, samplesTotal: 0, sampleRows: 0, enableTemplateSampling: false },
    results: [
      resultRow(101, 'tech.title_missing', 'Title missing', 'Warning', 'High', 'issue', 'Title missing', 'Add a descriptive title.', 'core'),
      resultRow(102, 'tech.https_reachable', 'All good', 'OK', 'Low', 'issue', 'HTTPS reachable.', 'Keep monitoring.', 'passed_checks'),
      resultRow(103, 'geo.speakable_missing', 'Speakable opportunity', 'Warning', 'Low', 'opportunity', 'No speakable signal.', 'Treat as optional.', 'geo_opportunities'),
      resultRow(104, 'template.lighthouse_unavailable', 'Lighthouse unavailable', 'NA', 'Low', 'info', 'Sampling unavailable.', 'Enable local sampling.', 'not_applicable'),
      resultRow(105, 'geo.article_blog_pages_article_schema', 'Passed opportunity', 'OK', 'Low', 'opportunity', 'Article schema present.', 'Keep markup aligned with visible content.', 'geo_opportunities')
    ]
  };
}

function resultRow(id, checkId, checkName, status, priority, findingType, finding, recommendation, reportGroupingKey) {
  return {
    id,
    checkId,
    checkName,
    category: checkId.startsWith('geo.') ? 'GEO Opportunities' : 'Technical SEO',
    status,
    priority,
    effort: 'S',
    effectiveStatus: status,
    effectivePriority: priority,
    displayStatus: status,
    findingType,
    normalizedFindingType: findingType,
    confidence: status === 'OK' ? 'high' : 'medium',
    displayReviewRecommended: status !== 'OK',
    displayReviewStatus: 'unreviewed',
    displayActionStatus: 'open',
    reviewStatus: 'unreviewed',
    actionStatus: 'open',
    affectedCount: status === 'OK' ? 0 : 1,
    details: `${checkName} details`,
    finding,
    recommendation,
    effectiveFinding: finding,
    effectiveRecommendation: recommendation,
    sampleUrls: status === 'OK' ? [] : ['https://example.com/a'],
    isReviewable: status !== 'OK',
    reportGroupingKey,
    reportSection: reportGroupingKey
  };
}

function mockCheckDetail() {
  return {
    checkId: 'tech.title_missing',
    checkResultId: 101,
    title: 'Title missing',
    status: 'Warning',
    priority: 'High',
    displayStatus: 'Warning',
    reviewStatus: 'unreviewed',
    actionStatus: 'open',
    displayReviewStatus: 'unreviewed',
    displayActionStatus: 'open',
    context: {
      whatChecked: 'Title tags were checked.',
      howChecked: 'Stored crawl data.',
      found: 'One title is missing.',
      relevance: 'Relevant for audit work.',
      recommendation: 'Add a title.'
    },
    columns: [{ key: 'url', label: 'URL' }, { key: 'recommendation', label: 'Recommendation' }],
    rows: [{ url: 'https://example.com/a', recommendation: 'Add a title.' }],
    evidence: { affected: 1 },
    truncated: false
  };
}
