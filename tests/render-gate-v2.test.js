import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeRenderCheckIdsForAuditType,
  buildDeterministicRenderPlan,
  classifyRenderNeed,
  classifyRenderNeedV1,
  evaluateTemplateRenderEvidence,
  RENDER_CHECK_REQUIREMENTS,
  RENDER_GATE_V2_MODEL,
  RENDER_NEEDS,
  RENDER_PLANNING_VERSION,
  RENDER_PLANNING_VERSIONS,
  resolveRenderCheckRequirements
} from '../src/rendering/renderPlanner.js';
import { createDocumentState } from '../src/extractors/documentState.js';

test('v2 preserves hard app-shell signals and necessary metadata rendering', () => {
  for (const candidate of [
    fixture({ pageType: 'homepage', words: 0, h1: [], links: [], scripts: 1, mainPresent: false }),
    fixture({ pageType: 'article', words: 4, h1: [], links: [], scripts: 1 }),
    fixture({ pageType: 'other', words: 4, h1: [], links: [], scripts: 1 }),
    fixture({ pageType: 'utility', words: 0, h1: [], links: [], scripts: 20, mainPresent: false, metadata: { canonical: null, htmlLang: null } })
  ]) {
    const result = classifyRenderNeed(candidate, candidate);
    assert.notEqual(result.decision, RENDER_NEEDS.notRequired);
    assert.ok(result.checkRequirements.some((item) => item.requirement === 'render_required'));
  }
});

test('v2 does not render complete SSR documents because of scripts or hydration markers', () => {
  const page = fixture({ words: 600, scripts: 40, hydrationBytes: 250000 });
  const result = classifyRenderNeed(page, page);
  assert.equal(result.decision, RENDER_NEEDS.notRequired);
  assert.ok(result.negativeSignals.includes('substantial_main_content'));
  assert.equal(result.signals.includes('framework_marker'), false);
});

test('thin primary SSR evidence stays renderable when a rendered-content check needs proof', () => {
  const risk = fixture({ words: 37, h1: ['Core heading'], links: ['/a', '/b', '/c'], scripts: 20, metadata: { canonical: null } });
  const confirmation = fixture({ url: 'https://x.invalid/confirmation', words: 300, h1: ['Complete'], links: ['/a', '/b', '/c'], scripts: 20 });
  const riskResult = classifyRenderNeed(risk, risk);
  assert.notEqual(riskResult.decision, RENDER_NEEDS.notRequired);
  assert.ok(riskResult.signals.includes('thin_primary_document'));
  const plan = buildDeterministicRenderPlan([
    { ...risk, classification: riskResult, templateClusterKey: 'homepage:/' },
    { ...confirmation, classification: classifyRenderNeed(confirmation, confirmation), templateClusterKey: 'category:/{slug}' }
  ]);
  assert.equal(plan.summary.plannedRenderedUrls, 2);
  assert.deepEqual(plan.checkConfirmations.map((item) => item.url), ['https://x.invalid/confirmation']);
  assert.match(plan.rows.find((row) => row.url.endsWith('/confirmation')).classification.reason, /second deterministic browser measurement/);
});

test('redirect responses cannot satisfy rendered-content minimum measurements', () => {
  const required = fixture({ url: 'https://x.invalid/app', words: 0, h1: [], links: [], scripts: 3, mainPresent: false });
  const redirected = fixture({ url: 'https://x.invalid/redirect', words: 0, h1: [], links: [], scripts: 3, mainPresent: false });
  const confirmation = fixture({ url: 'https://x.invalid/confirmation', words: 300, h1: ['Complete'], links: ['/a', '/b', '/c'], scripts: 3 });
  const pages = [
    { ...required, statusCode: 200, initialStatusCode: 200, contentType: 'text/html', classification: classifyRenderNeed(required, required) },
    { ...redirected, statusCode: 200, initialStatusCode: 302, contentType: 'text/html', classification: classifyRenderNeed(redirected, redirected) },
    { ...confirmation, statusCode: 200, initialStatusCode: 200, contentType: 'text/html', classification: classifyRenderNeed(confirmation, confirmation) }
  ];
  const plan = buildDeterministicRenderPlan(pages);
  assert.equal(plan.summary.plannedRenderedUrls, 3);
  assert.deepEqual(plan.checkConfirmations.map((item) => item.url), ['https://x.invalid/confirmation']);
});

test('concise complete page types and semantic products remain raw-sufficient', () => {
  const candidates = [
    fixture({ pageType: 'legal', words: 25, h1: ['Privacy'], links: ['/legal'] }),
    fixture({ pageType: 'utility', words: 25, h1: ['Contact'], links: ['/contact'] }),
    fixture({ pageType: 'utility', words: 20, h1: ['Tool'], links: ['/tool'] }),
    fixture({ pageType: 'product', words: 80, h1: ['Product'], links: ['/category', '/cart'], schemaTypes: ['Product'] }),
    fixture({ pageType: 'category', words: 80, h1: ['Resources'], links: ['/a', '/b', '/c'] })
  ];
  for (const page of candidates) assert.equal(classifyRenderNeed(page, page).decision, RENDER_NEEDS.notRequired);
});

test('optional metadata alone cannot request rendering but critical gaps need corroboration', () => {
  const descriptionOnly = fixture({ words: 300, metadata: { metaDescription: null }, openGraph: { 'og:title': 'Complete' } });
  const missingSocialImage = fixture({ words: 300, openGraph: { 'og:title': 'Complete' } });
  const criticalCsrGap = fixture({ pageType: 'utility', words: 0, h1: [], links: [], scripts: 10, mainPresent: false, metadata: { canonical: null } });
  assert.equal(classifyRenderNeed(descriptionOnly, descriptionOnly).decision, RENDER_NEEDS.notRequired);
  assert.equal(classifyRenderNeed(missingSocialImage, missingSocialImage).decision, RENDER_NEEDS.notRequired);
  assert.notEqual(classifyRenderNeed(criticalCsrGap, criticalCsrGap).decision, RENDER_NEEDS.notRequired);
  assert.equal(classifyRenderNeedV1(descriptionOnly, descriptionOnly).decision, RENDER_NEEDS.recommended);
});

test('recommendation scoring is explicit, versioned and deterministic', () => {
  const page = fixture({ pageType: 'utility', words: 0, h1: [], links: [], scripts: 5, mainPresent: false, metadata: { canonical: null, htmlLang: null } });
  const first = classifyRenderNeed(page, page);
  const second = classifyRenderNeed({ ...page, url: 'https://another.invalid/no-domain-rule' }, page);
  assert.equal(RENDER_PLANNING_VERSION, RENDER_PLANNING_VERSIONS.v2);
  assert.equal(first.recommendationThreshold, RENDER_GATE_V2_MODEL.recommendationThreshold);
  assert.deepEqual(first.signalContributions, second.signalContributions);
  assert.equal(first.decision, second.decision);
  assert.ok(first.signalContributions.every((item) => ['toward_render', 'against_render'].includes(item.direction)));
});

test('render-sensitive checks are explicit and optional checks never force complete pages', () => {
  assert.ok(RENDER_CHECK_REQUIREMENTS.some((item) => item.checkId === 'tech.js_dependent_content'));
  const complete = resolveRenderCheckRequirements({ hardSignals: [], nearEmpty: false, executableStructure: true, h1Count: 1, internalLinks: 20 });
  assert.ok(complete.every((item) => item.requirement !== 'render_required'));
  const shell = resolveRenderCheckRequirements({ hardSignals: ['raw_app_shell'], nearEmpty: true, executableStructure: true, h1Count: 0, internalLinks: 0 });
  assert.ok(shell.some((item) => item.requirement === 'render_required'));
  assert.deepEqual(activeRenderCheckIdsForAuditType('geo'), []);
  assert.deepEqual(resolveRenderCheckRequirements({}, activeRenderCheckIdsForAuditType('geo')), []);
});

test('template evidence requires two safe confirmations and invalidates collisions', () => {
  const stable = (url) => ({ url, samePageType: true, sameRawStructure: true, renderSucceeded: true, relevantDifference: false, urlSpecificRequiredSignal: false });
  assert.equal(evaluateTemplateRenderEvidence([stable('/one')]).confirmed, false);
  assert.equal(evaluateTemplateRenderEvidence([stable('/one'), stable('/two')]).confirmed, true);
  assert.equal(evaluateTemplateRenderEvidence([stable('/one'), { ...stable('/two'), relevantDifference: true }]).status, 'invalidated');
  assert.equal(evaluateTemplateRenderEvidence([stable('/one'), { ...stable('/two'), sameRawStructure: false }]).status, 'insufficient_evidence');
});

test('v2 render plans remain stable across URL order and repeated facts', () => {
  const pages = ['/b', '/a', '/c'].map((suffix) => {
    const page = fixture({ url: `https://x.invalid${suffix}`, pageType: 'utility', words: 0, h1: [], links: [], scripts: 1, mainPresent: false, metadata: { canonical: null } });
    return { ...page, classification: classifyRenderNeed(page, page), templateClusterKey: 'utility:/{slug}' };
  });
  const options = { maxRenderedUrls: 2, estimatedRenderTimeMs: 5000, estimatedPersistedBytes: 30000 };
  const first = buildDeterministicRenderPlan(pages, options).rows.map(summary);
  const second = buildDeterministicRenderPlan([...pages].reverse(), options).rows.map(summary);
  assert.deepEqual(first, second);
  assert.equal(first.filter((item) => item.browser).length, 2);
});

function fixture({
  url = 'https://x.invalid/page', pageType = 'article', words = 180, h1 = ['Heading'], links = ['/a', '/b', '/c'],
  scripts = 0, hydrationBytes = 0, mainPresent = true, metadata = {}, schemaTypes = [], openGraph = {}
} = {}) {
  const text = Array.from({ length: words }, () => 'word').join(' ');
  const state = createDocumentState({
    title: metadata.title === undefined ? 'Title' : metadata.title,
    metaDescription: metadata.metaDescription === undefined ? 'Description' : metadata.metaDescription,
    canonical: metadata.canonical === undefined ? url : metadata.canonical,
    htmlLang: metadata.htmlLang === undefined ? 'en' : metadata.htmlLang,
    visibleText: text,
    mainText: mainPresent ? text : '',
    h1,
    links,
    openGraph,
    structuredData: { types: schemaTypes, validBlocks: schemaTypes.length, invalidBlocks: 0 },
    mainContentPresent: mainPresent
  }, { url, finalDomain: 'x.invalid', source: 'raw_html' });
  return { url, pageType, indexable: 1, rawDocumentStateJson: JSON.stringify(state), scriptCount: scripts, hydrationBytes };
}

function summary(row) {
  return { url: row.url, decision: row.executionDecision, browser: row.plannedBrowserRun, key: row.priorityKey };
}
