import crypto from 'node:crypto';
import { countVisibleWords, normalizeVisibleText, textHash, VISIBLE_TEXT_NORMALIZATION_VERSION } from './visibleText.js';
import { isInternalUrl, normalizeUrl } from '../utils/url.js';

export const RENDER_PROVENANCE_VERSION = 'raw-rendered-metadata-v1';
export const SETTLING_POLICY_VERSION = 'bounded-semantic-settling-v1';

export const renderSettlingDefaults = Object.freeze({
  maxDurationMs: 6000,
  intervalMs: 500,
  maxSnapshots: 13,
  stableSnapshots: 3,
  minimumObservationMs: 4000
});

export function normalizeSettlingConfig(input = {}) {
  const maxDurationMs = boundedNumber(input.maxDurationMs, renderSettlingDefaults.maxDurationMs, 1000, 15000);
  const intervalMs = boundedNumber(input.intervalMs, renderSettlingDefaults.intervalMs, 100, 2000);
  const maxByDuration = Math.max(2, Math.floor(maxDurationMs / intervalMs) + 1);
  const maxSnapshots = boundedNumber(input.maxSnapshots, renderSettlingDefaults.maxSnapshots, 2, maxByDuration);
  const stableSnapshots = boundedNumber(input.stableSnapshots, renderSettlingDefaults.stableSnapshots, 2, Math.max(2, maxSnapshots));
  const minimumObservationMs = boundedNumber(
    input.minimumObservationMs,
    renderSettlingDefaults.minimumObservationMs,
    0,
    maxDurationMs
  );
  return { maxDurationMs, intervalMs, maxSnapshots, stableSnapshots, minimumObservationMs };
}

export function createDocumentState(input = {}, context = {}) {
  const visibleText = normalizeVisibleText(input.visibleText || '');
  const mainText = normalizeVisibleText(input.mainText || '');
  const title = normalizeScalar(input.title);
  const metaDescription = normalizeScalar(input.metaDescription);
  const canonical = normalizeAbsoluteUrl(input.canonical, context.url);
  const canonicalValues = normalizeCanonicalValues(input.canonicalValues ?? (canonical ? [canonical] : []), context.url);
  const htmlLang = normalizeLanguage(input.htmlLang);
  const robots = normalizeRobots(input.robots);
  const h1 = normalizeStringArray(input.h1);
  const links = normalizeUrlArray(input.links, context.url)
    .filter((link) => !context.url || isInternalUrl(link, context.finalDomain || context.url));
  const hreflang = normalizeHreflang(input.hreflang, context.url);
  const openGraph = normalizeKeyValue(input.openGraph);
  const twitter = normalizeKeyValue(input.twitter);
  const structuredData = normalizeStructuredData(input.structuredData);
  const documentReadiness = {
    readyState: normalizeScalar(input.readyState),
    loadingIndicators: Math.max(0, Number(input.loadingIndicators || 0)),
    mainContentPresent: Boolean(input.mainContentPresent || mainText)
  };
  const observedAt = context.observedAt || new Date().toISOString();
  const state = {
    title,
    metaDescription,
    canonical,
    canonicalValues,
    htmlLang,
    robots,
    hreflang,
    openGraph,
    twitter,
    h1,
    visibleText: textFact(visibleText),
    mainText: textFact(mainText),
    internalLinks: links,
    structuredData,
    documentReadiness,
    observedAt,
    source: context.source || 'unknown',
    snapshotId: context.snapshotId || null,
    navigationAttempt: Number(context.navigationAttempt || 1),
    normalizationVersion: VISIBLE_TEXT_NORMALIZATION_VERSION
  };
  state.semanticFingerprint = semanticFingerprint(state);
  return state;
}

export function createRawDocumentState(extractedPage = {}, facts = {}, url = null) {
  const rawState = facts.rawDocumentState || {};
  return createDocumentState({
    title: extractedPage.title,
    metaDescription: extractedPage.metaDescription,
    canonical: extractedPage.canonical,
    canonicalValues: rawState.canonicalValues ?? (extractedPage.canonical ? [extractedPage.canonical] : []),
    htmlLang: extractedPage.htmlLang,
    robots: extractedPage.metaRobots,
    hreflang: rawState.hreflang,
    openGraph: safeObject(extractedPage.ogJson),
    twitter: rawState.twitter,
    h1: safeArray(extractedPage.h1Json),
    visibleText: rawState.visibleText,
    mainText: rawState.mainText,
    links: rawState.links,
    structuredData: rawState.structuredData
  }, { url, source: 'raw_html', observedAt: facts.observedAt });
}

export function buildEffectiveDocumentState(raw, initial, settled, render = {}) {
  const hasSettledState = ['settled', 'content_remained_empty'].includes(render.settlingStatus) && settled;
  const effective = hasSettledState ? settled : raw;
  const effectiveSource = hasSettledState ? 'settled_rendered_dom' : 'raw_html';
  const reason = hasSettledState
    ? 'Bounded semantic settling produced a stable rendered snapshot.'
    : render.renderStatus === 'not_executed'
      ? 'Browser rendering was not executed; raw HTML is the available document state.'
      : 'No stable rendered state is available; raw HTML is retained and rendered-dependent checks must gate on availability.';
  const fields = {};
  for (const field of ['title', 'metaDescription', 'canonical', 'canonicalValues', 'htmlLang', 'robots', 'hreflang', 'openGraph', 'twitter', 'h1', 'visibleText', 'mainText', 'internalLinks', 'structuredData']) {
    fields[field] = {
      raw: raw?.[field] ?? null,
      initial: initial?.[field] ?? null,
      settled: settled?.[field] ?? null,
      effective: effective?.[field] ?? null,
      effectiveSource,
      changedAfterInitial: initial && settled ? !deepEqual(initial[field], settled[field]) : false
    };
  }
  return {
    version: RENDER_PROVENANCE_VERSION,
    renderStatus: render.renderStatus || 'not_executed',
    settlingStatus: render.settlingStatus || 'not_executed',
    effectiveSource,
    effectiveReason: reason,
    rawSnapshotId: raw?.snapshotId || null,
    initialSnapshotId: initial?.snapshotId || null,
    settledSnapshotId: settled?.snapshotId || null,
    changeDetected: Boolean(initial && settled && initial.semanticFingerprint !== settled.semanticFingerprint),
    fields
  };
}

export function summarizeSnapshot(input = {}, context = {}) {
  return createDocumentState(input, context);
}

export function semanticFingerprint(state = {}) {
  const payload = {
    title: state.title || null,
    metaDescription: state.metaDescription || null,
    canonical: state.canonical || null,
    canonicalValues: state.canonicalValues || [],
    htmlLang: state.htmlLang || null,
    robots: state.robots || [],
    hreflang: state.hreflang || [],
    openGraph: state.openGraph || {},
    twitter: state.twitter || {},
    h1: state.h1 || [],
    visibleText: semanticTextSignature(state.visibleText, false),
    mainText: semanticTextSignature(state.mainText, true),
    internalLinks: state.internalLinks || [],
    structuredData: state.structuredData || { types: [], validBlocks: 0, invalidBlocks: 0 },
    documentReadiness: {
      readyState: state.documentReadiness?.readyState || null,
      loadingIndicators: Number(state.documentReadiness?.loadingIndicators || 0),
      mainContentPresent: Boolean(state.documentReadiness?.mainContentPresent)
    }
  };
  return hashJson(payload);
}

export function classifySettling(snapshots = [], configInput = {}, elapsedMs = 0) {
  const config = normalizeSettlingConfig(configInput);
  if (!snapshots.length) return { status: 'technical_error', stable: false, stableCount: 0 };
  let stableCount = 1;
  for (let index = snapshots.length - 1; index > 0; index -= 1) {
    if (snapshots[index].semanticFingerprint !== snapshots[index - 1].semanticFingerprint) break;
    stableCount += 1;
  }
  const last = snapshots.at(-1);
  const noActiveLoadingIndicator = Number(last.documentReadiness?.loadingIndicators || 0) === 0;
  const stable = stableCount >= config.stableSnapshots && elapsedMs >= config.minimumObservationMs && noActiveLoadingIndicator;
  if (stable) return {
    status: last.mainText?.wordCount || last.visibleText?.wordCount ? 'settled' : 'content_remained_empty',
    stable: true,
    stableCount
  };
  const changed = snapshots.some((snapshot, index) => index > 0 && snapshot.semanticFingerprint !== snapshots[index - 1].semanticFingerprint);
  return {
    status: changed ? 'rendering_unstable' : 'settling_timeout',
    stable: false,
    stableCount
  };
}

export function normalizeBrowserEvents(events = [], finalState = null) {
  const groups = new Map();
  for (const event of events) {
    const type = String(event.type || 'unknown');
    const phase = String(event.phase || 'unknown');
    const message = normalizeEventMessage(event.message || event.error || event.url || '');
    const key = `${type}\n${phase}\n${message}`;
    const existing = groups.get(key) || {
      type,
      phase,
      message,
      count: 0,
      firstObservedAt: event.observedAt || null,
      lastObservedAt: event.observedAt || null,
      sampleUrl: event.url || null
    };
    existing.count += 1;
    existing.lastObservedAt = event.observedAt || existing.lastObservedAt;
    groups.set(key, existing);
  }
  const contentUnavailable = !finalState?.mainText?.wordCount && !finalState?.visibleText?.wordCount;
  return [...groups.values()].map((event) => ({
    ...event,
    impact: contentUnavailable && ['pageerror', 'navigation_error', 'request_failed', 'response_5xx', 'service_worker_error'].includes(event.type)
      ? 'content_unavailable'
      : event.type === 'csp_violation'
        ? 'security_policy'
        : 'diagnostic'
  }));
}

export function browserDocumentStateEvaluator() {
  const hidden = (element) => {
    if (!(element instanceof Element)) return false;
    if (element.matches('script,style,noscript,template,head,svg,[hidden],[aria-hidden="true"]')) return true;
    const style = window.getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden';
  };
  const visibleText = (root) => {
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,template,head,svg,[hidden],[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        for (let element = parent; element && element !== document.documentElement; element = element.parentElement) {
          if (hidden(element)) return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return parts.join(' ');
  };
  const content = (selector, attribute = 'content') => document.querySelector(selector)?.getAttribute(attribute) || null;
  const metaMap = (prefix, attr) => Object.fromEntries([...document.querySelectorAll(`meta[${attr}^="${prefix}"]`)]
    .map((node) => [node.getAttribute(attr), node.getAttribute('content') || null])
    .filter(([key]) => key));
  const h1 = [...document.querySelectorAll('h1')]
    .filter((node) => {
      for (let element = node; element && element !== document.documentElement; element = element.parentElement) {
        if (hidden(element)) return false;
      }
      return true;
    })
    .map((node) => node.textContent || node.getAttribute('aria-label') || '')
    .filter(Boolean);
  const schemas = [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent || '');
  const loadingIndicators = [...document.querySelectorAll('[aria-busy="true"],[data-loading="true"],.loading,.loader,.spinner')]
    .filter((node) => !hidden(node)).length;
  return {
    title: document.title || null,
    metaDescription: content('meta[name="description" i]'),
    canonical: content('link[rel~="canonical" i]', 'href'),
    canonicalValues: [...document.querySelectorAll('link[rel~="canonical" i]')]
      .map((node) => node.getAttribute('href'))
      .filter(Boolean),
    htmlLang: document.documentElement.getAttribute('lang'),
    robots: content('meta[name="robots" i]'),
    hreflang: [...document.querySelectorAll('link[rel~="alternate" i][hreflang]')].map((node) => ({
      hreflang: node.getAttribute('hreflang'),
      href: node.href || node.getAttribute('href')
    })),
    openGraph: metaMap('og:', 'property'),
    twitter: metaMap('twitter:', 'name'),
    h1,
    visibleText: visibleText(document.body),
    mainText: visibleText(document.querySelector('main,[role="main"],article')),
    links: [...document.querySelectorAll('a[href]')].map((node) => node.href).filter(Boolean),
    structuredData: schemas,
    readyState: document.readyState,
    loadingIndicators,
    mainContentPresent: Boolean(document.querySelector('main,[role="main"],article'))
  };
}

function textFact(value) {
  const normalized = normalizeVisibleText(value);
  return {
    length: normalized.length,
    wordCount: countVisibleWords(normalized),
    hash: textHash(normalized),
    semanticHash: textHash(normalizeDynamicText(normalized)),
    semanticPrefixHash: textHash(normalizeDynamicText(normalized).split(/\s+/).slice(0, 40).join(' '))
  };
}

function semanticTextSignature(fact, mainContent) {
  if (!fact) return null;
  return {
    contentReadinessBand: contentReadinessBand(fact.wordCount),
    semanticHash: mainContent ? (fact.semanticHash || fact.hash || null) : (fact.semanticPrefixHash || fact.semanticHash || fact.hash || null)
  };
}

function contentReadinessBand(value) {
  const count = Number(value || 0);
  if (!count) return 'empty';
  if (count < 50) return 'thin';
  if (count < 100) return 'moderate';
  return 'substantial';
}

function normalizeDynamicText(value) {
  return String(value || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?\b/gi, '<timestamp>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>')
    .replace(/(?<![\p{L}])[-+]?\d[\d.,]*(?:%|€|\$|£|¥)?(?![\p{L}])/gu, '<number>');
}

function normalizeStructuredData(value) {
  const blocks = Array.isArray(value) ? value : [];
  const types = new Set();
  let validBlocks = 0;
  let invalidBlocks = 0;
  for (const block of blocks) {
    try {
      const parsed = typeof block === 'string' ? JSON.parse(block) : block;
      validBlocks += 1;
      collectTypes(parsed, types);
    } catch {
      invalidBlocks += 1;
    }
  }
  return { types: [...types].sort(), validBlocks, invalidBlocks };
}

function collectTypes(value, output) {
  if (Array.isArray(value)) return value.forEach((item) => collectTypes(item, output));
  if (!value || typeof value !== 'object') return;
  const type = value['@type'];
  for (const item of Array.isArray(type) ? type : type ? [type] : []) output.add(String(item));
  for (const nested of Object.values(value)) collectTypes(nested, output);
}

function normalizeScalar(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeLanguage(value) {
  return normalizeScalar(value)?.toLowerCase() || null;
}

function normalizeRobots(value) {
  return [...new Set(String(value || '').toLowerCase().split(/[;,]/).map((item) => item.trim()).filter(Boolean))].sort();
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalizeScalar).filter(Boolean))];
}

function normalizeAbsoluteUrl(value, base) {
  if (!value) return null;
  try {
    return normalizeUrl(new URL(String(value), base || undefined).toString()) || null;
  } catch {
    return null;
  }
}

function normalizeUrlArray(value, base) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => normalizeAbsoluteUrl(item, base)).filter(Boolean))].sort();
}

function normalizeCanonicalValues(value, base) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizeAbsoluteUrl(item, base))
    .filter(Boolean);
}

function normalizeHreflang(value, base) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    hreflang: normalizeLanguage(item?.hreflang),
    href: normalizeAbsoluteUrl(item?.href, base)
  })).filter((item) => item.hreflang && item.href).sort((a, b) => `${a.hreflang}:${a.href}`.localeCompare(`${b.hreflang}:${b.href}`));
}

function normalizeKeyValue(value) {
  const output = {};
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const normalizedKey = String(key).toLowerCase().trim();
    if (normalizedKey) output[normalizedKey] = normalizeScalar(item);
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function safeObject(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; }
}

function safeArray(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : Array.isArray(value) ? value : []; } catch { return []; }
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeEventMessage(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/[?&](?:_?t|timestamp|cache|cb|nonce)=[^&\s]+/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/:\d+:\d+\)?$/g, ':<line>:<column>')
    .slice(0, 1000);
}

function deepEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}
