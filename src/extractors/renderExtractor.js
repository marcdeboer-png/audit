import { normalizeUrl, isInternalUrl } from '../utils/url.js';
import { selectedHeaders } from '../utils/http.js';
import {
  browserDocumentStateEvaluator,
  buildEffectiveDocumentState,
  classifySettling,
  createDocumentState,
  normalizeBrowserEvents,
  normalizeSettlingConfig,
  RENDER_PROVENANCE_VERSION,
  SETTLING_POLICY_VERSION
} from './documentState.js';

export async function launchBrowser(log = null) {
  try {
    const { chromium } = await import('@playwright/test');
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (log) log('warning', 'Playwright rendering unavailable; continuing with raw HTML extraction', { error: error.message });
    return null;
  }
}

export async function renderPage(browser, url, finalDomain, timeoutMs = 15000, userAgent = null, options = {}) {
  if (!browser) return emptyRenderResult();

  const config = normalizeSettlingConfig(options.settling);
  const navigationAttempt = Number(options.navigationAttempt || 1);
  const page = await browser.newPage(userAgent ? { userAgent } : undefined);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const cspViolations = [];
  const resources = [];
  const events = [];
  let networkRequestCount = 0;
  let phase = 'pre_navigation';
  let navigationError = null;

  const observe = (type, message, details = {}) => {
    events.push({ type, message: String(message || '').slice(0, 1000), phase, observedAt: new Date().toISOString(), ...details });
  };
  page.on('console', (message) => {
    const value = message.text().slice(0, 1000);
    if (message.type() === 'warning') {
      observe('console_warning', value);
      return;
    }
    if (message.type() !== 'error') return;
    if (/service[\s-]?worker/i.test(value)) {
      observe('service_worker_error', value);
      return;
    }
    if (/content security policy|refused to (load|execute|apply|connect|frame)/i.test(value)) {
      cspViolations.push(value);
      observe('csp_violation', value);
    } else {
      consoleErrors.push(value);
      observe('console_error', value);
    }
  });
  page.on('pageerror', (error) => {
    if (/service[\s-]?worker/i.test(error.message)) {
      observe('service_worker_error', error.message);
      return;
    }
    pageErrors.push(error.message.slice(0, 1000));
    observe('pageerror', error.message);
  });
  page.on('requestfailed', (request) => {
    const entry = {
      url: request.url().slice(0, 1000),
      method: request.method(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || 'request failed'
    };
    requestFailures.push(entry);
    observe('request_failed', entry.error, entry);
  });
  page.on('request', () => { networkRequestCount += 1; });
  page.on('response', async (response) => {
    try {
      const request = response.request();
      const resourceUrl = normalizeUrl(response.url());
      if (!resourceUrl) return;
      if (response.status() >= 500) observe('response_5xx', `HTTP ${response.status()}`, { url: resourceUrl, statusCode: response.status(), resourceType: request.resourceType() });
      else if (response.status() >= 400) observe('response_4xx', `HTTP ${response.status()}`, { url: resourceUrl, statusCode: response.status(), resourceType: request.resourceType() });
      if (resourceUrl === normalizeUrl(url)) return;
      const resourceType = normalizeResourceType(request.resourceType());
      if (!resourceType) return;
      const headers = response.headers();
      const sizeHeader = headers['content-length'];
      const parsedSize = sizeHeader === undefined || sizeHeader === null || sizeHeader === '' ? null : Number(sizeHeader);
      resources.push({
        pageUrl: url,
        resourceUrl,
        resourceType,
        statusCode: response.status(),
        sizeBytes: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : null,
        sizeMeasurementKind: Number.isFinite(parsedSize) && parsedSize >= 0 ? 'content_length' : null,
        sizeMeasurementError: Number.isFinite(parsedSize) && parsedSize >= 0 ? null : 'content_length_unavailable',
        contentType: headers['content-type'] || null,
        isThirdParty: isInternalUrl(resourceUrl, finalDomain) ? 0 : 1,
        responseHeadersJson: JSON.stringify(selectedHeaders(headers)).slice(0, 20000)
      });
    } catch {
      // Resource evidence is best-effort and must not break page extraction.
    }
  });

  const navigationStartedAt = Date.now();
  const navigationStartedAtIso = new Date(navigationStartedAt).toISOString();
  let mainResponse = null;
  try {
    phase = 'navigation';
    mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!mainResponse) navigationError = 'Navigation returned no main-document response.';
  } catch (error) {
    navigationError = error.message.slice(0, 2000);
    observe('navigation_error', navigationError);
  }
  const navigationCompletedAtIso = new Date().toISOString();
  const navigationDurationMs = Date.now() - navigationStartedAt;
  const finalNavigatedUrl = normalizeUrl(page.url()) || page.url() || null;

  if (navigationError) {
    const browserEvents = normalizeBrowserEvents(events, null);
    await page.close().catch(() => {});
    return {
      ...emptyRenderResult(),
      renderStatus: 'technical_error',
      settlingStatus: 'navigation_failed',
      navigationError,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
      requestFailuresJson: JSON.stringify(requestFailures.slice(0, 25)),
      cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
      browserEventsJson: JSON.stringify(browserEvents.slice(0, 100)),
      renderProvenanceJson: JSON.stringify(buildRenderProvenance(config, [], 'navigation_failed', 0, navigationAttempt, mainResponse, { requestedUrl: url, finalUrl: finalNavigatedUrl, navigationStartedAt: navigationStartedAtIso, navigationCompletedAt: navigationCompletedAtIso, navigationDurationMs })),
      browserNavigationDurationMs: navigationDurationMs,
      networkRequestCount,
      failedRequestCount: requestFailures.length,
      resources
    };
  }

  phase = 'initial_snapshot';
  let collected;
  try {
    collected = await settleDocumentState(page, url, navigationAttempt, config, options.shouldAbort, () => { phase = 'settling'; }, finalDomain);
  } catch (error) {
    phase = 'audit_instrumentation';
    const message = error.message.slice(0, 2000);
    observe('runner_error', message);
    const browserEvents = normalizeBrowserEvents(events, null);
    await page.close().catch(() => {});
    return {
      ...emptyRenderResult(),
      renderStatus: 'technical_error',
      settlingStatus: 'technical_error',
      navigationError: null,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
      requestFailuresJson: JSON.stringify(requestFailures.slice(0, 25)),
      cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
      browserEventsJson: JSON.stringify(browserEvents.slice(0, 100)),
      renderProvenanceJson: JSON.stringify(buildRenderProvenance(config, [], 'technical_error', Date.now() - navigationStartedAt, navigationAttempt, mainResponse, {
        requestedUrl: url,
        finalUrl: finalNavigatedUrl,
        navigationStartedAt: navigationStartedAtIso,
        navigationCompletedAt: navigationCompletedAtIso,
        navigationDurationMs
      })),
      browserNavigationDurationMs: navigationDurationMs,
      networkRequestCount,
      failedRequestCount: requestFailures.length,
      resources
    };
  }
  const { snapshots, settling, settlingDurationMs, aborted } = collected;
  const initialState = snapshots[0] || null;
  const settledState = snapshots.at(-1) || null;
  const renderStatus = aborted ? 'technical_error' : settling.stable ? 'success' : 'unstable';
  phase = settling.stable ? 'settled' : 'settling_complete';
  const browserEvents = normalizeBrowserEvents(events, settledState);
  const renderedHtml = options.captureHtml ? await page.content().catch(() => null) : null;
  await page.close().catch(() => {});

  const finalLinks = settledState?.internalLinks || [];
  const h1 = settledState?.h1 || [];
  const effective = buildEffectiveDocumentState(null, initialState, settledState, { renderStatus, settlingStatus: settling.status });
  return {
    renderedTextLength: settledState?.visibleText?.length ?? null,
    renderedVisibleTextLength: settledState?.visibleText?.length ?? null,
    renderedVisibleTextHash: settledState?.visibleText?.hash ?? null,
    wordCountRendered: settledState?.visibleText?.wordCount ?? null,
    renderedH1Json: JSON.stringify(h1.slice(0, 50)),
    renderedH1Count: h1.length,
    renderedLinksCount: finalLinks.filter((link) => isInternalUrl(link, finalDomain)).length,
    consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
    pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
    requestFailuresJson: JSON.stringify(requestFailures.slice(0, 25)),
    cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
    browserEventsJson: JSON.stringify(browserEvents.slice(0, 100)),
    navigationError: aborted ? 'Rendering aborted because the audit run is no longer active.' : null,
    renderStatus,
    settlingStatus: settling.status,
    settlingDurationMs,
    renderSnapshotCount: snapshots.length,
    renderFingerprint: settledState?.semanticFingerprint || null,
    initialRenderedStateJson: JSON.stringify(initialState),
    settledRenderedStateJson: JSON.stringify(settledState),
    renderProvenanceJson: JSON.stringify(buildRenderProvenance(config, snapshots, settling.status, settlingDurationMs, navigationAttempt, mainResponse, { requestedUrl: url, finalUrl: finalNavigatedUrl, navigationStartedAt: navigationStartedAtIso, navigationCompletedAt: navigationCompletedAtIso, navigationDurationMs })),
    browserNavigationDurationMs: navigationDurationMs,
    networkRequestCount,
    failedRequestCount: requestFailures.length,
    effectiveRenderedStateJson: JSON.stringify(effective),
    resources,
    renderedHtml
  };
}

export async function settleDocumentState(page, url, navigationAttempt = 1, configInput = {}, shouldAbort = null, onSettling = null, finalDomain = null) {
  const config = normalizeSettlingConfig(configInput);
  const settlingStartedAt = Date.now();
  const snapshots = [await takeSnapshot(page, url, navigationAttempt, 0, finalDomain)];
  let settling = classifySettling(snapshots, config, 0);
  let aborted = false;
  while (snapshots.length < config.maxSnapshots && Date.now() - settlingStartedAt < config.maxDurationMs) {
    if (typeof shouldAbort === 'function' && await shouldAbort()) {
      aborted = true;
      break;
    }
    const remaining = config.maxDurationMs - (Date.now() - settlingStartedAt);
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(config.intervalMs, remaining));
    if (onSettling) onSettling();
    snapshots.push(await takeSnapshot(page, url, navigationAttempt, snapshots.length, finalDomain));
    settling = classifySettling(snapshots, config, Date.now() - settlingStartedAt);
    if (settling.stable) break;
  }
  const settlingDurationMs = Date.now() - settlingStartedAt;
  if (aborted) settling = { status: 'aborted', stable: false, stableCount: 0 };
  else if (!settling.stable) settling = classifySettling(snapshots, config, settlingDurationMs);
  return { snapshots, settling, settlingDurationMs, aborted, config };
}

async function takeSnapshot(page, url, navigationAttempt, ordinal, finalDomain = null) {
  const observedAt = new Date().toISOString();
  const raw = await page.evaluate(browserDocumentStateEvaluator);
  return createDocumentState(raw, {
    url,
    source: ordinal === 0 ? 'initial_rendered_dom' : 'settling_rendered_dom',
    observedAt,
    snapshotId: `render-${navigationAttempt}-${ordinal + 1}`,
    navigationAttempt,
    finalDomain
  });
}

export function buildRenderProvenance(config, snapshots, settlingStatus, durationMs, navigationAttempt, response, navigation = {}) {
  const initial = snapshots[0] || null;
  const final = snapshots.at(-1) || null;
  const metadataChanges = changedMetadataFields(initial, final);
  const contentGrew = Boolean(initial && final && Number(final.visibleText?.wordCount || 0) > Number(initial.visibleText?.wordCount || 0));
  const outcomes = [settlingStatus];
  if (contentGrew) outcomes.push('content_grew_after_initial_snapshot');
  if (metadataChanges.length) outcomes.push('metadata_changed_after_initial_snapshot');
  return {
    version: RENDER_PROVENANCE_VERSION,
    settlingPolicyVersion: SETTLING_POLICY_VERSION,
    navigationAttempt,
    navigationWaitUntil: 'domcontentloaded',
    requestedUrl: navigation.requestedUrl || null,
    finalUrl: navigation.finalUrl || response?.url?.() || null,
    navigationStartedAt: navigation.navigationStartedAt || null,
    navigationCompletedAt: navigation.navigationCompletedAt || null,
    navigationDurationMs: navigation.navigationDurationMs ?? null,
    mainResponseStatus: response?.status?.() ?? null,
    config,
    settlingStatus,
    settlingOutcomes: outcomes,
    settlingStartedAt: initial?.observedAt || null,
    settlingCompletedAt: final?.observedAt || null,
    stableStateObservedAt: ['settled', 'content_remained_empty'].includes(settlingStatus) ? final?.observedAt || null : null,
    settlingDurationMs: durationMs,
    snapshotCount: snapshots.length,
    initialVisibleTextLength: initial?.visibleText?.length ?? null,
    finalVisibleTextLength: final?.visibleText?.length ?? null,
    initialVisibleWordCount: initial?.visibleText?.wordCount ?? null,
    finalVisibleWordCount: final?.visibleText?.wordCount ?? null,
    initialFingerprint: initial?.semanticFingerprint || null,
    finalFingerprint: final?.semanticFingerprint || null,
    contentGrewAfterInitialSnapshot: contentGrew,
    metadataChangedAfterInitialSnapshot: metadataChanges.length > 0,
    metadataChanges,
    snapshots: snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      observedAt: snapshot.observedAt,
      source: snapshot.source,
      semanticFingerprint: snapshot.semanticFingerprint,
      title: snapshot.title,
      mainWordCount: snapshot.mainText?.wordCount ?? null,
      visibleWordCount: snapshot.visibleText?.wordCount ?? null,
      h1Count: snapshot.h1?.length ?? null,
      internalLinksCount: snapshot.internalLinks?.length ?? null,
      loadingIndicators: snapshot.documentReadiness?.loadingIndicators ?? null,
      mainContentPresent: snapshot.documentReadiness?.mainContentPresent ?? null
    }))
  };
}

function changedMetadataFields(initial, final) {
  if (!initial || !final) return [];
  return ['title', 'metaDescription', 'canonical', 'htmlLang', 'robots', 'hreflang', 'openGraph', 'twitter', 'h1', 'structuredData']
    .filter((field) => JSON.stringify(initial[field] ?? null) !== JSON.stringify(final[field] ?? null));
}

function emptyRenderResult() {
  return {
    renderedTextLength: null,
    renderedVisibleTextLength: null,
    renderedVisibleTextHash: null,
    wordCountRendered: null,
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: 0,
    renderedLinksCount: null,
    consoleErrorsJson: JSON.stringify([]),
    pageErrorsJson: JSON.stringify([]),
    requestFailuresJson: JSON.stringify([]),
    cspViolationsJson: JSON.stringify([]),
    browserEventsJson: JSON.stringify([]),
    navigationError: null,
    renderStatus: 'not_executed',
    settlingStatus: 'not_executed',
    settlingDurationMs: null,
    renderSnapshotCount: 0,
    renderFingerprint: null,
    initialRenderedStateJson: null,
    settledRenderedStateJson: null,
    renderProvenanceJson: JSON.stringify({ version: RENDER_PROVENANCE_VERSION, settlingPolicyVersion: SETTLING_POLICY_VERSION, settlingStatus: 'not_executed' }),
    effectiveRenderedStateJson: null,
    resources: [],
    renderedHtml: null,
    browserNavigationDurationMs: null,
    networkRequestCount: null,
    failedRequestCount: null
  };
}

function normalizeResourceType(type) {
  if (type === 'script') return 'script';
  if (type === 'stylesheet') return 'stylesheet';
  if (type === 'image') return 'image';
  if (type === 'font') return 'font';
  if (['document', 'xhr', 'fetch', 'other'].includes(type)) return 'other';
  return null;
}
