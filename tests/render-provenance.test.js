import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { launchBrowser, renderPage } from '../src/extractors/renderExtractor.js';
import {
  buildEffectiveDocumentState,
  classifySettling,
  createDocumentState,
  normalizeBrowserEvents,
  normalizeSettlingConfig,
  RENDER_PROVENANCE_VERSION,
  SETTLING_POLICY_VERSION
} from '../src/extractors/documentState.js';
import { extractHtml } from '../src/extractors/htmlExtractor.js';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, getRunWithProject, insertCheckResults } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { techChecks } from '../src/checks/tech/index.js';
import { metadataProvenanceIsComplete, withRenderSlot } from '../src/crawler/pageProcessor.js';
import { collectCsvExport } from '../src/reports/csvExporter.js';
import { collectFullAuditJson } from '../src/results/checkExportService.js';
import { getCheckDetail } from '../src/results/checkDetailService.js';

test('document states preserve raw, initial, settled and field-level effective provenance', () => {
  const raw = state({ title: null, visibleText: 'shell', mainText: '', h1: [] }, 'raw_html', 'raw');
  const initial = state({ title: 'Loading', visibleText: 'loading', mainText: '', h1: [] }, 'initial_rendered_dom', 'initial');
  const settled = state({ title: 'Pool explorer', metaDescription: 'Rendered description', canonical: '/explore/pools', htmlLang: 'en-US', visibleText: 'Pool explorer rendered main content '.repeat(20), mainText: 'Pool explorer rendered main content '.repeat(20), h1: ['Pool explorer'] }, 'settling_rendered_dom', 'settled');
  const effective = buildEffectiveDocumentState(raw, initial, settled, { renderStatus: 'success', settlingStatus: 'settled' });
  assert.equal(effective.effectiveSource, 'settled_rendered_dom');
  assert.equal(effective.fields.title.raw, null);
  assert.equal(effective.fields.title.initial, 'Loading');
  assert.equal(effective.fields.title.effective, 'Pool explorer');
  assert.equal(effective.fields.title.changedAfterInitial, true);
  assert.equal(effective.changeDetected, true);
  const scoped = createDocumentState({ links: ['/inside', 'https://external.invalid/outside'] }, {
    url: 'https://example.invalid/page',
    finalDomain: 'example.invalid',
    source: 'raw_html'
  });
  assert.deepEqual(scoped.internalLinks, ['https://example.invalid/inside']);
});

test('settling is bounded, requires minimum observation and distinguishes stable, empty and unstable states', () => {
  const config = normalizeSettlingConfig({ maxDurationMs: 2000, intervalMs: 200, maxSnapshots: 10, stableSnapshots: 3, minimumObservationMs: 600 });
  const bounded = normalizeSettlingConfig({ maxDurationMs: 1000, intervalMs: 500, maxSnapshots: 50, stableSnapshots: 10, minimumObservationMs: 9000 });
  assert.deepEqual(bounded, { maxDurationMs: 1000, intervalMs: 500, maxSnapshots: 3, stableSnapshots: 3, minimumObservationMs: 1000 });
  const a = state({ title: 'A', visibleText: 'ready', mainText: 'ready' }, 'render', '1');
  const b = state({ title: 'A', visibleText: 'ready', mainText: 'ready' }, 'render', '2');
  const c = state({ title: 'A', visibleText: 'ready', mainText: 'ready' }, 'render', '3');
  assert.equal(classifySettling([a, b, c], config, 400).status, 'settling_timeout');
  assert.equal(classifySettling([a, b, c], config, 800).status, 'settled');
  const empty = state({ title: 'Shell', visibleText: '', mainText: '' }, 'render', 'empty');
  assert.equal(classifySettling([empty, empty, empty], config, 800).status, 'content_remained_empty');
  const loading = state({ title: 'Shell', visibleText: 'ready', mainText: 'ready', loadingIndicators: 1 }, 'render', 'loading');
  assert.equal(classifySettling([loading, loading, loading], config, 800).stable, false);
  const changing = [
    state({ title: 'A', mainText: 'one' }, 'render', 'a'),
    state({ title: 'B', mainText: 'two' }, 'render', 'b'),
    state({ title: 'C', mainText: 'three' }, 'render', 'c')
  ];
  assert.equal(classifySettling(changing, config, 2000).status, 'rendering_unstable');
});

test('browser events are phase-aware, normalized, deduplicated and impact-separated', () => {
  const events = normalizeBrowserEvents([
    { type: 'console_error', phase: 'settling', message: 'Widget 550e8400-e29b-41d4-a716-446655440000 failed at app.js:12:4', observedAt: '2026-01-01T00:00:00Z' },
    { type: 'console_error', phase: 'settling', message: 'Widget 8163f832-9aa7-4daa-91df-076bafaf201e failed at app.js:99:8', observedAt: '2026-01-01T00:00:01Z' },
    { type: 'pageerror', phase: 'initial_snapshot', message: 'hydrate failed' },
    { type: 'request_failed', phase: 'settling', message: 'critical API failed' }
  ], state({ visibleText: '', mainText: '' }, 'render', 'final'));
  assert.equal(events.find((event) => event.type === 'console_error').count, 2);
  assert.equal(events.find((event) => event.type === 'console_error').impact, 'diagnostic');
  assert.equal(events.find((event) => event.type === 'pageerror').impact, 'content_unavailable');
  assert.equal(events.find((event) => event.type === 'request_failed').impact, 'content_unavailable');
});

test('raw extractor records normalized metadata and content provenance without full response persistence', () => {
  const extracted = extractHtml(`<!doctype html><html lang="DE-de"><head>
    <title> Raw title </title><meta name="description" content=" Raw description ">
    <meta name="robots" content="index, follow"><link rel="canonical" href="/a">
    <link rel="alternate" hreflang="en" href="/en/a"><meta property="og:title" content="OG">
    <meta name="twitter:card" content="summary"><script type="application/ld+json">{"@type":"Article"}</script>
    </head><body><main><h1>Raw H1</h1><p>Raw visible content.</p><a href="/b">B</a></main></body></html>`, 'https://example.invalid/a', 'example.invalid');
  const state = JSON.parse(extracted.page.rawDocumentStateJson);
  assert.equal(state.title, 'Raw title');
  assert.equal(state.canonical, 'https://example.invalid/a');
  assert.equal(state.htmlLang, 'de-de');
  assert.deepEqual(state.h1, ['Raw H1']);
  assert.deepEqual(state.structuredData.types, ['Article']);
  assert.equal(state.twitter['twitter:card'], 'summary');
  assert.equal(state.normalizationVersion, 'visible_text_v1');
  assert.equal(state.visibleText.text, undefined);
});

test('author, publication date and source signals require visible localized evidence, not script data', () => {
  const positive = extractHtml(`<!doctype html><html><body><article><h1>Research</h1>
    <p class="article-author">Von Ada Beispiel</p><time datetime="2026-07-19">19.07.2026</time>
    <p>Visible article content with an independently cited reference.</p><a href="https://research.invalid/paper">Quelle: Studie</a>
    </article></body></html>`, 'https://example.invalid/research', 'example.invalid');
  assert.equal(positive.page.hasAuthorPattern, 1);
  assert.equal(positive.page.hasVisibleDate, 1);
  assert.equal(positive.page.externalSourceLinksCount, 1);
  const negative = extractHtml(`<!doctype html><html><body><main><h1>Utility</h1><p>No visible attribution.</p></main>
    <script>window.data={author:'Script Author',datePublished:'2026-07-19',source:'https://research.invalid'}</script>
    <script type="application/ld+json">{"@type":"Article","author":"Schema Author","datePublished":"2026-07-19"}</script>
    </body></html>`, 'https://example.invalid/utility', 'example.invalid');
  assert.equal(negative.page.hasAuthorPattern, 0);
  assert.equal(negative.page.hasVisibleDate, 0);
  assert.equal(negative.page.externalSourceLinksCount, 0);
});

test('localized author, date and source fixtures stay within article/main context', () => {
  const authorFixtures = [
    '<article><p class="byline">Von Marc de Boer</p></article>',
    '<main><p class="author">Autor: Marc de Boer</p></main>',
    '<article><a rel="author" href="/autor/marc">Marc de Boer</a></article>',
    '<main><div class="article-byline"><img src="/marc.jpg" alt="Marc de Boer"></div></main>'
  ];
  for (const body of authorFixtures) {
    const extracted = extractHtml(`<!doctype html><html><body>${body}</body></html>`, 'https://example.invalid/article', 'example.invalid');
    assert.equal(extracted.page.hasAuthorPattern, 1, body);
  }

  const dateFixtures = [
    '<article><time>19. Juli 2026</time></article>',
    '<main><p class="article-date">Juli 2026</p></main>',
    '<article><time datetime="2026-07-19">2026-07-19</time></article>'
  ];
  for (const body of dateFixtures) {
    const extracted = extractHtml(`<!doctype html><html><body>${body}</body></html>`, 'https://example.invalid/article', 'example.invalid');
    assert.equal(extracted.page.hasVisibleDate, 1, body);
  }

  const sources = extractHtml(`<!doctype html><html><body><main><article><h1>Research</h1>
    <section class="article-sources"><a href="https://research.invalid/paper">Original study</a></section>
    <ol class="footnotes"><li><a href="https://doi.org/10.1000/test">Literatur</a></li></ol>
  </article></main></body></html>`, 'https://example.invalid/article', 'example.invalid');
  assert.equal(sources.page.externalSourceLinksCount, 2);

  const unrelated = extractHtml(`<!doctype html><html><body><main><article><h1>History</h1><p>The year 2026 is discussed here.</p></article></main>
    <footer><p>Marc de Boer</p><time>19. Juli 2026</time><a href="https://linkedin.com/example">LinkedIn</a></footer>
    <script type="application/ld+json">{"author":"Schema Author","datePublished":"2026-07-19"}</script>
  </body></html>`, 'https://example.invalid/article', 'example.invalid');
  assert.equal(unrelated.page.hasAuthorPattern, 0);
  assert.equal(unrelated.page.hasVisibleDate, 0);
  assert.equal(unrelated.page.externalSourceLinksCount, 0);
});

test('Playwright waits for delayed CSR metadata and main content instead of accepting the first DOM snapshot', { timeout: 20000 }, async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/poll') {
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Loading</title></head><body><div id="root"></div><script>
      setInterval(() => fetch('/poll').catch(() => {}), 120);
      setTimeout(() => {
        document.title='Rendered title';
        document.documentElement.lang='en';
        document.head.insertAdjacentHTML('beforeend','<meta name="description" content="Rendered description"><link rel="canonical" href="/rendered">');
        document.querySelector('#root').innerHTML='<main><h1>Rendered H1</h1><p>${'substantial rendered content '.repeat(25)}</p><a href="/inside">Inside</a></main>';
      }, 700);
    </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  if (!browser) {
    await new Promise((resolve) => server.close(resolve));
    t.skip('Chromium unavailable');
    return;
  }
  try {
    const result = await renderPage(browser, origin, '127.0.0.1', 5000, null, {
      settling: { maxDurationMs: 2200, intervalMs: 200, maxSnapshots: 12, stableSnapshots: 3, minimumObservationMs: 1200 }
    });
    const initial = JSON.parse(result.initialRenderedStateJson);
    const settled = JSON.parse(result.settledRenderedStateJson);
    assert.equal(result.renderStatus, 'success');
    assert.equal(result.settlingStatus, 'settled');
    assert.equal(initial.title, 'Loading');
    assert.equal(initial.mainText.wordCount, 0);
    assert.equal(settled.title, 'Rendered title');
    assert.equal(settled.metaDescription, 'Rendered description');
    assert.equal(settled.canonical, `${origin}/rendered`);
    assert.equal(settled.h1[0], 'Rendered H1');
    assert.ok(settled.mainText.wordCount > 40);
    assert.ok(result.renderSnapshotCount >= 5);
    const provenance = JSON.parse(result.renderProvenanceJson);
    assert.equal(provenance.version, RENDER_PROVENANCE_VERSION);
    assert.equal(provenance.settlingPolicyVersion, SETTLING_POLICY_VERSION);
    assert.equal(provenance.navigationWaitUntil, 'domcontentloaded');
    assert.equal(provenance.requestedUrl, origin);
    assert.equal(provenance.finalUrl, `${origin}/`);
    assert.equal(provenance.contentGrewAfterInitialSnapshot, true);
    assert.equal(provenance.metadataChangedAfterInitialSnapshot, true);
    assert.ok(provenance.settlingOutcomes.includes('content_grew_after_initial_snapshot'));
    assert.ok(provenance.settlingOutcomes.includes('metadata_changed_after_initial_snapshot'));
    assert.ok(provenance.settlingStartedAt);
    assert.ok(provenance.settlingCompletedAt);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('additive migration keeps old databases readable and marks missing historical provenance as absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-render-migration-'));
  const file = path.join(dir, 'old.sqlite');
  let db = new Database(file);
  initDatabase(db);
  for (const column of ['effectiveDocumentStateJson', 'settlingStatus', 'renderProvenanceJson', 'rawDocumentStateJson']) db.exec(`ALTER TABLE pages DROP COLUMN ${column}`);
  for (const column of ['renderSettlingMaxMs', 'renderSettlingIntervalMs']) db.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
  db.close();
  db = new Database(file);
  initDatabase(db);
  const pageColumns = new Set(db.prepare('PRAGMA table_info(pages)').all().map((row) => row.name));
  const runColumns = new Set(db.prepare('PRAGMA table_info(runs)').all().map((row) => row.name));
  assert.ok(pageColumns.has('effectiveDocumentStateJson'));
  assert.ok(pageColumns.has('settlingStatus'));
  assert.ok(runColumns.has('renderSettlingMaxMs'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pages WHERE rawDocumentStateJson IS NOT NULL').get().count, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('metadata and JS checks use settled effective state and fail closed on unstable rendering', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  const projectId = createProject(db, { inputDomain: 'https://checks.invalid' });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run('https://checks.invalid', projectId);
  const config = normalizeAuditConfig({ domain: 'https://checks.invalid', auditType: 'tech', maxUrls: 5, maxDepth: 0, concurrency: 1, usePlaywright: true, playwrightMode: 'all' });
  const runId = createRun(db, projectId, config);
  const rawMissing = state({ title: null, metaDescription: null, canonical: null, htmlLang: null, visibleText: 'shell', mainText: '', h1: [] }, 'raw_html', 'raw');
  const initial = state({ title: 'Loading', visibleText: 'loading', mainText: '', h1: [] }, 'initial_rendered_dom', 'initial');
  const settled = state({ title: 'Effective title', metaDescription: 'Effective description', canonical: 'https://checks.invalid/a', htmlLang: 'en', visibleText: 'Rendered main content '.repeat(80), mainText: 'Rendered main content '.repeat(80), h1: ['Effective H1'] }, 'settling_rendered_dom', 'settled');
  insertProvenancePage(db, runId, 'https://checks.invalid/a', rawMissing, initial, settled, { settlingStatus: 'settled', complete: 1 });
  insertProvenancePage(db, runId, 'https://checks.invalid/b', rawMissing, initial, settled, { settlingStatus: 'settled', complete: 1, canonical: 'https://checks.invalid/b' });
  const run = getRunWithProject(db, runId);
  const context = { db, run, project: run };
  assert.equal(runTech('tech.title_missing', context).status, 'OK');
  assert.equal(runTech('tech.h1_missing', context).status, 'OK');
  const js = runTech('tech.js_dependent_content', context);
  assert.equal(js.status, 'Warning');
  assert.equal(js.affectedCount, 2);
  db.prepare('UPDATE pages SET browserEventsJson=? WHERE runId=?').run(JSON.stringify([
    { type: 'request_failed', phase: 'settling', message: 'optional image failed', impact: 'diagnostic' }
  ]), runId);
  assert.equal(runTech('tech.console_errors_present', context).status, 'OK');
  db.prepare('UPDATE pages SET browserEventsJson=? WHERE runId=? AND url=?').run(JSON.stringify([
    { type: 'console_error', phase: 'settling', message: 'application error', impact: 'diagnostic' }
  ]), runId, 'https://checks.invalid/a');
  const consoleFinding = runTech('tech.console_errors_present', context);
  assert.equal(consoleFinding.status, 'OK');
  assert.equal(consoleFinding.evidence.nonReproducibleConsoleEventsExcluded, 1);
  db.prepare('UPDATE pages SET browserEventsJson=? WHERE runId=? AND url=?').run(JSON.stringify([
    { type: 'console_error', phase: 'settling', message: 'application error', count: 1, impact: 'diagnostic' }
  ]), runId, 'https://checks.invalid/b');
  const reproducibleConsoleFinding = runTech('tech.console_errors_present', context);
  assert.equal(reproducibleConsoleFinding.status, 'Warning');
  assert.equal(reproducibleConsoleFinding.affectedCount, 2);
  assert.deepEqual(reproducibleConsoleFinding.evidence.channels, ['console.error']);
  db.prepare('UPDATE pages SET effectiveTitle=NULL WHERE runId=? AND url=?').run(runId, 'https://checks.invalid/a');
  const removedTitle = runTech('tech.title_missing', context);
  assert.equal(removedTitle.status, 'Error');
  assert.equal(removedTitle.affectedCount, 1);
  insertCheckResults(db, runId, [removedTitle]);
  const checkRow = db.prepare("SELECT id FROM check_results WHERE runId=? AND checkId='tech.title_missing'").get(runId);
  const detail = getCheckDetail(db, runId, checkRow.id);
  assert.equal(detail.rows[0].title, '');
  assert.equal(detail.rows[0].effectiveTitle, '');
  assert.equal(detail.rows[0].settlingStatus, 'settled');
  assert.equal(detail.renderProvenance.available, true);
  assert.equal(detail.renderProvenance.rows[0].settledTitle, 'Effective title');
  assert.equal(detail.renderProvenance.rows[0].effectiveTitle, null);
  const provenanceCsv = collectCsvExport(db, runId, 'render-provenance');
  assert.match(provenanceCsv, /rawDocumentStateJson,initialRenderedStateJson,settledRenderedStateJson,effectiveDocumentStateJson/);
  const exported = JSON.parse(collectFullAuditJson(db, runId, []).body);
  assert.equal(exported.urlInventory[0].renderProvenanceVersion, RENDER_PROVENANCE_VERSION);

  const unstableProject = createProject(db, { inputDomain: 'https://unstable.invalid' });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run('https://unstable.invalid', unstableProject);
  const unstableRunId = createRun(db, unstableProject, normalizeAuditConfig({ domain: 'https://unstable.invalid', auditType: 'tech', maxUrls: 1, maxDepth: 0, concurrency: 1, usePlaywright: true, playwrightMode: 'all' }));
  insertProvenancePage(db, unstableRunId, 'https://unstable.invalid/', rawMissing, initial, settled, { settlingStatus: 'rendering_unstable', complete: 0, renderStatus: 'unstable' });
  const unstableRun = getRunWithProject(db, unstableRunId);
  const missing = runTech('tech.title_missing', { db, run: unstableRun, project: unstableRun });
  assert.equal(missing.evaluationState, 'insufficient_evidence');
  const unstableJs = runTech('tech.js_dependent_content', { db, run: unstableRun, project: unstableRun });
  assert.equal(unstableJs.evaluationState, 'technical_error');
  assert.equal(runTech('tech.canonical_to_other_domain', { db, run: unstableRun, project: unstableRun }).evaluationState, 'insufficient_evidence');
  assert.equal(runTech('tech.canonical_target_non_200', { db, run: unstableRun, project: unstableRun }).evaluationState, 'insufficient_evidence');

  const stableOnlyProject = createProject(db, { inputDomain: 'https://stable-content.invalid' });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run('https://stable-content.invalid', stableOnlyProject);
  const stableOnlyRunId = createRun(db, stableOnlyProject, normalizeAuditConfig({ domain: 'https://stable-content.invalid', auditType: 'tech', maxUrls: 2, maxDepth: 0, concurrency: 1, usePlaywright: true, playwrightMode: 'all' }));
  const rawSubstantial = state({ title: 'Stable', visibleText: 'server rendered content '.repeat(100), mainText: 'server rendered content '.repeat(100), h1: [] }, 'raw_html', 'raw-stable');
  const renderedSubstantial = state({ title: 'Stable', visibleText: 'server rendered content '.repeat(100), mainText: 'server rendered content '.repeat(100), h1: [] }, 'settling_rendered_dom', 'rendered-stable');
  insertProvenancePage(db, stableOnlyRunId, 'https://stable-content.invalid/a', rawSubstantial, rawSubstantial, renderedSubstantial);
  insertProvenancePage(db, stableOnlyRunId, 'https://stable-content.invalid/b', rawSubstantial, rawSubstantial, renderedSubstantial);
  const stableOnlyRun = getRunWithProject(db, stableOnlyRunId);
  assert.equal(runTech('tech.js_dependent_content', { db, run: stableOnlyRun, project: stableOnlyRun }).status, 'OK');

  const emptyRunId = createRun(db, stableOnlyProject, config);
  const emptyState = state({ title: 'Empty application', visibleText: '', mainText: '', h1: [] }, 'settling_rendered_dom', 'empty');
  insertProvenancePage(db, emptyRunId, 'https://stable-content.invalid/empty-a', emptyState, emptyState, emptyState, { settlingStatus: 'content_remained_empty' });
  insertProvenancePage(db, emptyRunId, 'https://stable-content.invalid/empty-b', emptyState, emptyState, emptyState, { settlingStatus: 'content_remained_empty' });
  const emptyRun = getRunWithProject(db, emptyRunId);
  assert.equal(runTech('tech.js_dependent_content', { db, run: emptyRun, project: emptyRun }).evaluationState, 'insufficient_evidence');
  db.close();
});

test('effective metadata handles hydration removal, conflicts and final-state duplicate titles', () => {
  const db = new Database(':memory:');
  initDatabase(db);
  const projectId = createProject(db, { inputDomain: 'https://conflicts.invalid' });
  db.prepare('UPDATE projects SET finalDomain=? WHERE id=?').run('https://conflicts.invalid', projectId);
  const config = normalizeAuditConfig({ domain: 'https://conflicts.invalid', auditType: 'tech', maxUrls: 10, maxDepth: 0, concurrency: 1, usePlaywright: true, playwrightMode: 'all' });
  const runId = createRun(db, projectId, config);
  const rawA = state({ title: 'App shell', canonical: '/removed', htmlLang: 'de', robots: 'index,follow', visibleText: 'raw', h1: ['Raw'] }, 'raw_html', 'raw-a');
  const initialA = state({ title: 'Loading', canonical: '/removed', htmlLang: 'de', robots: 'index,follow', visibleText: 'loading' }, 'initial_rendered_dom', 'initial-a');
  const settledA = state({ title: 'Final A', canonical: null, htmlLang: 'en', robots: 'noindex,follow', visibleText: 'final content', h1: ['Final'] }, 'settling_rendered_dom', 'settled-a');
  insertProvenancePage(db, runId, 'https://conflicts.invalid/a', rawA, initialA, settledA, { canonical: null });
  const rowA = db.prepare('SELECT effectiveDocumentStateJson FROM pages WHERE runId=? AND url=?').get(runId, 'https://conflicts.invalid/a');
  const effectiveA = JSON.parse(rowA.effectiveDocumentStateJson);
  assert.equal(effectiveA.fields.canonical.raw, 'https://example.invalid/removed');
  assert.equal(effectiveA.fields.canonical.settled, null);
  assert.equal(effectiveA.fields.canonical.effective, null);
  assert.equal(effectiveA.fields.canonical.changedAfterInitial, true);
  assert.equal(effectiveA.fields.htmlLang.effective, 'en');
  assert.deepEqual(effectiveA.fields.robots.effective, ['follow', 'noindex']);

  const rawB = state({ title: 'App shell', visibleText: 'raw', h1: ['Raw'] }, 'raw_html', 'raw-b');
  const settledB = state({ title: 'Final B', visibleText: 'final content', h1: ['Final'] }, 'settling_rendered_dom', 'settled-b');
  insertProvenancePage(db, runId, 'https://conflicts.invalid/b', rawB, initialA, settledB);
  const context = { db, run: getRunWithProject(db, runId), project: getRunWithProject(db, runId) };
  assert.equal(runTech('tech.canonical_missing', context).affectedCount, 1);
  assert.equal(runTech('tech.duplicate_titles', context).status, 'OK');

  const runId2 = createRun(db, projectId, config);
  const rawC = state({ title: 'Raw one', visibleText: 'raw', h1: ['Raw'] }, 'raw_html', 'raw-c');
  const rawD = state({ title: 'Raw two', visibleText: 'raw', h1: ['Raw'] }, 'raw_html', 'raw-d');
  const settledSame = state({ title: 'Same final title', visibleText: 'final', h1: ['Final'] }, 'settling_rendered_dom', 'settled-same');
  insertProvenancePage(db, runId2, 'https://conflicts.invalid/c', rawC, initialA, settledSame);
  insertProvenancePage(db, runId2, 'https://conflicts.invalid/d', rawD, initialA, settledSame);
  const context2 = { db, run: getRunWithProject(db, runId2), project: getRunWithProject(db, runId2) };
  const duplicates = runTech('tech.duplicate_titles', context2);
  assert.equal(duplicates.status, 'Warning');
  assert.equal(duplicates.affectedCount, 2);
  db.close();
});

test('per-run rendering concurrency is explicitly bounded', async () => {
  let active = 0;
  let maximum = 0;
  const work = Array.from({ length: 4 }, (_, index) => withRenderSlot(991, 1, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(work), [0, 1, 2, 3]);
  assert.equal(maximum, 1);
});

test('metadata completeness fails closed when all-page rendering was requested but unavailable or unstable', () => {
  const all = { usePlaywright: 1, playwrightMode: 'all' };
  assert.equal(metadataProvenanceIsComplete(all, false, { settlingStatus: 'not_executed' }), false);
  assert.equal(metadataProvenanceIsComplete(all, true, { settlingStatus: 'rendering_unstable' }), false);
  assert.equal(metadataProvenanceIsComplete(all, true, { settlingStatus: 'settled' }), true);
  assert.equal(metadataProvenanceIsComplete({ usePlaywright: 0, playwrightMode: 'off' }, false, { settlingStatus: 'not_executed' }), true);
});

function state(input, source, snapshotId) {
  return createDocumentState(input, { url: 'https://example.invalid/', source, snapshotId, observedAt: '2026-01-01T00:00:00Z' });
}

function runTech(id, context) {
  const check = techChecks().find((item) => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check.run(context);
}

function insertProvenancePage(db, runId, url, raw, initial, settled, options = {}) {
  const canonical = Object.hasOwn(options, 'canonical') ? options.canonical : url;
  if (settled) settled.canonical = canonical;
  const effective = buildEffectiveDocumentState(raw, initial, settled, { renderStatus: options.renderStatus || 'success', settlingStatus: options.settlingStatus || 'settled' });
  const values = Object.fromEntries(Object.entries(effective.fields).map(([key, field]) => [key, field.effective]));
  db.prepare(`INSERT INTO pages (
    runId,url,normalizedUrl,finalUrl,depth,statusCode,initialStatusCode,contentType,indexable,noindex,nofollow,
    title,titleLength,metaDescription,metaDescriptionLength,h1Json,h1Count,h2Json,canonical,htmlLang,
    wordCountRaw,wordCountRendered,rawTextLength,renderedTextLength,visibleTextLength,renderedVisibleTextLength,
    textFactsJson,internalLinksCount,externalLinksCount,schemaTypesJson,imagesCount,imagesWithoutAltCount,
    renderStatus,settlingStatus,renderSnapshotCount,rawDocumentStateJson,initialRenderedStateJson,
    settledRenderedStateJson,effectiveDocumentStateJson,renderProvenanceJson,browserEventsJson,
    renderProvenanceVersion,settlingPolicyVersion,metadataProvenanceComplete,effectiveTitle,
    effectiveMetaDescription,effectiveCanonical,effectiveHtmlLang,effectiveMetaRobots,effectiveH1Json,
    effectiveH1Count,effectiveWordCount,effectiveMainWordCount,effectiveInternalLinksCount,effectiveOgJson,
    effectiveTwitterJson,effectiveHreflangJson,effectiveSchemaTypesJson,pageType,featureFlagsJson,ogJson
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    runId,url,url,url,0,200,200,'text/html',1,0,0,
    raw.title,raw.title?.length || 0,null,0,JSON.stringify(raw.h1),raw.h1.length,'[]',raw.canonical,raw.htmlLang,
    raw.visibleText.wordCount,settled?.visibleText.wordCount ?? null,raw.visibleText.length,settled?.visibleText.length ?? null,raw.visibleText.length,settled?.visibleText.length ?? null,
    JSON.stringify({ normalization_version:'visible_text_v1',visible_text:{length:raw.visibleText.length},rendered_visible_text:settled ? {length:settled.visibleText.length}:null }),0,0,'[]',0,0,
    options.renderStatus || 'success',options.settlingStatus || 'settled',3,JSON.stringify(raw),JSON.stringify(initial),
    JSON.stringify(settled),JSON.stringify(effective),JSON.stringify({version:RENDER_PROVENANCE_VERSION}),JSON.stringify([]),
    RENDER_PROVENANCE_VERSION,SETTLING_POLICY_VERSION,options.complete ?? 1,values.title,
    values.metaDescription,values.canonical,values.htmlLang,Array.isArray(values.robots) ? values.robots.join(', ') : '',JSON.stringify(values.h1 || []),
    (values.h1 || []).length,values.visibleText?.wordCount ?? null,values.mainText?.wordCount ?? null,(values.internalLinks || []).length,JSON.stringify(values.openGraph || {}),JSON.stringify(values.twitter || {}),JSON.stringify(values.hreflang || []),JSON.stringify(values.structuredData?.types || []),'article','{}','{}'
  );
}
