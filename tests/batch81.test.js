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
import { collectCheckDetailCsv, collectFullAuditJson } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('check detail service exposes affected rows, review fields and thresholds', () => {
  const db = setupDb();
  const fixture = seedFixture(db);

  const detail = getCheckDetail(db, fixture.runId, fixture.checks.titleTooShort);

  assert.equal(detail.checkId, 'tech.title_too_short');
  assert.equal(detail.effectiveStatus, 'Error');
  assert.equal(detail.effectivePriority, 'High');
  assert.equal(detail.displayReviewStatus, 'needs_fix');
  assert.ok(detail.columns.some((column) => column.key === 'titleLength'));
  assert.ok(detail.columns.some((column) => column.key === 'displayReviewStatus'));
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.rows[0].url, 'https://example.com/ratgeber/kurz');
  assert.equal(detail.rows[0].titleLength < thresholds.titleTooShort, true);
  assert.equal(detail.rows[0].displayActionStatus, 'planned');
  assert.match(detail.context.howChecked, /gespeicherte Crawl-Daten/);

  db.close();
});

test('check detail service uses specific handlers for image and schema checks', () => {
  const db = setupDb();
  const fixture = seedFixture(db);

  const largeImage = getCheckDetail(db, fixture.runId, fixture.checks.largeImage);
  assert.equal(largeImage.dataSource, 'resources');
  assert.equal(largeImage.rows.length, 1);
  assert.equal(largeImage.rows[0].imageUrl, 'https://example.com/hero-large.jpg');
  assert.equal(Number(largeImage.rows[0].sizeBytes) > thresholds.largeImageBytes, true);

  const faq = getCheckDetail(db, fixture.runId, fixture.checks.faqSchema);
  assert.equal(faq.dataSource, 'pages/schemas');
  assert.ok(faq.columns.some((column) => column.key === 'detectedSignal'));
  assert.ok(faq.rows.some((row) => row.detectedSignal.includes('FAQ pattern')));

  db.close();
});

test('per-check CSV and full audit JSON fallback include detail exports', () => {
  const db = setupDb();
  const fixture = seedFixture(db);

  const csv = collectCheckDetailCsv(db, fixture.runId, fixture.checks.titleTooShort);
  assert.equal(csv.filename, `audit-${fixture.runId}-tech.title_too_short.csv`);
  assert.match(csv.csv.split('\n')[0], /URL,Title,Title Length/);
  assert.match(csv.csv, /needs_fix/);
  assert.match(csv.csv, /Fix short titles/);

  const full = collectFullAuditJson(db, fixture.runId, ['findings', 'pages']);
  const parsed = JSON.parse(full.body);
  assert.equal(parsed.format, 'full-audit-json-fallback');
  assert.ok(parsed.files['findings.csv'].includes('effectiveStatus'));
  assert.ok(parsed.files['urls.csv'].includes('hasFaqPattern'));
  assert.ok(parsed.checkExports['checks/tech.title_too_short.csv'].includes('Title Length'));

  db.close();
});

test('Batch 8.1 UI exposes compact start, card results, detail links and full audit export', () => {
  const appJs = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');

  assert.match(appJs, /renderHomeV2/);
  assert.match(appJs, /Schnellcheck/);
  assert.match(appJs, /Vollaudit/);
  assert.match(appJs, /Tech only/);
  assert.match(appJs, /GEO only/);
  assert.match(appJs, /Full Audit Export/);
  assert.match(appJs, /export\/full\.json/);
  assert.match(appJs, /data-detail-finding/);
  assert.match(appJs, /check-results\/\$\{row\.id\}\/export\.csv/);
  assert.match(appJs, /Technische Details/);
  assert.match(css, /\.check-card/);
  assert.match(css, /\.card-filters/);
  assert.match(css, /\.start-layout/);
});

test('HTTP API exposes check details, per-check CSV and full audit JSON fallback', async () => {
  const temp = useTempAuditDb('batch81-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const fixture = seedFixture(seedDb);
  seedDb.close();

  const apiPort = 33000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUDIT_DB_PATH: temp.dbPath,
      PORT: String(apiPort),
      SCHEDULER_DISABLED: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForApi(apiPort);

    const detail = await apiJson(apiPort, `/api/audits/${fixture.runId}/check-results/${fixture.checks.titleTooShort}/details`);
    assert.equal(detail.checkId, 'tech.title_too_short');
    assert.equal(detail.rows[0].displayReviewStatus, 'needs_fix');

    const csv = await apiText(apiPort, `/api/audits/${fixture.runId}/check-results/${fixture.checks.titleTooShort}/export.csv`);
    assert.match(csv, /URL,Title,Title Length/);
    assert.match(csv, /https:\/\/example.com\/ratgeber\/kurz/);

    const full = JSON.parse(await apiText(apiPort, `/api/audits/${fixture.runId}/export/full.json`));
    assert.equal(full.format, 'full-audit-json-fallback');
    assert.ok(full.checkExports['checks/tech.title_too_short.csv']);

    const missing = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${fixture.runId}/check-results/999999/details`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
  }

  assert.equal(stderr.includes('EADDRINUSE'), false, stderr);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedFixture(db) {
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
    enableLighthouseSampling: false
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 2,
    successfulUrls: 2,
    startedAt: '2026-06-28T08:00:00.000Z',
    finishedAt: '2026-06-28T08:01:00.000Z'
  });

  insertPage(db, {
    runId,
    url: 'https://example.com/ratgeber/kurz',
    normalizedUrl: 'https://example.com/ratgeber/kurz',
    finalUrl: 'https://example.com/ratgeber/kurz',
    depth: 1,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    indexable: 1,
    title: 'Kurz',
    titleLength: 4,
    metaDescription: 'A useful guide page with a short title.',
    metaDescriptionLength: 37,
    h1Json: JSON.stringify(['Ratgeber Kurz']),
    h1Count: 1,
    canonical: 'https://example.com/ratgeber/kurz',
    pageType: 'article',
    hasLists: 1,
    hasFaqPattern: 1,
    hasVisibleDate: 1,
    hasAuthorPattern: 1,
    externalSourceLinksCount: 2,
    schemaTypesJson: JSON.stringify(['Article'])
  });
  insertPage(db, {
    runId,
    url: 'https://example.com/shop/produkt',
    normalizedUrl: 'https://example.com/shop/produkt',
    finalUrl: 'https://example.com/shop/produkt',
    depth: 1,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    indexable: 1,
    title: 'Product Page With A Healthy Title',
    titleLength: 33,
    metaDescription: 'A product page with enough content and image resources.',
    metaDescriptionLength: 55,
    h1Json: JSON.stringify(['Product']),
    h1Count: 1,
    canonical: 'https://example.com/shop/produkt',
    pageType: 'product',
    hasTables: 1,
    schemaTypesJson: JSON.stringify(['Product'])
  });

  db.prepare(`
    INSERT INTO resources (runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, 'https://example.com/shop/produkt', 'https://example.com/hero-large.jpg', 'image', 200, thresholds.largeImageBytes + 1024, 'image/jpeg', 0);
  db.prepare(`
    INSERT INTO resources (runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, 'https://example.com/shop/produkt', 'https://example.com/icon-small.png', 'image', 200, thresholds.largeImageBytes - 1024, 'image/png', 0);
  db.prepare(`
    INSERT INTO page_images (runId, pageUrl, imageUrl, alt, hasAlt, loading, width, height, extension, sizeBytes, imageRole)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, 'https://example.com/shop/produkt', 'https://example.com/hero-large.jpg', '', 0, 'eager', '', '', 'jpg', thresholds.largeImageBytes + 1024, 'content');
  db.prepare(`
    INSERT INTO schemas (runId, pageUrl, schemaType, rawJson, parseStatus, parseError)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, 'https://example.com/ratgeber/kurz', 'Article', '{}', 'ok', null);

  const titleTooShort = insertCheckResult(db, {
    runId,
    checkId: 'tech.title_too_short',
    category: 'Technical SEO',
    checkName: 'Title too short',
    status: 'Warning',
    priority: 'Medium',
    effort: 'S',
    finding: 'One title is shorter than the configured threshold.',
    details: `Titles shorter than ${thresholds.titleTooShort} characters were checked in stored page data.`,
    recommendation: 'Fix short titles with descriptive, page-specific wording.',
    affectedCount: 1,
    sampleUrlsJson: JSON.stringify(['https://example.com/ratgeber/kurz']),
    evidenceJson: JSON.stringify({ threshold: thresholds.titleTooShort, affectedUrls: 1 }),
    reportGroupingKey: 'core',
    findingType: 'issue',
    confidence: 'high',
    reviewRecommended: 1
  });
  const largeImage = insertCheckResult(db, {
    runId,
    checkId: 'tech.large_image_resources',
    category: 'Performance',
    checkName: 'Large image resources',
    status: 'Warning',
    priority: 'Low',
    effort: 'M',
    finding: 'Large image resources were found.',
    details: 'Image resources above the configured byte threshold were checked.',
    recommendation: 'Compress or resize oversized images.',
    affectedCount: 1,
    sampleUrlsJson: JSON.stringify(['https://example.com/shop/produkt']),
    evidenceJson: JSON.stringify({ threshold: thresholds.largeImageBytes }),
    reportGroupingKey: 'core',
    findingType: 'issue',
    confidence: 'high',
    reviewRecommended: 0
  });
  const faqSchema = insertCheckResult(db, {
    runId,
    checkId: 'geo.faqpage_missing',
    category: 'GEO Structured Data',
    checkName: 'FAQPage missing',
    status: 'Warning',
    priority: 'Low',
    effort: 'S',
    finding: 'FAQ-like HTML was detected without FAQPage schema.',
    details: 'FAQPage is checked only when FAQ patterns exist.',
    recommendation: 'Add FAQPage schema when FAQ content is stable and valid.',
    affectedCount: 1,
    sampleUrlsJson: JSON.stringify(['https://example.com/ratgeber/kurz']),
    evidenceJson: JSON.stringify({ hasFaqPattern: true }),
    reportGroupingKey: 'geo_opportunities',
    findingType: 'opportunity',
    confidence: 'medium',
    reviewRecommended: 1
  });
  const canonicalMissing = insertCheckResult(db, {
    runId,
    checkId: 'tech.canonical_missing',
    category: 'Technical SEO',
    checkName: 'Canonical missing',
    status: 'OK',
    priority: 'Low',
    effort: 'S',
    finding: 'Canonical tags are present on sampled pages.',
    details: 'Canonical presence was checked on HTML pages.',
    recommendation: 'Keep canonical tags stable.',
    affectedCount: 0,
    sampleUrlsJson: JSON.stringify([]),
    evidenceJson: JSON.stringify({ checkedPages: 2 }),
    reportGroupingKey: 'passed_checks',
    findingType: 'issue',
    confidence: 'high',
    reviewRecommended: 0
  });
  const templateCheck = insertCheckResult(db, {
    runId,
    checkId: 'template.performance_unavailable',
    category: 'Template Performance',
    checkName: 'Template performance unavailable',
    status: 'NA',
    priority: 'Low',
    effort: 'S',
    finding: 'Template performance sampling was not available for this fixture.',
    details: 'Template sample rows are checked when sampling data exists.',
    recommendation: 'Enable local sampling for template-level performance details.',
    affectedCount: 0,
    sampleUrlsJson: JSON.stringify([]),
    evidenceJson: JSON.stringify({ sampling: 'disabled' }),
    reportGroupingKey: 'not_applicable',
    findingType: 'info',
    confidence: 'high',
    reviewRecommended: 0
  });

  upsertFindingReview(db, runId, titleTooShort, {
    reviewStatus: 'needs_fix',
    actionStatus: 'planned',
    manualStatus: 'Error',
    manualPriority: 'High',
    note: 'Confirmed in manual review.',
    reviewerName: 'QA'
  });

  return {
    runId,
    checks: { titleTooShort, largeImage, faqSchema, canonicalMissing, templateCheck }
  };
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
      hasVideoEmbed
    )
    VALUES (
      @runId, @url, @normalizedUrl, @finalUrl, @depth, @statusCode, @contentType, @indexable,
      @title, @titleLength, @metaDescription, @metaDescriptionLength, @h1Json, @h1Count,
      @canonical, @wordCountRaw, @wordCountRendered, @rawHtmlSize, @internalLinksCount,
      @externalLinksCount, @schemaTypesJson, @imagesCount, @imagesWithoutAltCount,
      @responseHeadersJson, @loadTimeMs, @ttfbMs, @pageType, @hasTables, @hasLists,
      @hasFaqPattern, @hasVisibleDate, @hasAuthorPattern, @externalSourceLinksCount,
      @hasVideoEmbed
    )
  `).run({
    wordCountRaw: 180,
    wordCountRendered: 180,
    rawHtmlSize: 12000,
    internalLinksCount: 4,
    externalLinksCount: 2,
    imagesCount: 1,
    imagesWithoutAltCount: 1,
    responseHeadersJson: '{}',
    loadTimeMs: 300,
    ttfbMs: 120,
    hasTables: 0,
    hasLists: 0,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0,
    ...page
  });
}

function insertCheckResult(db, row) {
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
  `).run({
    score: row.status === 'OK' ? 100 : 60,
    relatedCheckIdsJson: '[]',
    ...row
  }).lastInsertRowid;
}

async function waitForApi(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await apiJson(port, '/api/audits');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('API server did not start');
}

async function apiJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

async function apiText(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(text || response.statusText);
  return text;
}
