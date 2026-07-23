import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  getRunWithProject,
  insertDomainAsset,
  updateProject
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { fetchTextAsset } from '../src/crawler/sitemap.js';
import { geoChecks } from '../src/checks/geo/index.js';
import { runChecks } from '../src/checks/checkEngine.js';
import {
  AI_ROBOTS_POLICY_VERSION,
  evaluateAiBotPolicy,
  parseRobotsPolicy,
  SUPPORTED_AI_BOTS
} from '../src/utils/robots.js';
import {
  analyzeLlmsTxtContent,
  LLMS_TXT_VALIDATION_VERSION
} from '../src/utils/llmsTxt.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';
import { generateReport } from '../src/reports/reportGenerator.js';

const AI_ROOT = 'ai_crawler_policy.robots_configuration';
const LLMS_ROOT = 'ai_files.llms_txt';

test('versioned robots parser handles groups, comments, case, empty directives and unknown directives', () => {
  const parsed = parseRobotsPolicy([
    '\ufeff# policy',
    'USER-AGENT: GPTBot',
    'User-Agent: OAI-SearchBot',
    'Disallow:',
    'Allow: /',
    'Unknown-Directive: retained',
    'User-agent: GPTBot',
    'Disallow: /private/*',
    'Allow: /private/public$'
  ].join('\n'));

  assert.equal(parsed.version, AI_ROBOTS_POLICY_VERSION);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].userAgents.map((item) => item.value), ['GPTBot', 'OAI-SearchBot']);
  assert.equal(parsed.groups[0].rules[0].operative, false);
  assert.equal(parsed.unknownDirectives[0].name, 'unknown-directive');

  const policy = evaluateAiBotPolicy({
    robotsUrl: 'https://example.test/robots.txt',
    content: [
      'User-agent: GPTBot',
      'Disallow: /private/*',
      'Allow: /private/public$',
      'User-agent: GPTBot',
      'Allow: /'
    ].join('\n'),
    botName: 'gptbot',
    testedPaths: ['/private/file', '/private/public', '/public']
  });
  assert.equal(policy.mentioned, true);
  assert.equal(policy.status, 'blocked');
  assert.deepEqual(policy.pathResults.map((item) => item.allowed), [false, true, true]);
  assert.equal(policy.pathResults[1].winningRule.type, 'allow');

  const discoveryOnly = parseRobotsPolicy('Sitemap: https://example.test/sitemap.xml');
  assert.equal(discoveryOnly.valid, true);
  assert.equal(discoveryOnly.groups.length, 0);
});

test('explicit named group passes, wildcard-only allow is Low and effective blocking is Medium for every supported bot', () => {
  for (const botName of SUPPORTED_AI_BOTS) {
    const explicit = setupRun();
    seedRobots(explicit, 200, `User-agent: ${botName}\nAllow: /`);
    let result = runGeoCheck(explicit, botCheckId(botName));
    assert.equal(result.status, 'OK', botName);
    assert.equal(result.priority, 'Low', botName);
    assert.equal(result.scoreEligible, true, botName);
    assert.equal(result.evidence.policy.explicitAllowComplete, true, botName);
    explicit.db.close();

    const wildcard = setupRun();
    seedRobots(wildcard, 200, 'User-agent: *\nAllow: /');
    result = runGeoCheck(wildcard, botCheckId(botName));
    assert.equal(result.status, 'Warning', botName);
    assert.equal(result.priority, 'Low', botName);
    assert.equal(result.evidence.policy.status, 'implicitly_allowed', botName);
    assert.equal(result.scoreDeduplicationKey, AI_ROOT, botName);
    wildcard.db.close();

    const blocked = setupRun();
    seedRobots(blocked, 200, `User-agent: ${botName}\nDisallow: /`);
    result = runGeoCheck(blocked, botCheckId(botName));
    assert.equal(result.status, 'Warning', botName);
    assert.equal(result.priority, 'Medium', botName);
    assert.ok(result.evidence.policy.blockedPathCount >= 2, botName);
    assert.equal(result.scoreDeduplicationKey, AI_ROOT, botName);
    blocked.db.close();
  }
});

test('an explicit named group without blocking rules is a complete semantic allow', () => {
  const fixture = setupRun();
  seedRobots(fixture, 200, 'User-agent: GPTBot');
  const result = runGeoCheck(fixture, 'geo.robots_mentions_gptbot');
  assert.equal(result.status, 'OK');
  assert.equal(result.evidence.policy.status, 'explicitly_allowed');
  assert.ok(result.evidence.policy.pathResults.every((item) => item.allowed));
  fixture.db.close();
});

test('representative public path selection is deterministic, page-type aware and excludes private paths', () => {
  const fixture = setupRun();
  seedPage(fixture, '/articles/a', 'article');
  seedPage(fixture, '/articles/b', 'article');
  seedPage(fixture, '/products/a', 'product');
  seedPage(fixture, '/login', 'other');
  seedPage(fixture, '/account/profile', 'profile');
  seedRobots(fixture, 200, [
    'User-agent: GPTBot',
    'Allow: /',
    'Disallow: /articles/',
    'Allow: /articles/public'
  ].join('\n'));

  const result = runGeoCheck(fixture, 'geo.robots_mentions_gptbot');
  const paths = result.evidence.policy.pathResults.map((item) => item.path);
  assert.deepEqual(paths, ['/', '/llms.txt', '/articles/a', '/products/a']);
  assert.equal(result.priority, 'Medium');
  assert.equal(result.evidence.policy.pathResults.find((item) => item.path === '/articles/a').allowed, false);
  assert.equal(paths.some((path) => /login|account/.test(path)), false);
  fixture.db.close();
});

test('invalid, unavailable and incomplete robots evidence never produces pass or fail', () => {
  const invalid = setupRun();
  seedRobots(invalid, 200, 'Disallow: /');
  let result = runGeoCheck(invalid, 'geo.robots_mentions_gptbot');
  assert.equal(result.status, 'NA');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  assert.equal(result.scoreEligible, false);
  invalid.db.close();

  const unavailable = setupRun();
  insertDomainAsset(unavailable.db, {
    runId: unavailable.runId,
    type: 'robots',
    url: `${unavailable.domain}/robots.txt`,
    statusCode: null,
    content: null,
    responseHeadersJson: JSON.stringify({ error: 'dns_error' }),
    metadataJson: JSON.stringify({
      logicVersion: 'robots-sitemap-validation-v1',
      measurementState: 'technical_error',
      measurementAttempts: [{ attempt: 1, method: 'GET', networkError: 'dns_error' }]
    })
  });
  result = runGeoCheck(unavailable, 'geo.robots_mentions_gptbot');
  assert.equal(result.status, 'NA');
  assert.equal(result.evaluationState, 'technical_error');
  assert.equal(result.scoreEligible, false);
  unavailable.db.close();

  const historical = setupRun();
  insertDomainAsset(historical.db, {
    runId: historical.runId,
    type: 'robots',
    url: `${historical.domain}/robots.txt`,
    statusCode: 200,
    content: 'User-agent: GPTBot\nAllow: /',
    responseHeadersJson: JSON.stringify({ 'content-type': 'text/plain' }),
    metadataJson: '{}'
  });
  result = runGeoCheck(historical, 'geo.robots_mentions_gptbot');
  assert.equal(result.status, 'NA');
  assert.equal(result.evaluationState, 'insufficient_evidence');
  historical.db.close();
});

test('AI policy summary is diagnostic and never adds a score or root cause', () => {
  const fixture = setupRun();
  seedRobots(fixture, 200, [
    'User-agent: GPTBot',
    'Allow: /',
    'User-agent: ClaudeBot',
    'Disallow: /'
  ].join('\n'));
  const summary = runGeoCheck(fixture, 'geo.ai_bots_policy_summary');
  assert.equal(summary.status, 'OK');
  assert.equal(summary.priority, 'Info');
  assert.equal(summary.findingType, 'info');
  assert.equal(summary.scoreEligible, false);
  assert.equal(summary.scoreDeduplicationKey, null);
  assert.equal(summary.facts.explicitlyAllowed, 1);
  assert.equal(summary.facts.blocked, 1);
  assert.equal(summary.facts.implicitlyAllowed, SUPPORTED_AI_BOTS.length - 2);
  fixture.db.close();
});

test('robots llms access check evaluates only /llms.txt and deduplicates individual bot findings', () => {
  const allowed = setupRun();
  seedRobots(allowed, 200, explicitPolicyForAllBots('Allow: /'));
  let result = runGeoCheck(allowed, 'geo.robots_blocks_txt_files');
  assert.equal(result.status, 'OK');
  allowed.db.close();

  const oneBlocked = setupRun();
  seedRobots(oneBlocked, 200, explicitPolicyForAllBots('Allow: /') + '\nUser-agent: GPTBot\nDisallow: /llms.txt');
  result = runGeoCheck(oneBlocked, 'geo.robots_blocks_txt_files');
  assert.equal(result.status, 'Warning');
  assert.equal(result.priority, 'Medium');
  assert.equal(result.affectedCount, 1);
  assert.equal(result.scoreDeduplicationKey, AI_ROOT);
  oneBlocked.db.close();

  const wildcardBlocked = setupRun();
  seedRobots(wildcardBlocked, 200, 'User-agent: *\nDisallow: /llms.txt');
  result = runGeoCheck(wildcardBlocked, 'geo.robots_blocks_txt_files');
  assert.equal(result.affectedCount, SUPPORTED_AI_BOTS.length);
  wildcardBlocked.db.close();

  const specificAllow = setupRun();
  seedRobots(specificAllow, 200, 'User-agent: *\nDisallow: /\nAllow: /llms.txt$');
  result = runGeoCheck(specificAllow, 'geo.robots_blocks_txt_files');
  assert.equal(result.status, 'OK');
  specificAllow.db.close();

  const fullOnly = setupRun();
  seedRobots(fullOnly, 200, 'User-agent: *\nDisallow: /llms-full.txt');
  result = runGeoCheck(fullOnly, 'geo.robots_blocks_txt_files');
  assert.equal(result.status, 'OK');
  fullOnly.db.close();
});

test('llms.txt checks cover valid content, deterministic failures and score-free availability states', () => {
  const cases = [
    {
      name: 'valid',
      asset: { status: 200, body: '# Example Project\n\n## Documentation\n- [Docs](https://example.test/docs)' },
      expectedStatus: 'OK',
      expectedState: 'pass'
    },
    { name: '404', asset: { status: 404, body: 'missing' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'redirect', asset: { status: 200, initialStatus: 301, redirects: [{ url: 'https://example.test/llms.txt', statusCode: 301, location: 'https://example.test/final.txt' }], finalUrl: 'https://example.test/final.txt', body: '# Example\n\n## Docs\nText' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: '204', asset: { status: 204, body: '' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'confirmed 503', asset: { status: 503, body: 'down', attempts: [503, 503] }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'rate limited', asset: { status: 429, body: 'later', attempts: [429, 429] }, expectedStatus: 'NA', expectedState: 'insufficient_evidence' },
    { name: 'html soft response', asset: { status: 200, body: '<!doctype html><title>Not found</title>', contentType: 'text/html' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'empty', asset: { status: 200, body: '' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'whitespace', asset: { status: 200, body: '   \n' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'wrong content type', asset: { status: 200, body: '# Example\n\n## Docs\nText', contentType: 'application/json' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'missing site designation', asset: { status: 200, body: '# llms.txt\n\n## Docs\nText' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'missing usable section', asset: { status: 200, body: '# Example Project' }, expectedStatus: 'Warning', expectedState: 'fail' },
    { name: 'canonical www target', asset: { status: 200, body: '# Example Project\n\n[Documentation](https://www.example.test/docs)' }, expectedStatus: 'OK', expectedState: 'pass' }
  ];

  for (const item of cases) {
    const fixture = setupRun();
    seedLlms(fixture, item.asset);
    for (const checkId of ['geo.llms_txt_present', 'geo.llms_txt_http_status']) {
      const result = runGeoCheck(fixture, checkId);
      assert.equal(result.status, item.expectedStatus, `${item.name}: ${checkId}`);
      assert.equal(result.evaluationState, item.expectedState, `${item.name}: ${checkId}`);
      assert.equal(result.scoreDeduplicationKey, LLMS_ROOT, `${item.name}: ${checkId}`);
      assert.equal(result.scoreEligible, item.expectedState === 'pass' || item.expectedState === 'fail', `${item.name}: ${checkId}`);
      assert.equal(result.evidence.validationVersion, LLMS_TXT_VALIDATION_VERSION);
      assert.equal('body' in result.evidence, false);
    }
    fixture.db.close();
  }
});

test('llms.txt crawler retries bounded transient states and stores compact evidence without the body', async () => {
  let attempts = 0;
  await withServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('temporary');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('# Fixture Site\n\n## Documentation\n- [Home](__ORIGIN__/)');
  }, async ({ origin }) => {
    const fixture = setupRun(origin);
    await fetchTextAsset(fixture.db, fixture.runId, 'llms', `${origin}/llms.txt`, 2000, { retryDelayMs: 0 });
    const row = fixture.db.prepare("SELECT * FROM domain_assets WHERE runId=? AND type='llms'").get(fixture.runId);
    const metadata = JSON.parse(row.metadataJson);
    assert.equal(attempts, 2);
    assert.equal(row.content, null);
    assert.equal(metadata.measurementAttempts.length, 2);
    assert.equal(metadata.measurementState, 'unstable');
    const result = runGeoCheck(fixture, 'geo.llms_txt_present');
    assert.equal(result.evaluationState, 'insufficient_evidence');
    assert.equal(result.scoreEligible, false);
    fixture.db.close();
  });
});

test('llms.txt never passes when compact attempt provenance is missing', () => {
  const fixture = setupRun();
  seedLlms(fixture, {
    status: 200,
    body: '# Example Project\n\n## Documentation\nText'
  });
  const row = fixture.db.prepare("SELECT metadataJson FROM domain_assets WHERE runId=? AND type='llms'").get(fixture.runId);
  const metadata = JSON.parse(row.metadataJson);
  metadata.measurementAttempts = [];
  metadata.measurementState = 'confirmed';
  fixture.db.prepare("UPDATE domain_assets SET metadataJson=? WHERE runId=? AND type='llms'")
    .run(JSON.stringify(metadata), fixture.runId);

  for (const checkId of ['geo.llms_txt_present', 'geo.llms_txt_http_status']) {
    const result = runGeoCheck(fixture, checkId);
    assert.equal(result.status, 'NA', checkId);
    assert.equal(result.evaluationState, 'insufficient_evidence', checkId);
    assert.equal(result.scoreEligible, false, checkId);
  }
  fixture.db.close();
});

test('robots crawler keeps a failed-first retry sequence unstable and score-free', async () => {
  let attempts = 0;
  await withServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('temporary');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('User-agent: GPTBot\nAllow: /');
  }, async ({ origin }) => {
    const fixture = setupRun(origin);
    await fetchTextAsset(fixture.db, fixture.runId, 'robots', `${origin}/robots.txt`, 2000, { retryDelayMs: 0 });
    const row = fixture.db.prepare("SELECT * FROM domain_assets WHERE runId=? AND type='robots'").get(fixture.runId);
    const metadata = JSON.parse(row.metadataJson);
    assert.equal(attempts, 2);
    assert.equal(metadata.measurementState, 'unstable');
    assert.equal(metadata.measurementAttempts.length, 2);
    const result = runGeoCheck(fixture, 'geo.robots_mentions_gptbot');
    assert.equal(result.status, 'NA');
    assert.equal(result.evaluationState, 'insufficient_evidence');
    assert.equal(result.scoreEligible, false);
    fixture.db.close();
  });
});

test('import-only and historical runs do not invent live robots or llms evidence', async () => {
  const fixture = setupRun('https://example.test', { sourceType: 'screaming_frog_import' });
  seedRobots(fixture, 200, explicitPolicyForAllBots('Allow: /'));
  seedLlms(fixture, { status: 200, body: '# Example\n\n## Docs\nText' });
  await runChecks(fixture.db, fixture.runId);

  for (const checkId of [
    'geo.llms_txt_present',
    'geo.llms_txt_http_status',
    'geo.robots_blocks_txt_files',
    'geo.ai_bots_policy_summary',
    ...SUPPORTED_AI_BOTS.map(botCheckId)
  ]) {
    const row = fixture.db.prepare('SELECT * FROM check_results WHERE runId=? AND checkId=?').get(fixture.runId, checkId);
    assert.equal(row.status, 'NA', checkId);
    assert.equal(row.evaluationState, 'not_executed', checkId);
    assert.equal(row.scoreEligible, 0, checkId);
  }
  fixture.db.close();
});

test('robots and llms metadata remain aligned in database, detail, JSON, CSV, HTML, UI and root-cause output', async () => {
  const fixture = setupRun();
  seedRobots(fixture, 200, 'User-agent: *\nAllow: /');
  seedLlms(fixture, { status: 404, body: 'missing' });
  await runChecks(fixture.db, fixture.runId);

  const gpt = storedResult(fixture, 'geo.robots_mentions_gptbot');
  const summary = storedResult(fixture, 'geo.ai_bots_policy_summary');
  const llms = storedResult(fixture, 'geo.llms_txt_present');
  assert.equal(gpt.priority, 'Low');
  assert.equal(gpt.findingType, 'core_issue');
  assert.equal(gpt.scoreEligible, 1);
  assert.equal(gpt.scoreDeduplicationKey, AI_ROOT);
  assert.equal(gpt.evaluationState, 'fail');
  assert.equal(gpt.coverageStatus, 'covered');
  assert.equal(summary.priority, 'Info');
  assert.equal(summary.scoreEligible, 0);
  assert.equal(llms.scoreDeduplicationKey, LLMS_ROOT);
  assert.equal(llms.evaluationState, 'fail');
  assert.equal(llms.coverageStatus, 'covered');

  const botDetail = getCheckDetail(fixture.db, fixture.runId, gpt.id);
  assert.ok(botDetail.columns.some((column) => column.key === 'testedPath'));
  assert.ok(botDetail.rows.some((row) => row.testedPath === '/llms.txt'));
  const llmsDetail = getCheckDetail(fixture.db, fixture.runId, llms.id);
  assert.ok(llmsDetail.columns.some((column) => column.key === 'initialStatus'));
  assert.equal(llmsDetail.rows[0].validationVersion, LLMS_TXT_VALIDATION_VERSION);

  const json = JSON.parse(collectFullAuditJson(fixture.db, fixture.runId, ['findings', 'root-causes']).body);
  const jsonGpt = json.findings.find((row) => row.checkId === gpt.checkId);
  assert.equal(jsonGpt.scoreDeduplicationKey, AI_ROOT);
  assert.ok(
    json.scores.breakdown.rootCauses.some((root) => root.rootCauseKey === AI_ROOT),
    JSON.stringify(json.scores.breakdown.rootCauses.map((root) => root.rootCauseKey))
  );
  assert.ok(
    json.scores.breakdown.rootCauses.some((root) => root.rootCauseKey === LLMS_ROOT),
    JSON.stringify(json.scores.breakdown.rootCauses.map((root) => root.rootCauseKey))
  );

  const csv = collectCsvExport(fixture.db, fixture.runId, 'findings');
  assert.match(csv, /geo\.robots_mentions_gptbot/);
  assert.match(csv, /ai_crawler_policy\.robots_configuration/);

  const reportPath = generateReport(fixture.db, fixture.runId);
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, /geo\.robots_mentions_gptbot/);
  assert.match(html, /siteDesignation/);
  fs.rmSync(reportPath, { force: true });

  const uiSource = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(uiSource, /rootCauseMemberships/);
  assert.match(uiSource, /coverageUnitKey/);
  fixture.db.close();
});

function setupRun(domain = 'https://example.test', overrides = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const projectId = createProject(db, { inputDomain: domain });
  updateProject(db, projectId, { finalDomain: domain });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain,
    auditType: 'geo',
    maxUrls: 20,
    maxDepth: 1,
    usePlaywright: false,
    enableTemplateSampling: false,
    ...overrides
  }));
  return { db, projectId, runId, domain: new URL(domain).origin };
}

function seedPage(fixture, path, pageType) {
  const url = new URL(path, fixture.domain).toString();
  fixture.db.prepare(`
    INSERT INTO pages (
      runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,
      contentType,indexable,title,h1Json,h1Count,pageType
    )
    VALUES (?,?,?,?,0,200,200,'text/html; charset=utf-8',1,'Fixture','["Fixture"]',1,?)
  `).run(fixture.runId, url, url, url, pageType);
}

function seedRobots(fixture, statusCode, content, overrides = {}) {
  const url = `${fixture.domain}/robots.txt`;
  const finalStatusCode = overrides.finalStatusCode ?? statusCode;
  const attempts = overrides.attempts || [finalStatusCode];
  insertDomainAsset(fixture.db, {
    runId: fixture.runId,
    type: 'robots',
    url,
    statusCode: finalStatusCode,
    content,
    responseHeadersJson: JSON.stringify({ 'content-type': overrides.contentType || 'text/plain; charset=utf-8' }),
    metadataJson: JSON.stringify({
      logicVersion: 'robots-sitemap-validation-v1',
      initialStatusCode: overrides.initialStatusCode ?? statusCode,
      finalStatusCode,
      finalUrl: overrides.finalUrl || url,
      redirectChain: overrides.redirectChain || [],
      contentType: overrides.contentType || 'text/plain; charset=utf-8',
      sizeBytes: Buffer.byteLength(content || ''),
      truncated: Boolean(overrides.truncated),
      measurementState: overrides.measurementState || 'confirmed',
      measurementAttempts: attempts.map((attemptStatus, index) => ({
        attempt: index + 1,
        method: 'GET',
        initialStatusCode: attemptStatus,
        finalStatusCode: attemptStatus,
        finalUrl: url,
        redirectChain: [],
        contentType: 'text/plain; charset=utf-8',
        responseBytes: Buffer.byteLength(content || ''),
        truncated: false
      }))
    })
  });
}

function seedLlms(fixture, {
  status,
  body,
  contentType = 'text/plain; charset=utf-8',
  initialStatus = status,
  finalUrl = `${fixture.domain}/llms.txt`,
  redirects = [],
  attempts = [status],
  truncated = false,
  utf8Valid = true
}) {
  const url = `${fixture.domain}/llms.txt`;
  const analysis = analyzeLlmsTxtContent({
    url,
    body,
    contentType,
    utf8Valid,
    bodyBytes: Buffer.byteLength(body || '')
  });
  const measurementAttempts = attempts.map((attemptStatus, index) => ({
    attempt: index + 1,
    method: 'GET',
    initialStatusCode: index === attempts.length - 1 ? initialStatus : attemptStatus,
    finalStatusCode: attemptStatus,
    finalUrl: index === attempts.length - 1 ? finalUrl : url,
    redirectChain: index === attempts.length - 1 ? redirects : [],
    contentType,
    responseBytes: Buffer.byteLength(body || ''),
    truncated
  }));
  const measurementState = attempts.includes(429)
    ? 'rate_limited'
    : attempts.every((item) => item >= 500 && item <= 599)
      ? (attempts.length >= 2 ? 'confirmed' : 'transient')
      : 'confirmed';
  insertDomainAsset(fixture.db, {
    runId: fixture.runId,
    type: 'llms',
    url,
    statusCode: status,
    content: null,
    responseHeadersJson: JSON.stringify({ 'content-type': contentType }),
    metadataJson: JSON.stringify({
      logicVersion: LLMS_TXT_VALIDATION_VERSION,
      initialStatusCode: initialStatus,
      finalStatusCode: status,
      finalUrl,
      redirectChain: redirects,
      contentType,
      sizeBytes: Buffer.byteLength(body || ''),
      truncated,
      utf8Valid,
      measurementState,
      measurementAttempts,
      llmsTxt: analysis
    })
  });
}

function runGeoCheck(fixture, checkId) {
  const check = geoChecks().find((item) => item.id === checkId);
  assert.ok(check, checkId);
  const run = getRunWithProject(fixture.db, fixture.runId);
  return check.run.call(check, { db: fixture.db, run, project: run });
}

function botCheckId(botName) {
  return `geo.robots_mentions_${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

function explicitPolicyForAllBots(rule) {
  return SUPPORTED_AI_BOTS.map((bot) => `User-agent: ${bot}\n${rule}`).join('\n');
}

function storedResult(fixture, checkId) {
  return fixture.db.prepare('SELECT * FROM check_results WHERE runId=? AND checkId=?').get(fixture.runId, checkId);
}

async function withServer(handler, callback) {
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const originalEnd = response.end.bind(response);
    response.end = (chunk, ...args) => originalEnd(typeof chunk === 'string' ? chunk.replaceAll('__ORIGIN__', origin) : chunk, ...args);
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback({ origin: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
