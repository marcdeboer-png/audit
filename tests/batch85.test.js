import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { startAudit } from '../src/crawler/auditRunner.js';
import { getDb, initDatabase, resetInterruptedWork } from '../src/db/database.js';
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
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import {
  getLegitCheckExpectation,
  legitCheckExpectations,
  legitExpectationByCheckId
} from '../src/checks/qa/legitimacy.js';
import { thresholds } from '../src/checks/config/thresholds.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { collectCheckDetailCsv, collectFullAuditJson, collectFullAuditZip } from '../src/results/checkExportService.js';
import { useTempAuditDb } from './helpers/testDb.js';
import { startFixtureSite } from './helpers/fixtureSites.js';

const tempDb = useTempAuditDb('batch85-fixtures');
after(() => tempDb.cleanup());

test('legitimacy QA expectations are machine-checkable and cover registered critical checks', () => {
  const registeredIds = new Set([...techChecks(), ...geoChecks()].map((check) => check.id));
  const validStatuses = new Set(['OK', 'Warning', 'Error', 'NA']);
  const validFindingTypes = new Set(['core_issue', 'opportunity', 'best_practice', 'info']);

  assert.ok(legitCheckExpectations.length >= 50);
  for (const item of legitCheckExpectations) {
    assert.equal(registeredIds.has(item.checkId), true, `${item.checkId} is registered`);
    assert.deepEqual(legitExpectationByCheckId[item.checkId], item);
    assert.deepEqual(getLegitCheckExpectation(item.checkId), item);
    assert.equal(typeof item.expectedScope, 'string');
    assert.ok(item.expectedScope.length > 10, item.checkId);
    assert.ok(item.allowedStatuses.length > 0, item.checkId);
    assert.ok(item.allowedFindingTypes.length > 0, item.checkId);
    for (const status of item.allowedStatuses) assert.equal(validStatuses.has(status), true, `${item.checkId} status ${status}`);
    for (const type of item.allowedFindingTypes) assert.equal(validFindingTypes.has(type), true, `${item.checkId} type ${type}`);
    assert.equal(typeof item.requiresEvidence, 'boolean', item.checkId);
    assert.equal(typeof item.hardIssueAllowed, 'boolean', item.checkId);
    assert.equal(typeof item.detailHandlerExpected, 'boolean', item.checkId);
  }

  assert.equal(getLegitCheckExpectation('geo.ai_bots_policy_summary').hardIssueAllowed, false);
  assert.equal(getLegitCheckExpectation('tech.hsts_header').allowedFindingTypes.includes('best_practice'), true);
  assert.deepEqual(getLegitCheckExpectation('tech.product_coverage_on_product_like_pages').pageTypeScope, ['product']);
  assert.deepEqual(getLegitCheckExpectation('tech.article_coverage_on_article_like_pages').pageTypeScope, ['article']);
});

test('clean fixture audit avoids false positives in core SEO families', async () => {
  const { db, runId, origin } = await runFixtureAudit('clean', {}, { maxUrls: 6, maxDepth: 2 });
  const results = allResults(db, runId);
  assertExpectationCompliance(results);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE runId = ?').get(runId).count, 3);
  for (const checkId of [
    'tech.title_missing',
    'tech.title_too_short',
    'tech.title_too_long',
    'tech.meta_description_missing',
    'tech.meta_description_too_short',
    'tech.meta_description_too_long',
    'tech.canonical_missing',
    'tech.canonical_non_self',
    'tech.canonical_target_non_200',
    'tech.h1_missing',
    'tech.multiple_h1'
  ]) {
    assert.equal(result(results, checkId).status, 'OK', checkId);
    assert.equal(result(results, checkId).affectedCount, 0, checkId);
    assert.equal(result(results, checkId).displayReviewStatus, 'not_required', checkId);
  }
  assert.equal(result(results, 'tech.noindex_pages').status, 'NA');
  assert.equal(result(results, 'tech.noindex_pages').evaluationState, 'not_applicable');
  assert.equal(result(results, 'tech.noindex_pages').scoreEligible, false);

  assert.equal(result(results, 'tech.article_coverage_on_article_like_pages').status, 'OK');
  assert.equal(result(results, 'tech.product_coverage_on_product_like_pages').status, 'NA');
  assert.equal(result(results, 'tech.localbusiness_present_missing').status, 'NA');
  assert.equal(result(results, 'tech.content_security_policy').normalizedFindingType, 'best_practice');
  assert.notEqual(result(results, 'tech.content_security_policy').reportSection, 'action_items');
  assert.equal(page(db, runId, `${origin}/article/guide`).pageType, 'article');
  assert.equal(page(db, runId, `${origin}/category/tools`).pageType, 'category');
});

test('SEO issue fixture triggers exact URL counts, details, CSV and full exports', async () => {
  const { db, runId, origin } = await runFixtureAudit('seo', {}, { maxUrls: 30, maxDepth: 2 });
  const results = allResults(db, runId);
  assertExpectationCompliance(results);

  assertCheck(results, 'tech.title_missing', 'Error', 1, [`${origin}/missing-title`]);
  assertCheck(results, 'tech.title_too_short', 'Warning', 1, [`${origin}/short-title`]);
  assertCheck(results, 'tech.title_too_long', 'Warning', 1, [`${origin}/long-title`]);
  assertCheck(results, 'tech.meta_description_missing', 'Warning', 1, [`${origin}/missing-description`]);
  assertCheck(results, 'tech.meta_description_too_short', 'Warning', 1, [`${origin}/short-description`]);
  assertCheck(results, 'tech.meta_description_too_long', 'Warning', 1, [`${origin}/long-description`]);
  assertCheck(results, 'tech.h1_missing', 'Error', 1, [`${origin}/missing-h1`]);
  assertCheck(results, 'tech.multiple_h1', 'Warning', 1, [`${origin}/multi-h1`]);
  assertCheck(results, 'tech.canonical_to_other_domain', 'Warning', 1, [`${origin}/canonical-external`]);
  assertCheck(results, 'tech.canonical_target_non_200', 'Warning', 1, [`${origin}/canonical-404`]);
  assertCheck(results, 'tech.noindex_pages', 'NA', 0, []);
  assertCheck(results, 'tech.4xx_pages', 'Warning', 1, [`${origin}/not-found`]);
  assertCheck(results, 'tech.internal_links_to_4xx_5xx', 'Error', 1, [`${origin}/broken-link-source`]);
  assertCheck(results, 'tech.redirect_pages', 'Warning', 1, [`${origin}/redirect-me`]);

  const noindexEvidence = result(results, 'tech.noindex_pages').evidence;
  assert.equal(noindexEvidence.contentNoindexCount, 1);
  assert.equal(noindexEvidence.legalNoindexCount, 1);
  assert.equal(noindexEvidence.sampleUrls.includes(`${origin}/content-noindex`), true);
  assert.equal(noindexEvidence.sampleUrls.includes(`${origin}/legal-noindex`), false);
  assert.equal(result(results, 'tech.noindex_pages').scoreEligible, false);

  const titleDetail = detail(db, runId, 'tech.title_too_short');
  assert.deepEqual(detailKeys(titleDetail), ['url', 'title', 'titleLength', 'statusCode', 'pageType', 'indexable', 'recommendation', 'displayReviewStatus', 'displayActionStatus']);
  assert.equal(titleDetail.rows[0].url, `${origin}/short-title`);
  assert.equal(titleDetail.rows[0].title, 'Short');
  assert.equal(Number(titleDetail.rows[0].titleLength), 5);

  const canonicalDetail = detail(db, runId, 'tech.canonical_target_non_200');
  assert.equal(canonicalDetail.rows[0].url, `${origin}/canonical-404`);
  assert.equal(canonicalDetail.rows[0].canonical, `${origin}/not-found`);
  assert.equal(Number(canonicalDetail.rows[0].canonicalTargetStatus), 404);

  const linkDetail = detail(db, runId, 'tech.internal_links_to_4xx_5xx');
  assert.equal(linkDetail.rows[0].sourceUrl, `${origin}/broken-link-source`);
  assert.equal(linkDetail.rows[0].targetUrl, `${origin}/not-found`);
  assert.equal(linkDetail.rows[0].anchorText, 'Broken target');

  const csv = collectCheckDetailCsv(db, runId, idFor(results, 'tech.title_too_short')).csv;
  assert.match(csv, /URL,Title,Title Length/);
  assert.match(csv, new RegExp(escapeRegex(`${origin}/short-title`)));
  assert.doesNotMatch(csv, new RegExp(escapeRegex(`${origin}/missing-title`)));

  const fullJson = JSON.parse(collectFullAuditJson(db, runId, ['findings', 'pages', 'links']).body);
  assert.ok(fullJson.checkDetails.some((item) => item.checkId === 'tech.title_too_short' && item.rows.some((row) => row.url === `${origin}/short-title`)));
  assert.ok(fullJson.links.some((row) => row.sourceUrl === `${origin}/broken-link-source` && row.targetUrl === `${origin}/not-found`));

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings', 'pages', 'links']).buffer);
  assert.match(zipEntries[`checks/audit-${runId}-tech.title_too_short.csv`], new RegExp(escapeRegex(`${origin}/short-title`)));
  assert.ok(zipEntries['data/check-details.json'].includes('tech.internal_links_to_4xx_5xx'));
  assert.doesNotThrow(() => JSON.parse(zipEntries['export-warnings.json']));
});

test('media fixture ignores decorative images and exports usable image detail rows', async () => {
  const { db, runId, origin } = await runFixtureAudit('media', {}, { maxUrls: 3, maxDepth: 1 });
  const results = allResults(db, runId);
  assertExpectationCompliance(results);

  assertCheck(results, 'tech.images_without_alt', 'Warning', 1, [`${origin}/`]);
  assertCheck(results, 'tech.empty_alt_texts', 'Warning', 1, [`${origin}/`]);
  assertCheck(results, 'tech.images_without_width_height', 'Warning', 1, [`${origin}/`]);
  assertCheck(results, 'tech.images_without_lazy_loading', 'Warning', 1, [`${origin}/`]);

  const altRows = detail(db, runId, 'tech.images_without_alt').rows;
  assert.deepEqual(altRows.map((row) => row.imageUrl), [`${origin}/assets/content-no-alt.jpg`]);
  assert.equal(altRows.some((row) => /decorative-divider|trust-badge|icon-search|pixel/.test(row.imageUrl)), false);

  const dimensionRows = detail(db, runId, 'tech.images_without_width_height').rows;
  assert.deepEqual(dimensionRows.map((row) => row.imageUrl), [`${origin}/assets/no-dimensions.jpg`]);
  assert.equal(dimensionRows[0].imageRole, 'content');

  const lazyRows = detail(db, runId, 'tech.images_without_lazy_loading').rows;
  assert.deepEqual(lazyRows.map((row) => row.imageUrl), [`${origin}/assets/eager-content.jpg`]);
  assert.equal(lazyRows[0].loading, '');

  const csv = collectCheckDetailCsv(db, runId, idFor(results, 'tech.images_without_width_height')).csv;
  assert.match(csv, /Page URL,Image URL,Alt,Alt Attribute Present,Trimmed Alt Value,Image Role,Width Attribute,Height Attribute,Loading Attribute/);
  assert.match(csv, /no-dimensions\.jpg/);
  assert.doesNotMatch(csv, /trust-badge\.png/);
});

test('structured-data fixture scopes schema checks by page type and FAQ strength', async () => {
  const { db, runId, origin } = await runFixtureAudit('schema', {}, { maxUrls: 30, maxDepth: 2 });
  const results = allResults(db, runId);
  assertExpectationCompliance(results);

  assertCheck(results, 'tech.article_coverage_on_article_like_pages', 'Warning', 1, [`${origin}/blog/article-without-schema`]);
  assertCheck(results, 'tech.product_coverage_on_product_like_pages', 'Warning', 1, [`${origin}/produkt/widget-without-schema`]);
  assert.equal(result(results, 'tech.localbusiness_present_missing').status, 'OK');
  assertCheck(results, 'tech.json_ld_parse_errors', 'Error', 1, [`${origin}/invalid-jsonld`]);
  assertCheck(results, 'tech.breadcrumb_missing_low_coverage', 'Warning', 1, [`${origin}/category/missing-breadcrumb`]);
  assertCheck(results, 'tech.faqpage_missing_low_coverage', 'Warning', 1, [`${origin}/faq-strong`]);
  assertCheck(results, 'geo.faq_html_present_schema_missing', 'Warning', 1, [`${origin}/faq-strong`]);

  const articleUrls = detail(db, runId, 'tech.article_coverage_on_article_like_pages').rows.map((row) => row.url);
  assert.equal(articleUrls.includes(`${origin}/blog/article-without-schema`), true);
  assert.equal(articleUrls.includes(`${origin}/blog`), false);

  const productUrls = detail(db, runId, 'tech.product_coverage_on_product_like_pages').rows.map((row) => row.url);
  assert.equal(productUrls.includes(`${origin}/produkt/widget-without-schema`), true);
  assert.equal(productUrls.includes(`${origin}/beratung/produktberatung`), false);

  const faqUrls = detail(db, runId, 'tech.faqpage_missing_low_coverage').rows.map((row) => row.url);
  assert.equal(faqUrls.includes(`${origin}/faq-strong`), true);
  assert.equal(faqUrls.includes(`${origin}/faq-weak`), false);
  assert.equal(page(db, runId, `${origin}/faq-weak`).hasFaqPattern, 0);
  assert.equal(JSON.parse(page(db, runId, `${origin}/faq-weak`).featureFlagsJson).hasWeakFaqPattern, true);

  const parseDetail = detail(db, runId, 'tech.json_ld_parse_errors');
  assert.equal(parseDetail.rows[0].url, `${origin}/invalid-jsonld`);
  assert.equal(parseDetail.rows[0].parseStatus, 'error');
});

test('GEO fixture treats AI bot policy, llms files and trust links as opportunities with evidence', async () => {
  const missing = await runFixtureAudit('geo', { llmsFullStatus: 404, trustLinks: false }, { maxUrls: 12, maxDepth: 2 });
  const missingResults = allResults(missing.db, missing.runId);
  assertExpectationCompliance(missingResults);

  const gptbot = result(missingResults, 'geo.robots_mentions_gptbot');
  assert.equal(gptbot.status, 'NA');
  assert.equal(gptbot.evaluationState, 'not_applicable');
  assert.equal(gptbot.scoreEligible, false);
  assert.equal(gptbot.priority, 'Low');
  assert.equal(gptbot.normalizedFindingType, 'info');
  assert.notEqual(gptbot.reportSection, 'action_items');
  assert.equal(gptbot.evidence.botName, 'GPTBot');
  assert.equal(gptbot.evidence.policy.mentioned, false);

  assert.equal(result(missingResults, 'geo.ai_bots_policy_summary').status, 'OK');
  assert.equal(result(missingResults, 'geo.ai_bots_policy_summary').normalizedFindingType, 'info');
  assert.equal(result(missingResults, 'geo.llms_txt_present').status, 'OK');
  assert.equal(result(missingResults, 'geo.llms_full_txt_present').status, 'NA');
  assert.equal(result(missingResults, 'geo.llms_full_txt_present').evaluationState, 'not_applicable');
  assert.equal(result(missingResults, 'geo.markdown_twin_homepage').status, 'OK');
  assert.equal(result(missingResults, 'geo.about_linked').status, 'Warning');
  assert.equal(result(missingResults, 'geo.contact_linked').status, 'Warning');

  const botDetail = detail(missing.db, missing.runId, 'geo.ai_bots_policy_summary');
  assert.ok(botDetail.rows.some((row) => row.botName === 'GPTBot' && row.mentioned === false));
  assert.ok(detailKeys(botDetail).includes('botName'));

  const explicit = await runFixtureAudit('geo', {
    explicitBots: true,
    referenceFull: true,
    llmsFullStatus: 500,
    trustLinks: true
  }, { maxUrls: 12, maxDepth: 2 });
  const explicitResults = allResults(explicit.db, explicit.runId);
  assertExpectationCompliance(explicitResults);

  for (const checkId of [
    'geo.robots_mentions_gptbot',
    'geo.robots_mentions_oai_searchbot',
    'geo.robots_mentions_claudebot',
    'geo.robots_mentions_perplexitybot',
    'geo.robots_mentions_google_extended'
  ]) {
    assert.equal(result(explicitResults, checkId).status, 'OK', checkId);
  }
  const full = result(explicitResults, 'geo.llms_full_txt_present');
  assert.equal(full.status, 'Warning');
  assert.equal(full.priority, 'Low');
  assert.equal(full.normalizedFindingType, 'opportunity');
  assert.equal(full.displayReviewRecommended, 1);
  assert.equal(full.evidence.references.length > 0, true);
  assert.equal(result(explicitResults, 'geo.about_linked').status, 'OK');
  assert.equal(result(explicitResults, 'geo.contact_linked').status, 'OK');

  const llmsDetail = detail(explicit.db, explicit.runId, 'geo.llms_full_txt_present');
  assert.ok(llmsDetail.rows.some((row) => row.fileUrl === `${explicit.origin}/llms-full.txt` && Number(row.statusCode) === 500));
  const llmsCsv = collectCheckDetailCsv(explicit.db, explicit.runId, idFor(explicitResults, 'geo.llms_full_txt_present')).csv;
  assert.match(llmsCsv, /File URL,Status Code,Bytes,Referenced/);
  assert.match(llmsCsv, /llms-full\.txt/);
});

test('rendering fixture captures Playwright data when available and keeps unavailable tooling informational', async () => {
  const { db, runId, origin } = await runFixtureAudit('rendering', {}, {
    maxUrls: 4,
    maxDepth: 1,
    usePlaywright: true,
    playwrightMode: 'all',
    playwrightTimeoutMs: 10000,
    enableTemplateSampling: true,
    enablePlaywrightSampling: true,
    enableLighthouseSampling: false,
    maxTemplateSamplesTotal: 2,
    sampleUrlsPerTemplate: 1
  });
  const results = allResults(db, runId);
  assertExpectationCompliance(results);

  const playwrightRows = db.prepare('SELECT * FROM playwright_results WHERE runId = ? ORDER BY id ASC').all(runId);
  const unavailable = result(results, 'template.playwright_unavailable');
  if (playwrightRows.some((row) => row.status === 'success')) {
    assert.ok(playwrightRows.some((row) => row.url === `${origin}/js-content` && row.consoleErrorsCount > 0));
    assert.equal(result(results, 'tech.console_errors_present').status, 'Warning');
    assert.ok(['OK', 'Warning'].includes(result(results, 'template.console_errors').status));
  } else {
    assert.equal(unavailable.status, 'NA');
    assert.equal(unavailable.normalizedFindingType, 'info');
    assert.notEqual(unavailable.reportSection, 'action_items');
  }

  const lighthouseUnavailable = result(results, 'template.lighthouse_unavailable');
  assert.ok(['OK', 'NA'].includes(lighthouseUnavailable.status));
  assert.equal(lighthouseUnavailable.normalizedFindingType, 'info');
  assert.notEqual(lighthouseUnavailable.reportSection, 'action_items');
});

test('seeded status, TTFB and security cases provide detail rows for non-crawlable edge cases', async () => {
  const db = setupDb();
  const runId = createSeedRun(db);
  insertSeedPage(db, runId, 'https://fixture.local/source', { internalLinksCount: 2 });
  insertSeedPage(db, runId, 'https://fixture.local/slow', {
    ttfbMs: thresholds.highTtfbMs + 200,
    loadTimeMs: thresholds.highTtfbMs + 250,
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/html; charset=utf-8' })
  });
  insertSeedPage(db, runId, 'https://fixture.local/server-error', { statusCode: 500 });
  insertSeedPage(db, runId, 'https://fixture.local/redirect', {
    statusCode: 200,
    initialStatusCode: 302,
    finalUrl: 'https://fixture.local/target',
    redirectChainJson: JSON.stringify([
      { url: 'https://fixture.local/redirect', statusCode: 302, location: 'https://fixture.local/target' },
      { url: 'https://fixture.local/target', statusCode: 200, location: null }
    ])
  });
  insertSeedPage(db, runId, 'https://fixture.local/target');
  const insertTiming = db.prepare(`
    INSERT INTO http_timing_measurements (
      runId, url, attempt, warmup, ttfbMs, measurementMode, location
    ) VALUES (?, ?, ?, 0, ?, 'GET', 'local-fixture')
  `);
  for (const [attempt, ttfbMs] of [
    [1, thresholds.highTtfbMs + 180],
    [2, thresholds.highTtfbMs + 200],
    [3, thresholds.highTtfbMs + 220]
  ]) {
    insertTiming.run(runId, 'https://fixture.local/slow', attempt, ttfbMs);
  }
  replacePageArtifacts(db, runId, 'https://fixture.local/source', {
    links: [
      link('https://fixture.local/source', 'https://fixture.local/server-error', 'Server error target'),
      link('https://fixture.local/source', 'https://fixture.local/redirect', 'Redirect target')
    ]
  });

  await runChecks(db, runId);
  const results = allResults(db, runId);
  assertExpectationCompliance(results);
  assertCheck(results, 'tech.high_ttfb', 'Warning', 1, ['https://fixture.local/slow']);
  assertCheck(results, 'tech.5xx_pages', 'Error', 1, ['https://fixture.local/server-error']);
  assertCheck(results, 'tech.internal_links_to_4xx_5xx', 'Error', 1, ['https://fixture.local/source']);
  assertCheck(results, 'tech.internal_links_to_3xx', 'Warning', 1, ['https://fixture.local/source']);
  assertCheck(results, 'tech.redirect_pages', 'Warning', 1, ['https://fixture.local/redirect']);

  assert.equal(detail(db, runId, 'tech.high_ttfb').rows[0].ttfbMs, thresholds.highTtfbMs + 200);
  assert.equal(detail(db, runId, 'tech.content_security_policy').rows[0].missingHeader, 'content-security-policy');
  assert.equal(detail(db, runId, 'tech.5xx_pages').rows[0].statusCode, 500);
  assert.equal(detail(db, runId, 'tech.internal_links_to_3xx').rows[0].initialStatusCode, 302);
  assert.equal(detail(db, runId, 'tech.internal_links_to_3xx').rows[0].finalStatusCode, 200);
  db.close();
});

async function runFixtureAudit(kind, options = {}, overrides = {}) {
  const site = await startFixtureSite(kind, options);
  const db = getDb();
  resetInterruptedWork(db);
  try {
    const { runId } = await startAudit({
      domain: site.domain,
      brandName: `${kind} Fixture`,
      auditType: 'both',
      maxUrls: 20,
      maxDepth: 2,
      concurrency: 1,
      crawlDelayMs: 0,
      requestTimeoutMs: 5000,
      respectRobotsTxt: false,
      usePlaywright: false,
      enableTemplateSampling: false,
      enablePlaywrightSampling: false,
      enableLighthouseSampling: false,
      ...overrides
    }, { wait: true });
    const run = db.prepare('SELECT status, errorMessage FROM runs WHERE id = ?').get(runId);
    assert.equal(run.status, 'completed', run.errorMessage || `${kind} fixture audit completed`);
    return { db, runId, origin: site.origin };
  } finally {
    await site.close();
  }
}

function assertExpectationCompliance(results) {
  for (const row of results) {
    const expected = getLegitCheckExpectation(row.checkId);
    if (!expected) continue;
    assert.equal(expected.allowedStatuses.includes(row.status), true, `${row.checkId} status ${row.status}`);
    assert.equal(expected.allowedFindingTypes.includes(row.normalizedFindingType), true, `${row.checkId} findingType ${row.normalizedFindingType}`);
    if (expected.requiresEvidence && ['Warning', 'Error'].includes(row.status)) {
      assert.ok(Object.keys(row.evidence || {}).length > 0, `${row.checkId} warning/error has evidence`);
    }
    if (!expected.hardIssueAllowed && ['Warning', 'Error'].includes(row.status)) {
      assert.notEqual(row.reportSection, 'action_items', `${row.checkId} is not a core action item`);
      assert.notEqual(row.normalizedFindingType, 'core_issue', `${row.checkId} is not normalized as core_issue`);
    }
  }
}

function allResults(db, runId) {
  return loadResultsWithScores(db, runId).results;
}

function result(results, checkId) {
  const row = results.find((item) => item.checkId === checkId);
  assert.ok(row, `${checkId} exists`);
  return row;
}

function assertCheck(results, checkId, status, affectedCount, sampleUrls = null) {
  const row = result(results, checkId);
  assert.equal(row.status, status, `${checkId} status`);
  assert.equal(row.affectedCount, affectedCount, `${checkId} affectedCount`);
  if (sampleUrls) {
    assert.deepEqual([...row.sampleUrls].sort(), [...sampleUrls].sort(), `${checkId} sampleUrls`);
  }
  if (['Warning', 'Error'].includes(status)) {
    assert.ok(Object.keys(row.evidence || {}).length > 0, `${checkId} evidence`);
  }
}

function idFor(results, checkId) {
  return result(results, checkId).id;
}

function detail(db, runId, checkId) {
  const results = allResults(db, runId);
  const output = getCheckDetail(db, runId, idFor(results, checkId));
  assert.ok(output, `${checkId} detail exists`);
  assert.ok(output.rows.length > 0, `${checkId} detail has rows`);
  assert.notEqual(output.rows[0].info, 'No affected rows for this check', `${checkId} has affected detail rows`);
  return output;
}

function detailKeys(output) {
  return output.columns.map((column) => column.key);
}

function page(db, runId, url) {
  const row = db.prepare('SELECT * FROM pages WHERE runId = ? AND normalizedUrl = ?').get(runId, url);
  assert.ok(row, `${url} page exists`);
  return row;
}

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function createSeedRun(db) {
  const projectId = createProject(db, { inputDomain: 'https://fixture.local', brandName: 'Seed Fixture' });
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
    processedUrls: 5,
    successfulUrls: 5,
    startedAt: '2026-06-29T08:00:00.000Z',
    finishedAt: '2026-06-29T08:01:00.000Z'
  });
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'robots', 'https://fixture.local/robots.txt', 200, 'User-agent: *\nAllow: /\nSitemap: https://fixture.local/sitemap.xml', '{}')
  `).run(runId);
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'sitemap', 'https://fixture.local/sitemap.xml', 200, '<?xml version="1.0"?><urlset></urlset>', '{}')
  `).run(runId);
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'llms', 'https://fixture.local/llms.txt', 200, '# llms', '{}')
  `).run(runId);
  db.prepare(`
    INSERT INTO domain_assets (runId, type, url, statusCode, content, responseHeadersJson)
    VALUES (?, 'llms_full', 'https://fixture.local/llms-full.txt', 404, 'not found', '{}')
  `).run(runId);
  return runId;
}

function insertSeedPage(db, runId, url, overrides = {}) {
  const finalUrl = overrides.finalUrl || url;
  const title = overrides.title || `Seed Fixture ${new URL(url).pathname}`;
  const description = overrides.metaDescription || 'A deterministic seeded page for check detail tests.';
  insertPage(db, {
    runId,
    url,
    normalizedUrl: url,
    finalUrl,
    depth: overrides.depth ?? 1,
    sourceUrl: overrides.sourceUrl || null,
    statusCode: overrides.statusCode ?? 200,
    initialStatusCode: overrides.initialStatusCode ?? overrides.statusCode ?? 200,
    redirectChainJson: overrides.redirectChainJson || null,
    contentType: overrides.contentType || 'text/html; charset=utf-8',
    indexable: overrides.indexable ?? 1,
    title,
    titleLength: title.length,
    metaDescription: description,
    metaDescriptionLength: description.length,
    h1Json: JSON.stringify([overrides.h1 || 'Seed Fixture']),
    h1Count: overrides.h1Count ?? 1,
    h2Json: JSON.stringify([]),
    canonical: overrides.canonical || url,
    htmlLang: 'en',
    viewport: 'width=device-width, initial-scale=1',
    metaRobots: overrides.metaRobots || null,
    xRobotsTag: overrides.xRobotsTag || null,
    wordCountRaw: overrides.wordCountRaw ?? 120,
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

function link(sourceUrl, targetUrl, anchorText) {
  return {
    sourceUrl,
    targetUrl,
    normalizedTargetUrl: targetUrl,
    linkType: 'internal',
    anchorText,
    rel: ''
  };
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
