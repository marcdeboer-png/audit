import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  insertCheckResults,
  updateProject,
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { buildMaturityModel } from '../src/maturity/maturityService.js';
import { collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { createSunburstLayout, createSunburstSegments, maturityLegend, scoreToColor, sunburstArcPath } from '../src/public/sunburst.js';

test('Batch 9.3 sunburst segments follow reference item-count sizing', () => {
  const segments = createSunburstSegments([
    maturityCategory('technical-seo', 'Technical SEO', 10, 2, 4, 4, 4),
    maturityCategory('geo-readiness', 'GEO Readiness', 4, 1, 2, 2, 2)
  ], { gap: 0 });

  assert.equal(segments.length, 2);
  assert.equal(segments[0].categoryId, 'technical-seo');
  assert.equal(segments[0].weight, 2);
  assert.equal(segments[1].weight, 1);
  assert.equal(Math.round((segments[0].sweep / segments[1].sweep) * 10) / 10, 2);
  assert.equal(segments[0].weightShare, 66.7);
  assert.equal(segments[1].weightShare, 33.3);
});

test('Batch 9.3 sunburst layout contains inner category and outer item rings', () => {
  const layout = createSunburstLayout([
    maturityCategory('technical-seo', 'Technical SEO', 10, 2, 4, 4, 4),
    maturityCategory('geo-readiness', 'GEO Readiness', 4, 1, 2, 2, 2)
  ], { size: 900, gap: 0, itemGap: 0 });

  assert.equal(layout.categories.length, 2);
  assert.equal(layout.items.length, 6);
  assert.equal(layout.centerRadius, 60);
  assert.equal(Math.round(layout.categoryOuterRadius), 243);
  assert.equal(Math.round(layout.itemInnerRadius), 245);
  assert.equal(layout.itemOuterRadius, 432);
  assert.equal(layout.items.every((item) => item.type === 'item'), true);
});

test('Batch 9.3 sunburst keeps unavailable categories visible and neutral', () => {
  const segments = createSunburstSegments([
    maturityCategory('ai-crawler-policy', 'AI Crawler Policy', null, 1.2, 3, 0)
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].score, null);
  assert.equal(segments[0].isEvaluated, false);
  assert.equal(segments[0].color, 'var(--rg-none)');
  assert.equal(segments[0].maturityLabel, 'Nicht bewertet');
});

test('Batch 9.3 sunburst color mapping uses OMfire reifegrad tokens', () => {
  assert.equal(scoreToColor(null), 'var(--rg-none)');
  assert.equal(scoreToColor(1.9), 'var(--rg-1)');
  assert.equal(scoreToColor(3.9), 'var(--rg-2)');
  assert.equal(scoreToColor(5.4), 'var(--rg-4)');
  assert.equal(scoreToColor(6.9), 'var(--rg-6)');
  assert.equal(scoreToColor(8.4), 'var(--rg-8)');
  assert.equal(scoreToColor(8.5), 'var(--rg-10)');
  assert.deepEqual(maturityLegend.map((item) => item.color), [
    'var(--rg-1)',
    'var(--rg-2)',
    'var(--rg-4)',
    'var(--rg-6)',
    'var(--rg-8)',
    'var(--rg-10)',
    'var(--rg-none)'
  ]);
});

test('Batch 9.3 sunburst arc path creates a bounded svg path without external libraries', () => {
  const path = sunburstArcPath(260, 260, -Math.PI / 2, 0, 86, 222);
  assert.match(path, /^M /);
  assert.match(path, /A 222 222/);
  assert.match(path, /A 86 86/);
  assert.match(path, /Z$/);
});

test('Batch 9.3 maturity API and exports expose visualization metadata without changing score', () => {
  const db = setupDb();
  const { runId } = seedFixture(db);

  const model = buildMaturityModel(db, runId);
  assert.equal(model.weightedScore, 4.2);
  assert.deepEqual(model.visualization.sunburst, {
    segmentSource: 'maturity.categories',
    segmentSize: 'category.items.length',
    segmentColor: 'category.score',
    unavailableCategoryHandling: 'visible_neutral'
  });

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings']).body);
  assert.equal(fullJson.maturity.weightedScore, 4.2);
  assert.equal(fullJson.maturity.visualization.sunburst.segmentSize, 'category.items.length');
  assert.equal(fullJson.maturity.categories.some((category) => Array.isArray(category.items) && category.items.length), true);
  const titleCategory = fullJson.maturity.categories.find((category) => category.items.some((item) => item.id === 'tech.title_missing'));
  const titleItem = titleCategory.items.find((item) => item.id === 'tech.title_missing');
  assert.equal(titleItem.score, 1);
  assert.equal(titleItem.status, 'Warning');

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  const zipMaturity = JSON.parse(zipEntries['summary/maturity.json']);
  assert.equal(zipMaturity.visualization.sunburst.segmentColor, 'category.score');

  db.close();
});

test('Batch 9.3 UI source renders OMfire sunburst, tooltip, legend and table hover linkage', () => {
  const app = readSource('../src/public/app.js');
  const css = readSource('../src/public/styles.css');
  const sunburst = readSource('../src/public/sunburst.js');

  assert.match(app, /renderMaturitySunburst/);
  assert.match(app, /createSunburstLayout/);
  assert.match(app, /maturity-sunburst-tip/);
  assert.match(app, /maturity-table cat-table/);
  assert.match(app, /sunburst-category-segment/);
  assert.match(app, /sunburst-item-segment/);
  assert.match(app, /data-item-count/);
  assert.match(app, /data-category-id/);
  assert.match(app, /data-check-result-id/);
  assert.match(app, /navigateToSunburstItemDetail/);
  assert.match(app, /results\/\$\{runId\}\/check\/\$\{checkResultId\}/);
  assert.match(app, /setCurrentMaturityIndex/);
  assert.match(app, /setCurrentResults/);
  assert.match(app, /currentResultsById/);
  assert.match(app, /checkpointViewModel\(row\)/);
  assert.match(app, /checkpointViewModelForSegment/);
  assert.match(app, /setMaturitySegmentHighlight/);
  assert.match(app, /maturity-score-pill/);
  assert.match(app, /setupMaturitySunburstTooltip/);
  assert.match(css, /\.maturity-sunburst/);
  assert.match(css, /\.sunburst-category-segment/);
  assert.match(css, /\.sunburst-item-segment/);
  assert.match(css, /\.check-card\.is-deep-linked/);
  assert.match(css, /--check-card-color/);
  assert.match(css, /\.sunburst-segment:hover/);
  assert.match(css, /\.sunburst-item-segment:hover/);
  assert.match(css, /\.sunburst-category-segment\.is-related/);
  assert.match(css, /opacity:\s*1/);
  assert.match(css, /\.legend-bar/);
  assert.match(css, /\.tip/);
  assert.match(css, /\.tip \.ts[\s\S]*align-items:\s*center/);
  assert.match(css, /\.maturity-table tbody tr:hover[\s\S]*background:\s*var\(--row-hover\)/);
  assert.match(css, /\.theme-toggle:hover[\s\S]*border-color:\s*var\(--red\)/);
  assert.match(css, /\.maturity-stats[\s\S]*grid-template-columns:\s*repeat\(4,\s*1fr\)/);
  assert.match(sunburst, /createSunburstLayout/);
  assert.doesNotMatch(app, /Interhyp|109 Pruefpunkte|109 Prüfpunkte|5\\.1/);
  assert.doesNotMatch(app, /Pruefpunkte|Pruefpunkt|Staerken|Schwaechen|naechste|Letzte Laeufe/);
  assert.doesNotMatch(app, /<title>/);
  assert.doesNotMatch(`${app}\n${css}\n${sunburst}`, /d3\.|from ['"]d3/i);
  assert.doesNotMatch(sunburst, /https:\/\/|http:\/\//i);
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
    concurrency: 1
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 5,
    successfulUrls: 5,
    startedAt: '2026-06-29T08:00:00.000Z',
    finishedAt: '2026-06-29T08:01:00.000Z'
  });
  insertCheckResults(db, runId, [
    checkResult('tech.https_reachable', 'Server & Infrastructure', 'HTTPS reachable', 'OK', 'Low', 'info'),
    checkResult('tech.title_missing', 'HTML Head & Meta', 'Title missing', 'Warning', 'High', 'core_issue'),
    checkResult('geo.llms_txt_present', 'GEO Opportunities', 'llms.txt present', 'Warning', 'Low', 'opportunity'),
    checkResult('template.lighthouse_unavailable', 'Template Performance', 'Lighthouse unavailable', 'NA', 'Low', 'info')
  ]);
  return { runId };
}

function maturityCategory(id, name, score, weight, checkCount, evaluatedCount, itemCount = 0) {
  return {
    id,
    name,
    score,
    weight,
    checkCount,
    evaluatedCount,
    maturityLabel: score === null ? null : 'Test Label',
    recommendation: `${name} recommendation`,
    managementDescription: `${name} management`,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `${id}.${index + 1}`,
      label: `${name} Check ${index + 1}`,
      score,
      status: score === null ? 'NA' : 'OK',
      affectedCount: 0
    }))
  };
}

function checkResult(id, category, name, status, priority, findingType) {
  const affectedCount = status === 'OK' || status === 'NA' ? 0 : 1;
  return {
    id,
    category,
    name,
    auditType: id.startsWith('geo.') ? 'geo' : 'tech',
    status,
    priority,
    effort: 'S',
    finding: `${name} finding`,
    details: `${name} details`,
    recommendation: `${name} recommendation`,
    affectedCount,
    sampleUrls: affectedCount ? ['https://example.com/a'] : [],
    evidence: { affectedCount },
    findingType,
    confidence: 'high',
    reviewRecommended: false
  };
}

function readStoredZip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUIntLE(offset + 18, 4);
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

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
