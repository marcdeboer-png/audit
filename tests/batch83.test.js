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
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { getCapabilities } from '../src/runtime/capabilities.js';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { legitCheckFamilies, legitCheckGuardrails } from '../src/checks/qa/legitimacy.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('Full Audit mode enables local full-audit defaults without external services', () => {
  const config = normalizeAuditConfig({
    domain: 'https://example.com',
    auditMode: 'full',
    maxUrls: 20,
    maxDepth: 3
  });

  assert.equal(config.auditType, 'both');
  assert.equal(config.crawlMode, 'hybrid');
  assert.equal(config.usePlaywright, true);
  assert.equal(config.playwrightMode, 'all');
  assert.equal(config.enableTemplateSampling, true);
  assert.equal(config.enablePlaywrightSampling, true);
  assert.equal(config.enableLighthouseSampling, true);
  assert.equal(config.respectRobotsTxt, true);
  assert.equal(config.maxUrls, 20);
  assert.equal(config.maxDepth, 3);
});

test('default URL budget is configured above the old 500 URL starter limit', () => {
  const config = normalizeAuditConfig({ domain: 'https://example.com' });
  assert.equal(config.maxUrls, 5000);

  const cliSource = fs.readFileSync(new URL('../src/cli/audit.js', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(cliSource, /crawlerDefaults\.maxUrls/);
  assert.match(appSource, /50\.000\+ URLs/);
});

test('crawler identity and rate settings are normalized into audit config', () => {
  const config = normalizeAuditConfig({
    domain: 'https://example.com',
    crawlMode: 'template_sample',
    userAgent: 'ExampleAuditBot/1.0\nbad',
    robotsUserAgent: 'ExampleAuditBot',
    targetPagesPerSecond: 1.5
  });

  assert.equal(config.crawlMode, 'template_sample');
  assert.equal(config.userAgent, 'ExampleAuditBot/1.0 bad');
  assert.equal(config.robotsUserAgent, 'ExampleAuditBot');
  assert.equal(config.targetPagesPerSecond, 1.5);
});

test('capability check exposes package/browser/export fields and setup hints', async () => {
  const capabilities = await getCapabilities();

  assert.equal(capabilities.node.ok, true);
  assert.equal(typeof capabilities.playwrightPackage.available, 'boolean');
  assert.equal(typeof capabilities.chromium.available, 'boolean');
  assert.equal(typeof capabilities.lighthousePackage.available, 'boolean');
  assert.equal(typeof capabilities.chromeLauncherPackage.available, 'boolean');
  assert.equal(capabilities.zipExport.available, true);
  assert.equal(typeof capabilities.fullAuditMode.available, 'boolean');
  assert.ok(Array.isArray(capabilities.hints));

  const hintText = capabilities.hints.map((hint) => `${hint.message} ${hint.fix}`).join('\n');
  if (!capabilities.chromium.available) assert.match(hintText, /npx playwright install chromium/);
  if (!capabilities.lighthousePackage.available || !capabilities.chromeLauncherPackage.available) {
    assert.match(hintText, /npm install lighthouse chrome-launcher/);
  }
});

test('Full ZIP and JSON exports include working data and tolerate failed sub-exports', () => {
  const db = setupDb();
  const { runId } = seedExportFixture(db);

  const zip = collectFullAuditZip(db, runId, ['findings', 'pages', 'not-a-real-export']);
  const entries = readStoredZip(zip.buffer);
  assert.ok(entries['summary/audit-summary.json']);
  assert.ok(entries['data/findings.json']);
  assert.ok(entries['data/urls.json']);
  assert.ok(entries['data/images.json']);
  assert.ok(entries['data/links.json']);
  assert.ok(entries['data/resources.json']);
  assert.ok(entries['data/schemas.json']);
  assert.ok(entries['data/geo-signals.json']);
  assert.ok(entries['checks/audit-1-tech.title_missing.csv']);

  const warnings = JSON.parse(entries['export-warnings.json']);
  assert.ok(warnings.warnings.some((warning) => warning.path === 'csv/not-a-real-export.csv'));
  assert.match(entries['csv/not-a-real-export.csv'], /not-a-real-export/);

  const json = JSON.parse(collectFullAuditJson(db, runId, ['findings', 'pages']).body);
  assert.equal(json.format, 'full-audit-json-fallback');
  assert.ok(Array.isArray(json.findings));
  assert.ok(Array.isArray(json.checkDetails));
  assert.ok(Array.isArray(json.urlInventory));
  assert.ok(Array.isArray(json.images));
  assert.ok(Array.isArray(json.links));
  assert.ok(Array.isArray(json.schemas));
  assert.ok(Array.isArray(json.resources));
  assert.ok(Array.isArray(json.reviews));
  assert.ok(Array.isArray(json.warnings));

  db.close();
});

test('Full export API returns concrete 404 and 409 errors', async () => {
  const temp = useTempAuditDb('batch83-export-api');
  const seedDb = new Database(temp.dbPath);
  seedDb.pragma('foreign_keys = ON');
  initDatabase(seedDb);
  const { runningRunId } = seedExportFixture(seedDb);
  seedDb.close();

  const apiPort = 36000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_DB_PATH: temp.dbPath, PORT: String(apiPort), SCHEDULER_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);
    const capabilities = await fetch(`http://127.0.0.1:${apiPort}/api/capabilities`);
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json();
    assert.equal(capabilityBody.node.ok, true);
    assert.equal(typeof capabilityBody.fullAuditMode.available, 'boolean');

    const missing = await fetch(`http://127.0.0.1:${apiPort}/api/audits/999999/export/full.json`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'Run not found');

    const running = await fetch(`http://127.0.0.1:${apiPort}/api/audits/${runningRunId}/export/full.zip`);
    assert.equal(running.status, 409);
    const body = await running.json();
    assert.equal(body.error, 'Run not completed yet');
    assert.ok(['running', 'paused'].includes(body.status));
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    temp.cleanup();
  }
});

test('legitimacy QA matrix covers critical check families and existing check ids', () => {
  const checkIds = new Set([...techChecks(), ...geoChecks()].map((check) => check.id));
  const matrixIds = legitCheckFamilies.flatMap((family) => family.checkIds);
  const guardrailIds = Object.values(legitCheckGuardrails).flat();

  for (const family of legitCheckFamilies) {
    assert.ok(family.family);
    assert.ok(family.dataBasis);
    assert.ok(family.expectation);
    assert.ok(family.checkIds.length > 0);
  }
  for (const id of [...matrixIds, ...guardrailIds]) {
    assert.equal(checkIds.has(id), true, `${id} exists in registered checks`);
  }

  assert.ok(legitCheckGuardrails.opportunitiesAreNotCore.includes('geo.robots_mentions_gptbot'));
  assert.ok(legitCheckGuardrails.bestPracticesAreNotCore.includes('tech.hsts_header'));
  assert.ok(legitCheckGuardrails.unavailableToolingIsNotCore.includes('template.lighthouse_unavailable'));
  assert.ok(legitCheckGuardrails.pageTypeScopedSchema.includes('tech.product_coverage_on_product_like_pages'));
});

test('UI source exposes simplified card workspace and concrete export errors', () => {
  const appSource = readSource('../src/public/app.js');

  assert.match(appSource, /Audit Workspace/);
  assert.match(appSource, /Full Audit Export ZIP/);
  assert.match(appSource, /data-export-download/);
  assert.match(appSource, /download="audit-\$\{runId\}-full-audit\.zip"/);
  assert.match(appSource, /download="audit-\$\{runId\}-full-audit\.json"/);
  assert.match(appSource, /HTTP \$\{response\.status\}/);
  assert.doesNotMatch(appSource, /fetchJson\(`?\/api\/audits\/\$\{runId\}\/export\/full\.zip/);
  assert.match(appSource, /Export fehlgeschlagen: \$\{error\.message\}/);
  assert.match(appSource, /Technische Details/);
  assert.match(appSource, /Weitere CSV-Exports/);
  assert.match(appSource, />ToDo</);
  assert.doesNotMatch(appSource, /class="panel export-panel"/);
  assert.doesNotMatch(appSource, /Passed Checks \(/);
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedExportFixture(db) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const config = normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 20,
    maxDepth: 2,
    concurrency: 1,
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false
  });
  const runId = createRun(db, projectId, config);
  const runningRunId = createRun(db, projectId, config);
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 1,
    successfulUrls: 1,
    startedAt: '2026-06-28T08:00:00.000Z',
    finishedAt: '2026-06-28T08:01:00.000Z'
  });
  updateRun(db, runningRunId, {
    status: 'running',
    currentPhase: 'crawling',
    processedUrls: 0,
    startedAt: '2026-06-28T08:00:00.000Z'
  });

  insertPage(db, runId);
  db.prepare(`
    INSERT INTO check_results (
      runId, checkId, category, checkName, status, priority, effort, score,
      finding, details, recommendation, affectedCount, sampleUrlsJson, evidenceJson,
      reportGroupingKey, findingType, confidence, reviewRecommended, relatedCheckIdsJson
    )
    VALUES (?, 'tech.title_missing', 'HTML Head & Meta', 'Title missing', 'Warning', 'High', 'S', 60,
      'One page has no title.', 'Checked stored title values.', 'Add a descriptive title.', 1,
      '["https://example.com/"]', '{"affectedCount":1}', 'core', 'core_issue', 'high', 0, '[]')
  `).run(runId);
  db.prepare(`
    INSERT INTO page_images (runId, pageUrl, imageUrl, alt, hasAlt, loading, width, height, extension, sizeBytes, imageRole)
    VALUES (?, 'https://example.com/', 'https://example.com/hero.jpg', 'Hero', 1, 'lazy', '800', '400', '.jpg', 2000, 'content')
  `).run(runId);
  db.prepare(`
    INSERT INTO page_links (runId, sourceUrl, targetUrl, normalizedTargetUrl, linkType, anchorText, rel, statusCode)
    VALUES (?, 'https://example.com/', 'https://example.com/about', 'https://example.com/about', 'internal', 'About', '', 200)
  `).run(runId);
  db.prepare(`
    INSERT INTO resources (runId, pageUrl, resourceUrl, resourceType, statusCode, sizeBytes, contentType, isThirdParty, responseHeadersJson)
    VALUES (?, 'https://example.com/', 'https://example.com/app.js', 'script', 200, 1000, 'text/javascript', 0, '{}')
  `).run(runId);
  db.prepare(`
    INSERT INTO schemas (runId, pageUrl, schemaType, rawJson, parseStatus, parseError)
    VALUES (?, 'https://example.com/', 'WebSite', '{"@type":"WebSite"}', 'ok', NULL)
  `).run(runId);
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'llms', 'https://example.com/llms.txt', 200, '# llms', '{}')
  `).run(runId);

  return { runId, runningRunId };
}

function insertPage(db, runId) {
  db.prepare(`
    INSERT INTO pages (
      runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType, indexable,
      title, titleLength, metaDescription, metaDescriptionLength, h1Json, h1Count,
      h2Json, canonical, htmlLang, wordCountRaw, wordCountRendered, rawTextLength,
      renderedTextLength, rawHtmlSize, internalLinksCount, externalLinksCount,
      schemaTypesJson, imagesCount, imagesWithoutAltCount, responseHeadersJson,
      loadTimeMs, ttfbMs, consoleErrorsJson, renderedH1Json, renderedH1Count,
      renderedLinksCount, ogJson, favicon, manifest, featureFlagsJson, pageType,
      hasTables, hasLists, hasFaqPattern, hasVisibleDate, hasAuthorPattern,
      externalSourceLinksCount, hasVideoEmbed
    )
    VALUES (?, 'https://example.com/', 'https://example.com/', 'https://example.com/', 0, 200,
      'text/html; charset=utf-8', 1, NULL, 0, 'Description long enough', 23,
      '["Home"]', 1, '[]', 'https://example.com/', 'en', 120, 120, 600, 600,
      5000, 1, 1, '["WebSite"]', 1, 0, '{}', 200, 100, '[]', '["Home"]', 1,
      1, '{}', '/favicon.ico', NULL, '{}', 'homepage', 0, 1, 0, 0, 0, 1, 0)
  `).run(runId);
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

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
