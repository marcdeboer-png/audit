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
import { classifyManualItemCoverage } from '../src/validation/referenceAudit/coverageClassifier.js';
import { mapReferenceItemToChecks } from '../src/validation/referenceAudit/referenceAuditMapper.js';
import { summarizeAiBotRules } from '../src/utils/robots.js';

test('Batch 10.5 mapping adds x-robots, semantics, YMYL and avoids broad false matches', () => {
  const xRobots = mapReferenceItemToChecks(referenceItem('x-robots header', 'X-Robots-Tag noindex header directives'));
  assert.ok(xRobots.expectedCheckIds.includes('tech.x_robots_tag_unusual'));

  const semantics = mapReferenceItemToChecks(referenceItem('HTML semantics', 'main region landmarks and heading hierarchy'));
  assert.ok(semantics.expectedCheckIds.includes('tech.html_semantics_summary'));

  const ymyl = mapReferenceItemToChecks(referenceItem('YMYL', 'Health and veterinary advice needs E-E-A-T review'));
  assert.ok(ymyl.expectedCheckIds.includes('trust.ymyl_review_signal'));
  assert.equal(ymyl.requiresHumanJudgment, true);

  const templates = mapReferenceItemToChecks(referenceItem('Page templates', 'Template pattern issue in CMS modules'));
  assert.ok(templates.expectedCheckIds.includes('template.title_pattern_issue'));

  const httpVersion = mapReferenceItemToChecks(referenceItem('HTTP version', 'HTTP/2 enables parallel loading of multiple assets.'));
  assert.ok(httpVersion.expectedCheckIds.includes('tech.http_version_support'));
  assert.equal(httpVersion.expectedCheckIds.includes('tech.third_party_scripts_detected'), false);

  const contentQuality = mapReferenceItemToChecks(referenceItem('Content quality & thin content', 'Thin PDP content lacks depth.'));
  assert.equal(contentQuality.expectedCheckIds.includes('tech.meta_description_too_long'), false);
});

test('Batch 10.5 advisory manual-OK matches are not false-positive candidates', () => {
  const item = {
    id: 'manual-og-ok',
    title: 'Open Graph tags',
    description: 'Open Graph previews are OK in the manual audit.',
    category: 'HTML Head',
    priority: 'Medium',
    status: 'ok'
  };
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [{
    id: 1,
    checkId: 'tech.open_graph_basics_missing',
    status: 'Warning',
    priority: 'Low',
    findingType: 'opportunity',
    confidence: 'low',
    reviewRecommended: 1,
    affectedCount: 3,
    category: 'HTML Head & Meta Opportunity',
    checkName: 'Open Graph metadata completeness',
    finding: 'Open Graph metadata is incomplete on a few pages.',
    recommendation: 'Treat as sharing/entity opportunity.',
    sampleUrlsJson: '[]'
  }], { run: { processedUrls: 120 } });

  assert.notEqual(coverage.coverageStatus, 'false_positive_candidate');
  assert.match(coverage.rationale, /advisory\/review-oriented/);
});

test('Batch 10.5 checks separate hard issues from opportunities and review signals', async () => {
  const db = setupDb();
  const runId = seedRun(db);
  insertFixturePage(db, runId, 'https://fixture.local/article/gesundheit', {
    pageType: 'article',
    h1Count: 1,
    h1Json: JSON.stringify(['Tiergesundheit']),
    wordCountRaw: 40,
    rawTextLength: 220,
    ogJson: JSON.stringify({ 'og:title': 'Tiergesundheit', 'og:description': null, 'og:image': null, 'og:url': 'https://fixture.local/article/gesundheit', 'og:type': null }),
    favicon: null,
    xRobotsTag: 'noindex, noarchive',
    noindex: 1,
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html' }),
    featureFlagsJson: JSON.stringify({
      mainRegionCount: 0,
      headerRegionCount: 1,
      navRegionCount: 0,
      footerRegionCount: 1,
      emptyH1Count: 0,
      emptyH2Count: 1,
      headingHierarchySkips: 1,
      hasGoogleTagManager: true,
      hasDataLayer: true,
      thirdPartyMarketingSignals: ['google_tag_manager']
    })
  });
  replacePageArtifacts(db, runId, 'https://fixture.local/article/gesundheit', {
    resources: [
      resource('https://cdn.example.com/a.js'),
      resource('https://tags.example.com/b.js'),
      resource('https://analytics.example.com/c.js')
    ]
  });
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'robots', 'https://fixture.local/robots.txt', 200, 'User-agent: *\nAllow: /', '{}')
  `).run(runId);

  await runChecks(db, runId);
  const rows = new Map(loadResultsWithScores(db, runId).results.map((row) => [row.checkId, row]));

  assert.equal(rows.get('tech.open_graph_basics_missing').normalizedFindingType, 'opportunity');
  assert.equal(rows.get('tech.open_graph_basics_missing').priority, 'Low');
  assert.equal(rows.get('tech.open_graph_basics_missing').reviewRecommended, 1);

  assert.equal(rows.get('tech.favicon_missing').findingType, 'best_practice');
  assert.equal(rows.get('tech.favicon_missing').priority, 'Low');
  assert.equal(rows.get('tech.html_semantics_summary').reviewRecommended, 1);

  assert.equal(rows.get('tech.x_robots_tag_unusual').status, 'Warning');
  assert.equal(rows.get('tech.x_robots_tag_unusual').evidence.contentNoindexCount, 1);

  assert.equal(rows.get('tech.consent_technical_signals').status, 'Warning');
  assert.equal(rows.get('tech.consent_technical_signals').automationCoverage, 'requires_human_review');
  assert.match(rows.get('tech.consent_technical_signals').limitations, /cannot prove/i);

  assert.equal(rows.get('tech.preconnect_missing').normalizedFindingType, 'opportunity');
  assert.equal(rows.get('tech.third_party_scripts_detected').normalizedFindingType, 'opportunity');

  const rawContent = rows.get('tech.critical_content_raw_html_signal');
  assert.equal(rawContent.status, 'OK');
  assert.equal(rawContent.confidence, 'low');
  assert.match(rawContent.interpretation, /no hard JavaScript-dependency claim/i);

  assert.equal(rows.get('trust.ymyl_review_signal').reviewRecommended, 1);
  db.close();
});

test('Batch 10.5 AI bot policy distinguishes explicit, wildcard and missing bot rules', () => {
  const summary = summarizeAiBotRules('https://fixture.local/robots.txt', [
    'User-agent: *',
    'Allow: /',
    '',
    'User-agent: GPTBot',
    'Allow: /',
    '',
    'User-agent: CCBot',
    'Disallow: /'
  ].join('\n'));

  assert.equal(summary.find((row) => row.bot === 'GPTBot').policyStatus, 'allowed_explicitly');
  assert.equal(summary.find((row) => row.bot === 'CCBot').policyStatus, 'blocked_explicitly');
  assert.equal(summary.find((row) => row.bot === 'Applebot').policyStatus, 'inherited_wildcard_allowed');
  assert.ok(summary.some((row) => row.bot === 'Bytespider'));
});

function referenceItem(title, description) {
  return {
    id: title,
    title,
    description,
    category: 'Technical SEO',
    priority: 'Medium',
    status: 'open'
  };
}

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function seedRun(db) {
  const projectId = createProject(db, { inputDomain: 'https://fixture.local', brandName: 'Fixture' });
  updateProject(db, projectId, {
    finalDomain: 'https://fixture.local',
    protocolBehaviorJson: JSON.stringify([]),
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
    successfulUrls: 1
  });
  return runId;
}

function insertFixturePage(db, runId, url, overrides = {}) {
  const title = overrides.title || 'Fixture Page';
  insertPage(db, {
    runId,
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    sourceUrl: null,
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    indexable: overrides.indexable ?? 1,
    noindex: overrides.noindex ?? 0,
    nofollow: overrides.nofollow ?? 0,
    title,
    titleLength: title.length,
    metaDescription: 'A fixture page for audit checks.',
    metaDescriptionLength: 32,
    h1Json: overrides.h1Json || JSON.stringify(['Fixture']),
    h1Count: overrides.h1Count ?? 1,
    h2Json: JSON.stringify(['Section']),
    canonical: url,
    htmlLang: 'de',
    viewport: 'width=device-width, initial-scale=1',
    metaRobots: overrides.metaRobots || null,
    xRobotsTag: overrides.xRobotsTag || null,
    wordCountRaw: overrides.wordCountRaw ?? 160,
    wordCountRendered: overrides.wordCountRendered ?? null,
    rawTextLength: overrides.rawTextLength ?? 800,
    renderedTextLength: overrides.renderedTextLength ?? null,
    rawHtmlSize: 3000,
    internalLinksCount: 4,
    externalLinksCount: 0,
    schemaTypesJson: JSON.stringify(overrides.schemaTypes || []),
    imagesCount: 0,
    imagesWithoutAltCount: 0,
    responseHeadersJson: overrides.responseHeadersJson || JSON.stringify({ 'content-type': 'text/html', 'cache-control': 'max-age=60' }),
    loadTimeMs: 80,
    ttfbMs: 40,
    consoleErrorsJson: JSON.stringify([]),
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: null,
    renderedLinksCount: null,
    ogJson: overrides.ogJson || JSON.stringify({ 'og:title': title, 'og:description': 'Fixture', 'og:image': '/og.jpg', 'og:url': url, 'og:type': 'article' }),
    favicon: Object.hasOwn(overrides, 'favicon') ? overrides.favicon : '/favicon.ico',
    manifest: '/site.webmanifest',
    featureFlagsJson: overrides.featureFlagsJson || JSON.stringify({ mainRegionCount: 1, headerRegionCount: 1, navRegionCount: 1, footerRegionCount: 1 }),
    pageType: overrides.pageType || 'other',
    hasTables: 0,
    hasLists: 1,
    hasFaqPattern: 0,
    hasVisibleDate: 0,
    hasAuthorPattern: 0,
    externalSourceLinksCount: 0,
    hasVideoEmbed: 0
  });
}

function resource(resourceUrl) {
  return {
    pageUrl: 'https://fixture.local/article/gesundheit',
    resourceUrl,
    resourceType: 'script',
    statusCode: 200,
    sizeBytes: null,
    contentType: 'application/javascript',
    isThirdParty: 1,
    responseHeadersJson: JSON.stringify({ 'cache-control': 'max-age=3600' })
  };
}
