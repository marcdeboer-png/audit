import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  getRunWithProject,
  insertDomainAsset,
  insertCheckResults,
  insertPage,
  replacePageArtifacts,
  updateProject,
  updateRun,
  upsertPageSnapshot
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { estimateStorage } from '../src/storage/storageProfiles.js';
import { detectScreamingFrogExport } from '../src/importers/screamingFrog/detectScreamingFrogExport.js';
import { parseScreamingFrogCsv } from '../src/importers/screamingFrog/parseScreamingFrogCsv.js';
import { importScreamingFrogAudit } from '../src/importers/screamingFrog/screamingFrogImportService.js';
import { pageRecordFromFact } from '../src/facts/urlFacts.js';
import { buildTemplateClusters } from '../src/analysis/templateClusterer.js';
import { runChecks } from '../src/checks/checkEngine.js';
import { buildMaturityModel } from '../src/maturity/maturityService.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { runLlmChecks, llmConfigurationWarnings } from '../src/llm/llmCheckRunner.js';
import { filterArtifactsForStorage } from '../src/storage/retention.js';

test('Batch 10 storage profiles normalize defaults and warn for debug large crawls', () => {
  const standard = normalizeAuditConfig({ domain: 'https://example.com', maxUrls: 50000 });
  assert.equal(standard.storageProfile, 'standard');
  assert.equal(standard.storeRawHtml, false);
  assert.equal(standard.storeAllLinks, true);
  assert.equal(standard.crawlScaleMode, 'large');

  const lean = normalizeAuditConfig({ domain: 'https://example.com', storageProfile: 'lean', maxUrls: 100000 });
  assert.equal(lean.storageProfile, 'lean');
  assert.equal(lean.storeAllLinks, false);
  assert.equal(lean.storeAffectedOnlyDetails, true);
  assert.equal(lean.crawlScaleMode, 'enterprise');

  const estimate = estimateStorage({ storageProfile: 'debug', maxUrls: 50001, storeRawHtml: true, storeRenderedHtml: true });
  assert.equal(estimate.riskLevel, 'high');
  assert.match(estimate.warnings.join(' '), /Debug Storage/);
});

test('Batch 10 evidence retention caps samples and truncates long error evidence', () => {
  const db = setupDb();
  const runId = seedRun(db, { maxEvidenceSamplesPerCheck: 5, maxStoredDetailRowsPerCheck: 10 });
  insertCheckResults(db, runId, [{
    id: 'tech.test_storage_cap',
    category: 'Storage',
    name: 'Storage cap',
    auditType: 'tech',
    status: 'Warning',
    priority: 'Medium',
    effort: 'S',
    finding: 'Finding',
    recommendation: 'Recommendation',
    affectedCount: 50,
    sampleUrls: Array.from({ length: 20 }, (_, index) => `https://example.com/${index}`),
    evidence: {
      samples: Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}` })),
      stacktrace: 'x'.repeat(10000)
    }
  }]);
  const row = db.prepare('SELECT sampleUrlsJson, evidenceJson FROM check_results WHERE runId = ?').get(runId);
  assert.equal(JSON.parse(row.sampleUrlsJson).length, 5);
  const evidence = JSON.parse(row.evidenceJson);
  assert.equal(evidence.samples.length, 5);
  assert.match(evidence.stacktrace, /truncated/);
  db.close();
});

test('Batch 10 raw HTML snapshots stay separate and debug can store capped HTML', () => {
  const db = setupDb();
  const leanRunId = seedRun(db, { storageProfile: 'lean' });
  const debugRunId = seedRun(db, {
    storageProfile: 'debug',
    storeRawHtml: true,
    maxRawHtmlBytesPerUrl: 20
  });
  upsertPageSnapshot(db, {
    runId: debugRunId,
    pageUrl: 'https://example.com/debug',
    normalizedUrl: 'https://example.com/debug',
    rawHtml: '<html><body>abcdefghijklmnopqrstuvwxyz</body></html>',
    rawHtmlBytes: 48,
    rawHtmlTruncated: true
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM page_snapshots WHERE runId = ?').get(leanRunId).count, 0);
  const snapshot = db.prepare('SELECT rawHtml, rawHtmlTruncated FROM page_snapshots WHERE runId = ?').get(debugRunId);
  assert.match(snapshot.rawHtml, /html/);
  assert.equal(snapshot.rawHtmlTruncated, 1);
  db.close();
});

test('Batch 10.3 storage caps schema rawJson, domain assets and page links by profile', () => {
  const db = setupDb();
  const standardRunId = seedRun(db, { storageProfile: 'standard' });
  const leanRunId = seedRun(db, { storageProfile: 'lean' });
  const debugRunId = seedRun(db, { storageProfile: 'debug' });
  for (const runId of [standardRunId, leanRunId, debugRunId]) {
    insertPage(db, pageRecordFromFact(runId, {
      url: 'https://example.com/a',
      statusCode: 200,
      title: 'Example',
      h1Text: 'Example'
    }));
  }

  replacePageArtifacts(db, standardRunId, 'https://example.com/a', filterArtifactsForStorage(getRunWithProject(db, standardRunId), {
    links: Array.from({ length: 250 }, (_, index) => ({
      sourceUrl: 'https://example.com/a',
      targetUrl: `https://example.com/${index}`,
      normalizedTargetUrl: `https://example.com/${index}`,
      linkType: 'internal'
    })),
    schemas: [{ schemaType: 'Product', rawJson: '{"x":"' + 'a'.repeat(12000) + '"}', parseStatus: 'ok' }]
  }));
  replacePageArtifacts(db, leanRunId, 'https://example.com/a', filterArtifactsForStorage(getRunWithProject(db, leanRunId), {
    links: Array.from({ length: 20 }, (_, index) => ({
      sourceUrl: 'https://example.com/a',
      targetUrl: `https://example.com/${index}`,
      normalizedTargetUrl: `https://example.com/${index}`,
      linkType: 'internal'
    })),
    schemas: [{ schemaType: 'Product', rawJson: '{"x":"' + 'b'.repeat(12000) + '"}', parseStatus: 'ok' }]
  }));
  replacePageArtifacts(db, debugRunId, 'https://example.com/a', filterArtifactsForStorage(getRunWithProject(db, debugRunId), {
    schemas: [{ schemaType: 'Product', rawJson: '{"x":"' + 'c'.repeat(12000) + '"}', parseStatus: 'ok' }]
  }));

  insertDomainAsset(db, {
    runId: standardRunId,
    type: 'sitemap',
    url: 'https://example.com/sitemap.xml',
    statusCode: 200,
    content: '<urlset>' + 'x'.repeat(100000) + '</urlset>',
    responseHeadersJson: '{"cache-control":"' + 'y'.repeat(10000) + '"}'
  });
  insertDomainAsset(db, {
    runId: standardRunId,
    type: 'sitemap',
    url: 'https://example.com/sitemap.xml',
    statusCode: 200,
    content: '<urlset>dedupe</urlset>',
    responseHeadersJson: '{}'
  });

  const standardSchema = db.prepare('SELECT rawJson FROM schemas WHERE runId = ?').get(standardRunId);
  const leanSchema = db.prepare('SELECT rawJson FROM schemas WHERE runId = ?').get(leanRunId);
  const debugSchema = db.prepare('SELECT rawJson FROM schemas WHERE runId = ?').get(debugRunId);
  assert.ok(standardSchema.rawJson.length < 5000);
  assert.equal(leanSchema.rawJson, null);
  assert.ok(debugSchema.rawJson.length > 10000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM page_links WHERE runId = ?').get(standardRunId).count, 25);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM page_links WHERE runId = ?').get(leanRunId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM domain_assets WHERE runId = ?').get(standardRunId).count, 1);
  assert.match(db.prepare('SELECT content FROM domain_assets WHERE runId = ?').get(standardRunId).content, /dedupe/);
  const page = db.prepare('SELECT uniqueInternalTargetsCount, storedLinkRowsCount, linkRowsTruncated FROM pages WHERE runId = ? AND finalUrl = ?').get(standardRunId, 'https://example.com/a');
  assert.equal(page.uniqueInternalTargetsCount, 250);
  assert.equal(page.storedLinkRowsCount, 25);
  assert.equal(page.linkRowsTruncated, 1);
  assert.ok(db.prepare('SELECT rawJsonHash, rawJsonBytes FROM schemas WHERE runId = ?').get(standardRunId).rawJsonHash);
  db.close();
});

test('Batch 10 Screaming Frog CSV detection and import create facts, findings, maturity and exports', async () => {
  const db = setupDb();
  const csv = [
    'Address,Status Code,Content Type,Indexability,Title 1,Title 1 Length,Meta Description 1,Meta Description 1 Length,H1-1,Word Count,Crawl Depth,Canonical Link Element 1,Images Missing Alt Text,Schema Types,Unknown Custom',
    'https://example.com/products/a,200,text/html,Indexable,This is a deliberately too long product title that should trigger the pattern check,83,,0,Product A,500,2,https://example.com/products/a,2,Product|BreadcrumbList,x',
    'https://example.com/products/b,200,text/html,Indexable,This is a deliberately too long product title that should trigger the pattern check,83,,0,Product B,480,2,https://example.com/products/b,1,Product|BreadcrumbList,x',
    'https://example.com/products/c,200,text/html,Indexable,This is a deliberately too long product title that should trigger the pattern check,83,,0,Product C,470,2,https://example.com/products/c,0,Product|BreadcrumbList,x'
  ].join('\n');
  const parsed = parseScreamingFrogCsv(csv);
  const detected = detectScreamingFrogExport(parsed.headers, 'internal_html.csv');
  assert.equal(detected.type, 'internal_html');

  const { runId, summary } = await importScreamingFrogAudit(db, {
    domain: 'https://example.com',
    files: [{ filename: 'internal_html.csv', content: csv }],
    storageProfile: 'standard'
  });
  assert.equal(summary.urlsTotal, 3);
  assert.ok(summary.ignoredColumns.includes('Unknown Custom'));
  const run = getRunWithProject(db, runId);
  assert.equal(run.sourceType, 'screaming_frog_import');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count, 3);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM check_results WHERE runId = ?').get(runId).count > 0);
  assert.ok(buildMaturityModel(db, runId).categories.length > 0);
  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  assert.equal(fullJson.runConfig.sourceType, 'screaming_frog_import');
  assert.equal(fullJson.exportManifest.storageProfile, 'standard');
  db.close();
});

test('Batch 10.4 Screaming Frog folder import maps enterprise header, hreflang and Open Graph signals', async () => {
  const db = setupDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sf-folder-'));
  fs.writeFileSync(path.join(dir, 'internal_html.csv'), [
    'Address,Status Code,Content Type,Indexability,Title 1,Meta Description 1,H1-1',
    'https://example.com/a,200,text/html,Indexable,Page A,Description A,Heading A'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'headers.csv'), [
    'Address,Cache-Control,X-Cache,CF-Cache-Status,HTTP Version,Server',
    'https://example.com/a,max-age=3600,HIT,HIT,h2,cloudflare'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'hreflang.csv'), [
    'Address,Hreflang,Alternate URL,X-Default',
    'https://example.com/a,de-DE,https://example.com/a,https://example.com/'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'open_graph.csv'), [
    'Address,OG Title,OG Description,OG Image,OG URL,OG Type,Favicon,Apple Touch Icon,Preconnect,Google Tag Manager,Google Consent Mode',
    'https://example.com/a,Page A,Description A,https://example.com/og.jpg,https://example.com/a,website,https://example.com/favicon.ico,https://example.com/apple.png,1,true,true'
  ].join('\n'), 'utf8');

  const { runId, summary } = await importScreamingFrogAudit(db, {
    domain: 'https://example.com',
    folderPath: dir,
    storageProfile: 'standard'
  });
  assert.equal(summary.filesImported, 4);
  assert.ok(summary.detectedExportTypes.includes('hreflang'));
  assert.ok(summary.detectedExportTypes.includes('opengraph'));
  assert.ok(summary.detectedExportTypes.includes('security_headers'));
  const page = db.prepare('SELECT responseHeadersJson, ogJson, favicon, featureFlagsJson FROM pages WHERE runId = ?').get(runId);
  assert.match(page.responseHeadersJson, /cf-cache-status/);
  assert.match(page.ogJson, /og:type/);
  assert.equal(page.favicon, 'https://example.com/favicon.ico');
  const flags = JSON.parse(page.featureFlagsJson);
  assert.equal(flags.hasHreflangXDefault, true);
  assert.equal(flags.hasGoogleTagManager, true);
  assert.equal(flags.hasGoogleConsentMode, true);
  const checks = db.prepare('SELECT checkId, status FROM check_results WHERE runId = ?').all(runId);
  const byId = new Map(checks.map((row) => [row.checkId, row.status]));
  assert.equal(byId.get('tech.http_version_support'), 'OK');
  assert.equal(byId.get('tech.hreflang_x_default_missing'), 'OK');
  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('Batch 10 fact layer maps crawl and Screaming Frog-style facts to compatible page rows', () => {
  const row = pageRecordFromFact(1, {
    url: 'https://example.com/a',
    statusCode: '200',
    title: 'Title',
    metaDescription: 'Description',
    h1Text: 'Heading',
    canonical: 'https://example.com/a',
    schemaTypes: 'Article|BreadcrumbList',
    cruxLcp: '2400',
    psiPerformanceScore: '82'
  });
  assert.equal(row.normalizedUrl, 'https://example.com/a');
  assert.equal(row.statusCode, 200);
  assert.equal(row.h1Count, 1);
  assert.deepEqual(JSON.parse(row.schemaTypesJson), ['Article', 'BreadcrumbList']);
  assert.equal(row.cruxLcp, 2400);
  assert.equal(row.psiPerformanceScore, 0.82);
});

test('Batch 10 template pattern checks detect title, noindex and missing schema patterns', async () => {
  const db = setupDb();
  const runId = seedRun(db, { maxUrls: 20 });
  for (let index = 1; index <= 4; index += 1) {
    insertPage(db, pageRecordFromFact(runId, {
      url: `https://example.com/products/${index}`,
      statusCode: 200,
      title: 'This is a deliberately too long product title that should trigger the template title pattern issue',
      metaDescription: 'Short',
      h1Text: `Product ${index}`,
      pageType: 'product',
      noindex: index <= 3,
      metaRobots: index <= 3 ? 'noindex' : '',
      schemaTypes: [],
      rawHtmlSize: 300 * 1024
    }));
  }
  buildTemplateClusters(db, runId);
  await runChecks(db, runId);
  const rows = db.prepare("SELECT checkId, status, affectedCount, sampleUrlsJson FROM check_results WHERE runId = ? AND checkId LIKE 'template.%'").all(runId);
  const byId = new Map(rows.map((row) => [row.checkId, row]));
  assert.equal(byId.get('template.title_pattern_issue').status, 'Warning');
  assert.equal(byId.get('template.noindex_pattern').status, 'Warning');
  assert.equal(byId.get('template.schema_missing_pattern').status, 'Warning');
  assert.ok(JSON.parse(byId.get('template.title_pattern_issue').sampleUrlsJson).length > 0);
  db.close();
});

test('Batch 10 LLM checks are disabled by default, warn on missing keys and mock dry-run creates review findings', async () => {
  const disabled = normalizeAuditConfig({ domain: 'https://example.com' });
  assert.equal(disabled.enableLlmChecks, false);

  const db = setupDb();
  const runId = seedRun(db, { enableLlmChecks: true, llmProvider: 'mock', llmDryRun: true });
  insertPage(db, pageRecordFromFact(runId, {
    url: 'https://example.com/',
    statusCode: 200,
    title: 'Example',
    h1Text: 'Example',
    metaDescription: 'Example page',
    schemaTypes: ['Organization']
  }));
  const run = getRunWithProject(db, runId);
  const results = await runLlmChecks({ db, run });
  assert.ok(results.length > 0);
  assert.equal(results.every((row) => row.findingType === 'llm_assisted'), true);
  assert.equal(results.every((row) => row.reviewRecommended), true);
  assert.equal(results.every((row) => row.confidence === 'medium'), true);

  const openAiRun = { ...run, llmProvider: 'openai', llmDryRun: false };
  assert.match(llmConfigurationWarnings(openAiRun).join(' '), /OPENAI_API_KEY/);
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedRun(db, overrides = {}) {
  const projectId = createProject(db, { inputDomain: 'https://example.com', brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: 'https://example.com' });
  const config = normalizeAuditConfig({
    domain: 'https://example.com',
    auditType: 'both',
    maxUrls: 10,
    maxDepth: 2,
    concurrency: 1,
    enableTemplateSampling: false,
    ...overrides
  });
  const runId = createRun(db, projectId, config);
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    startedAt: '2026-07-01T08:00:00.000Z',
    finishedAt: '2026-07-01T08:01:00.000Z'
  });
  return runId;
}
