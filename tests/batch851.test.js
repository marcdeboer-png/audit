import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  insertPage,
  replacePageArtifacts,
  updateProject,
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { runChecks, loadResultsWithScores } from '../src/checks/checkEngine.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { collectCheckDetailCsv, collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { getCapabilities } from '../src/runtime/capabilities.js';
import { inspectLighthouseRuntime } from '../src/runtime/lighthouseRuntime.js';
import { createLighthouseSampler } from '../src/sampling/lighthouseSampler.js';

test('Lighthouse capabilities use the same importable runtime path as the sampler', async () => {
  const capabilities = await getCapabilities();
  assert.equal(typeof capabilities.lighthousePackage.declared, 'boolean');
  assert.equal(typeof capabilities.lighthousePackage.resolvable, 'boolean');
  assert.equal(typeof capabilities.lighthousePackage.importable, 'boolean');
  assert.equal(typeof capabilities.chromeLauncherPackage.importable, 'boolean');
  assert.equal(typeof capabilities.lighthouseSampling.available, 'boolean');
  if (capabilities.lighthousePackage.resolvable) {
    assert.match(capabilities.lighthousePackage.path, /node_modules\/lighthouse\//);
    assert.doesNotMatch(capabilities.lighthousePackage.path, /node_modules\/lighthouse\/index\.js$/);
  }

  const missing = await inspectLighthouseRuntime({ lighthouseModuleName: 'missing-lighthouse-test-fixture' });
  assert.equal(missing.available, false);
  assert.equal(missing.lighthouse.importable, false);
  assert.equal(missing.reason, 'Lighthouse package is not installed or not importable');
  assert.equal(missing.fix, 'npm install lighthouse chrome-launcher');

  const sampler = await createLighthouseSampler({ forceUnavailable: true });
  const sample = await sampler.sample({ url: 'https://example.com/' });
  assert.equal(sampler.available, false);
  assert.equal(sample.errorMessage, 'Lighthouse package is not installed or not importable');
  assert.doesNotMatch(sample.errorMessage, /node_modules|Cannot find package|at /);
  assert.deepEqual(JSON.parse(sample.auditsJson).unavailable, {
    reason: 'Lighthouse package is not installed or not importable',
    fix: 'npm install lighthouse chrome-launcher'
  });
});

test('Charset check accepts either HTTP UTF-8 or HTML meta UTF-8 evidence', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  insertSeedPage(db, runId, 'https://fixture.local/header-utf8', {
    contentType: 'text/html; charset=utf-8',
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html; charset=utf-8' }),
    hasHeaderUtf8: 1
  });
  insertSeedPage(db, runId, 'https://fixture.local/meta-utf8', {
    contentType: 'text/html',
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html' }),
    metaCharset: 'utf-8',
    hasMetaCharsetUtf8: 1
  });
  insertSeedPage(db, runId, 'https://fixture.local/no-charset', {
    contentType: 'text/html',
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html' }),
    metaCharset: null,
    hasHeaderUtf8: 0,
    hasMetaCharsetUtf8: 0
  });

  await runChecks(db, runId);
  const charset = result(db, runId, 'tech.charset_utf8_present');
  assert.equal(charset.status, 'Warning');
  assert.equal(charset.affectedCount, 1);
  assert.equal(charset.normalizedFindingType, 'best_practice');
  assert.deepEqual(charset.sampleUrls, ['https://fixture.local/no-charset']);

  const detail = getCheckDetail(db, runId, charset.id);
  assert.deepEqual(detail.rows.map((row) => row.url), ['https://fixture.local/no-charset']);
  assert.deepEqual(detail.columns.map((column) => column.key).slice(0, 5), [
    'url',
    'contentType',
    'hasHeaderUtf8',
    'hasMetaCharsetUtf8',
    'detectedMetaCharset'
  ]);
  db.close();
});

test('Findings CSV prioritizes display semantics and keeps raw values explicit', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  insertSeedPage(db, runId, 'https://fixture.local/');
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'robots', 'https://fixture.local/robots.txt', 200, 'User-agent: *\nAllow: /', '{}')
  `).run(runId);
  await runChecks(db, runId);

  const csv = collectCsvExport(db, runId, 'findings');
  assert.ok(csv.startsWith('checkId,title,category,displayStatus,displayPriority,displayFindingType,displayReviewStatus,displayActionStatus,affectedCount,recommendation,rawStatus,rawPriority,rawFindingType,confidence,reportSection,reviewRecommended,evidenceJson,sampleUrls'));

  const aiBot = csvRow(csv, 'geo.ai_bots_policy_summary');
  assert.equal(aiBot.displayStatus, 'Opportunity');
  assert.equal(aiBot.displayFindingType, 'opportunity');
  assert.notEqual(aiBot.displayFindingType, 'core_issue');
  assert.equal(aiBot.rawFindingType, 'opportunity');

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  const jsonAiBot = fullJson.findings.find((row) => row.checkId === 'geo.ai_bots_policy_summary');
  assert.equal(jsonAiBot.displayFindingType, 'opportunity');
  assert.equal(jsonAiBot.rawFindingType, 'opportunity');
  assert.ok(jsonAiBot.evidenceJson);
  db.close();
});

test('Cache-Control and lazy loading exports are best-practice findings, not core issues', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  insertSeedPage(db, runId, 'https://fixture.local/');
  replacePageArtifacts(db, runId, 'https://fixture.local/', {
    images: [
      contentImage('https://fixture.local/assets/eager-content.jpg', { loading: null, width: '640', height: '360' }),
      contentImage('https://fixture.local/assets/hero-banner.jpg', { loading: null, width: '1200', height: '600', imageRole: 'hero' }),
      contentImage('https://fixture.local/assets/small-content.png', { loading: null, width: '32', height: '32' }),
      contentImage('https://fixture.local/assets/icon-search.png', { loading: null, width: '24', height: '24', imageRole: 'icon', likelyIcon: 1, likelyDecorativeImage: 1 })
    ]
  });

  await runChecks(db, runId);
  const cache = result(db, runId, 'tech.cache_control_header');
  assert.equal(cache.status, 'Warning');
  assert.equal(cache.priority, 'Low');
  assert.equal(cache.normalizedFindingType, 'best_practice');
  assert.notEqual(cache.reportSection, 'action_items');
  assert.match(cache.recommendation, /Review caching policy/);

  const lazy = result(db, runId, 'tech.images_without_lazy_loading');
  assert.equal(lazy.status, 'Warning');
  assert.equal(lazy.priority, 'Low');
  assert.equal(lazy.normalizedFindingType, 'best_practice');
  assert.notEqual(lazy.reportSection, 'action_items');
  assert.equal(lazy.affectedCount, 1);
  assert.equal(lazy.evidence.ignoredSmallImages, 1);
  assert.equal(lazy.evidence.ignoredHeroImages, 1);

  const detail = getCheckDetail(db, runId, lazy.id);
  assert.deepEqual(detail.rows.map((row) => row.imageUrl), ['https://fixture.local/assets/eager-content.jpg']);
  assert.equal(detail.rows[0].reason, 'non-critical image missing loading=lazy');

  const checkCsv = collectCheckDetailCsv(db, runId, lazy.id).csv;
  assert.ok(checkCsv.startsWith('checkId,title,category,checkResultId,displayStatus,displayPriority,displayFindingType'));
  assert.match(checkCsv, /non-critical image missing loading=lazy/);
  assert.doesNotMatch(checkCsv, /hero-banner\.jpg/);
  assert.doesNotMatch(checkCsv, /small-content\.png/);

  const findingsCsv = collectCsvExport(db, runId, 'findings');
  assert.equal(csvRow(findingsCsv, 'tech.cache_control_header').displayFindingType, 'best_practice');
  assert.equal(csvRow(findingsCsv, 'tech.images_without_lazy_loading').displayFindingType, 'best_practice');
  db.close();
});

test('Full JSON and ZIP expose completed Lighthouse sampling as structured working data', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  updateRun(db, runId, {
    enableTemplateSampling: 1,
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1,
    samplesTotal: 1,
    samplesProcessed: 1
  });
  insertSeedPage(db, runId, 'https://fixture.local/');
  insertCompletedSampling(db, runId);
  await runChecks(db, runId);

  const json = JSON.parse(collectFullAuditJson(db, runId, ['findings', 'lighthouse-results', 'playwright-results', 'template-performance']).body);
  assert.equal(json.samplingSummary.lighthouseStatus, 'completed');
  assert.equal(json.samplingSummary.lighthouseSuccessCount, 1);
  assert.equal(json.summary.samplingSummary.lighthouseStatus, 'completed');
  assert.equal(json.summary.samplingSummary.lighthouseSuccessCount, 1);
  assert.equal(json.files['lighthouse-results.csv'].includes('0.91'), true);
  assert.doesNotMatch(json.files['lighthouse-results.csv'], /Cannot find package|node_modules\/lighthouse\/index\.js|\\n\\s+at /);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings', 'lighthouse-results', 'playwright-results', 'template-performance']).buffer);
  assert.ok(zipEntries['summary/audit-summary.json']);
  assert.ok(zipEntries['data/lighthouse-results.json']);
  assert.ok(zipEntries['data/playwright-results.json']);
  assert.ok(zipEntries['csv/lighthouse-results.csv']);
  assert.ok(zipEntries['checks/audit-1-template.low_lighthouse_performance.csv']);
  const summary = JSON.parse(zipEntries['summary/audit-summary.json']);
  assert.equal(summary.samplingSummary.lighthouseStatus, 'completed');
  assert.equal(summary.samplingSummary.lighthouseSuccessCount, 1);
  assert.deepEqual(JSON.parse(zipEntries['export-warnings.json']).warnings, []);
  assert.doesNotMatch(zipEntries['csv/lighthouse-results.csv'], /Cannot find package|node_modules\/lighthouse\/index\.js|\\n\\s+at /);
  db.close();
});

test('Important check detail handlers expose concrete table fields for audit work', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  updateRun(db, runId, {
    enableTemplateSampling: 1,
    enablePlaywrightSampling: 1,
    enableLighthouseSampling: 1,
    samplesTotal: 1,
    samplesProcessed: 1
  });
  insertSeedPage(db, runId, 'https://fixture.local/short-title', {
    title: 'Tiny',
    metaDescription: 'Short',
    canonical: 'https://fixture.local/canonical-target',
    ttfbMs: 2200,
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html' }),
    metaCharset: null,
    hasHeaderUtf8: 0,
    hasMetaCharsetUtf8: 0
  });
  replacePageArtifacts(db, runId, 'https://fixture.local/short-title', {
    images: [
      contentImage('https://fixture.local/assets/no-alt.jpg', { alt: null, hasAlt: 0, width: '640', height: '360' }),
      contentImage('https://fixture.local/assets/no-dimensions.jpg', { width: null, height: null }),
      contentImage('https://fixture.local/assets/no-lazy.jpg', { loading: null, width: '640', height: '360' })
    ]
  });
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'robots', 'https://fixture.local/robots.txt', 200, 'User-agent: *\nAllow: /', '{}')
  `).run(runId);
  insertCompletedSampling(db, runId);

  await runChecks(db, runId);
  assertDetailColumns(db, runId, 'tech.title_too_short', ['url', 'title', 'titleLength']);
  assertDetailColumns(db, runId, 'tech.meta_description_too_short', ['url', 'metaDescription', 'metaDescriptionLength']);
  assertDetailColumns(db, runId, 'tech.canonical_non_self', ['url', 'canonical', 'issueType']);
  assertDetailColumns(db, runId, 'tech.images_without_alt', ['pageUrl', 'imageUrl', 'alt', 'imageRole', 'reason']);
  assertDetailColumns(db, runId, 'tech.images_without_width_height', ['pageUrl', 'imageUrl', 'width', 'height', 'reason']);
  assertDetailColumns(db, runId, 'tech.images_without_lazy_loading', ['pageUrl', 'imageUrl', 'loading', 'imageRole', 'reason']);
  assertDetailColumns(db, runId, 'tech.high_ttfb', ['url', 'ttfbMs']);
  assertDetailColumns(db, runId, 'tech.cache_control_header', ['url', 'missingHeader']);
  assertDetailColumns(db, runId, 'tech.charset_utf8_present', ['url', 'contentType', 'hasHeaderUtf8', 'hasMetaCharsetUtf8', 'detectedMetaCharset']);
  assertDetailColumns(db, runId, 'geo.ai_bots_policy_summary', ['botName', 'mentioned', 'robotsStatus', 'recommendation']);
  assertDetailColumns(db, runId, 'template.low_lighthouse_performance', ['sampleUrl', 'performanceScore', 'seoScore']);

  for (const checkId of ['tech.title_too_short', 'tech.images_without_lazy_loading', 'geo.ai_bots_policy_summary']) {
    const csv = collectCheckDetailCsv(db, runId, result(db, runId, checkId).id).csv;
    assert.ok(csv.startsWith('checkId,title,category,checkResultId,displayStatus,displayPriority,displayFindingType'));
    assert.match(csv, /rawStatus,rawPriority,rawFindingType/);
  }
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createSeedRun(db) {
  const projectId = createProject(db, { inputDomain: 'https://fixture.local', brandName: 'Fixture' });
  updateProject(db, projectId, {
    finalDomain: 'https://fixture.local',
    protocolBehaviorJson: JSON.stringify([{ startUrl: 'https://fixture.local', statusCode: 200, redirectsToHttps: true }]),
    wwwBehaviorJson: JSON.stringify({ candidates: [] }),
    redirectChainJson: JSON.stringify([])
  });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain: 'https://fixture.local',
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
    startedAt: '2026-06-29T08:00:00.000Z',
    finishedAt: '2026-06-29T08:01:00.000Z'
  });
  return runId;
}

function insertSeedPage(db, runId, url, overrides = {}) {
  const title = overrides.title || `Fixture ${new URL(url).pathname || '/'}`;
  const description = overrides.metaDescription || 'A deterministic page fixture with enough description text.';
  insertPage(db, {
    runId,
    url,
    normalizedUrl: url,
    finalUrl: overrides.finalUrl || url,
    depth: overrides.depth ?? 1,
    sourceUrl: overrides.sourceUrl || null,
    statusCode: overrides.statusCode ?? 200,
    contentType: overrides.contentType || 'text/html; charset=utf-8',
    indexable: overrides.indexable ?? 1,
    title,
    titleLength: title.length,
    metaDescription: description,
    metaDescriptionLength: description.length,
    h1Json: JSON.stringify([overrides.h1 || 'Fixture']),
    h1Count: overrides.h1Count ?? 1,
    h2Json: JSON.stringify([]),
    canonical: overrides.canonical || url,
    htmlLang: 'en',
    viewport: 'width=device-width, initial-scale=1',
    metaCharset: Object.hasOwn(overrides, 'metaCharset') ? overrides.metaCharset : 'utf-8',
    hasHeaderUtf8: overrides.hasHeaderUtf8 ?? 1,
    hasMetaCharsetUtf8: overrides.hasMetaCharsetUtf8 ?? 1,
    metaRobots: overrides.metaRobots || null,
    xRobotsTag: overrides.xRobotsTag || null,
    wordCountRaw: overrides.wordCountRaw ?? 140,
    wordCountRendered: overrides.wordCountRendered ?? null,
    rawTextLength: overrides.rawTextLength ?? 700,
    renderedTextLength: overrides.renderedTextLength ?? null,
    rawHtmlSize: overrides.rawHtmlSize ?? 2400,
    internalLinksCount: overrides.internalLinksCount ?? 0,
    externalLinksCount: overrides.externalLinksCount ?? 0,
    schemaTypesJson: JSON.stringify(overrides.schemaTypes || []),
    imagesCount: overrides.imagesCount ?? 0,
    imagesWithoutAltCount: overrides.imagesWithoutAltCount ?? 0,
    responseHeadersJson: overrides.responseHeadersJson || JSON.stringify({ 'content-type': 'text/html; charset=utf-8' }),
    loadTimeMs: overrides.loadTimeMs ?? 80,
    ttfbMs: overrides.ttfbMs ?? 40,
    consoleErrorsJson: JSON.stringify([]),
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: 0,
    renderedLinksCount: null,
    ogJson: JSON.stringify({ 'og:title': title, 'og:description': description, 'og:image': '/og.jpg', 'og:url': url }),
    favicon: '/favicon.ico',
    manifest: '/site.webmanifest',
    featureFlagsJson: JSON.stringify({}),
    pageType: overrides.pageType || 'other',
    hasTables: 0,
    hasLists: 0,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0
  });
}

function contentImage(imageUrl, overrides = {}) {
  return {
    pageUrl: 'https://fixture.local/',
    imageUrl,
    alt: Object.hasOwn(overrides, 'alt') ? overrides.alt : 'Meaningful image',
    hasAlt: Object.hasOwn(overrides, 'hasAlt') ? overrides.hasAlt : 1,
    loading: Object.hasOwn(overrides, 'loading') ? overrides.loading : null,
    width: Object.hasOwn(overrides, 'width') ? overrides.width : '640',
    height: Object.hasOwn(overrides, 'height') ? overrides.height : '360',
    extension: imageUrl.slice(imageUrl.lastIndexOf('.')),
    sizeBytes: null,
    likelyDecorativeImage: overrides.likelyDecorativeImage || 0,
    likelyBadgeImage: overrides.likelyBadgeImage || 0,
    likelyTrackingPixel: overrides.likelyTrackingPixel || 0,
    likelyIcon: overrides.likelyIcon || 0,
    imageRole: overrides.imageRole || 'content'
  };
}

function insertCompletedSampling(db, runId) {
  const url = 'https://fixture.local/';
  db.prepare(`
    INSERT INTO template_sample_results (
      runId, templateClusterKey, url, finalUrl, sampleReason, playwrightStatus, lighthouseStatus, errorMessage
    )
    VALUES (?, 'homepage:/', ?, ?, 'representative', 'success', 'success', NULL)
  `).run(runId, url, url);
  db.prepare(`
    INSERT INTO playwright_results (
      runId, templateClusterKey, url, status, finalUrl, title, h1Count,
      renderedWordCount, renderedLinksCount, rawRenderedWordDelta,
      consoleErrorsCount, consoleErrorsJson, networkErrorsCount, networkErrorsJson,
      jsRequiredLikely, loadTimeMs
    )
    VALUES (?, 'homepage:/', ?, 'success', ?, 'Fixture', 1, 180, 12, 20, 0, '[]', 0, '[]', 0, 320)
  `).run(runId, url, url);
  db.prepare(`
    INSERT INTO lighthouse_results (
      runId, templateClusterKey, url, device, performanceScore, accessibilityScore,
      bestPracticesScore, seoScore, firstContentfulPaintMs, largestContentfulPaintMs,
      totalBlockingTimeMs, cumulativeLayoutShift, speedIndexMs, interactiveMs,
      totalByteWeight, domSize, auditsJson, errorMessage
    )
    VALUES (?, 'homepage:/', ?, 'mobile', 0.91, 0.95, 0.96, 0.92, 700, 900, 30, 0.01, 900, 1000, 120000, 240,
      '{"largest-contentful-paint":{"score":0.91,"numericValue":900}}', NULL)
  `).run(runId, url);
  db.prepare(`
    INSERT INTO template_performance_summary (
      runId, templateClusterKey, sampleCount, playwrightSuccessCount, lighthouseSuccessCount,
      avgPerformanceScore, minPerformanceScore, avgSeoScore, minSeoScore,
      avgAccessibilityScore, avgBestPracticesScore, avgLcpMs, avgTbtMs, avgCls,
      jsRequiredCount, consoleErrorSampleCount, worstSampleUrlsJson
    )
    VALUES (?, 'homepage:/', 1, 1, 1, 0.91, 0.91, 0.92, 0.92, 0.95, 0.96, 900, 30, 0.01, 0, 0,
      '[{"url":"https://fixture.local/","performanceScore":0.91}]')
  `).run(runId);
}

function result(db, runId, checkId) {
  const row = loadResultsWithScores(db, runId).results.find((item) => item.checkId === checkId);
  assert.ok(row, `${checkId} exists`);
  return row;
}

function assertDetailColumns(db, runId, checkId, expectedKeys) {
  const check = result(db, runId, checkId);
  const detail = getCheckDetail(db, runId, check.id);
  const keys = detail.columns.map((column) => column.key);
  for (const key of expectedKeys) {
    assert.ok(keys.includes(key), `${checkId} detail includes ${key}`);
  }
  assert.ok(detail.rows.length >= 1, `${checkId} detail has rows`);
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

function csvRow(csv, checkId) {
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const line = lines.find((item) => item.startsWith(`${checkId},`));
  assert.ok(line, `${checkId} CSV row exists`);
  const values = parseCsvLine(line);
  return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}
