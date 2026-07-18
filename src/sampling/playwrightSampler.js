import fs from 'node:fs';
import path from 'node:path';
import { VISIBLE_TEXT_NORMALIZATION_VERSION } from '../extractors/visibleText.js';
import { isInternalUrl, normalizeUrl } from '../utils/url.js';
import { buildRenderProvenance, settleDocumentState } from '../extractors/renderExtractor.js';
import { normalizeBrowserEvents, RENDER_PROVENANCE_VERSION, SETTLING_POLICY_VERSION } from '../extractors/documentState.js';

export async function createPlaywrightSampler({
  finalDomain,
  timeoutMs = 30000,
  userAgent = null,
  collectScreenshots = false,
  screenshotDir = null,
  log = null,
  forceUnavailable = false,
  settling = null
} = {}) {
  let browser;
  try {
    if (forceUnavailable) throw new Error('Forced Playwright unavailable');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (log) log('warning', 'Playwright template sampling unavailable', { error: error.message });
    return {
      available: false,
      unavailableReason: error.message,
      async close() {},
      async sample(sample) {
        return unavailableResult(error.message, sample?.url || null);
      }
    };
  }

  if (collectScreenshots && screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  return {
    available: true,
    unavailableReason: null,
    async close() {
      await browser.close().catch(() => {});
    },
    async sample(sample) {
      return sampleWithBrowser(browser, sample, {
        finalDomain,
        timeoutMs,
        userAgent,
        collectScreenshots,
        screenshotDir,
        settling
      });
    }
  };
}

async function sampleWithBrowser(browser, sample, options) {
  const page = await browser.newPage(options.userAgent ? { userAgent: options.userAgent } : undefined);
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];
  const networkErrors = [];
  const startedAt = Date.now();
  const navigationStartedAt = new Date(startedAt).toISOString();
  let domContentLoadedMs = null;
  const events = [];
  let phase = 'pre_navigation';
  const observe = (type, message, details = {}) => events.push({ type, message: String(message || '').slice(0, 1000), phase, observedAt: new Date().toISOString(), ...details });

  page.on('console', (message) => {
    if (message.type() === 'warning') {
      observe('console_warning', message.text());
      return;
    }
    if (message.type() === 'error') {
      const value = message.text().slice(0, 1000);
      if (/service[\s-]?worker/i.test(value)) {
        observe('service_worker_error', value);
        return;
      }
      if (/content security policy|refused to (load|execute|apply|connect|frame)/i.test(value)) cspViolations.push(value);
      else consoleErrors.push(value);
      observe(/content security policy|refused to (load|execute|apply|connect|frame)/i.test(value) ? 'csp_violation' : 'console_error', value);
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
    networkErrors.push({
      url: request.url().slice(0, 1000),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'request failed'
    });
    observe('request_failed', request.failure()?.errorText || 'request failed', { url: request.url(), resourceType: request.resourceType() });
  });
  page.on('domcontentloaded', () => {
    domContentLoadedMs = Date.now() - startedAt;
  });

  try {
    phase = 'navigation';
    const response = await page.goto(sample.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    const loadTimeMs = Date.now() - startedAt;
    const navigationCompletedAt = new Date().toISOString();
    const finalUrl = normalizeUrl(page.url()) || page.url();
    phase = 'initial_snapshot';
    const collected = await settleDocumentState(page, sample.url, 1, options.settling || {}, null, () => { phase = 'settling'; }, options.finalDomain);
    const initialState = collected.snapshots[0];
    const settledState = collected.snapshots.at(-1);
    phase = collected.settling.stable ? 'settled' : 'settling_complete';
    const title = settledState?.title || null;
    const h1 = settledState?.h1 || [];
    const normalizedLinks = settledState?.internalLinks || [];
    const renderedLinksCount = normalizedLinks.length;
    const renderedWordCount = settledState?.visibleText?.wordCount ?? null;
    const rawWordCount = Number(sample.wordCountRaw || 0);
    const rawRenderedWordDelta = renderedWordCount === null ? null : renderedWordCount - rawWordCount;
    const rawH1Count = Number(sample.h1Count || 0);
    const rawInternalLinks = Number(sample.internalLinksCount || 0);
    const renderedInternalLinks = normalizedLinks.filter((link) => isInternalUrl(link, options.finalDomain)).length;
    const stable = collected.settling.stable;
    const jsRequiredLikely = stable && (
      (rawWordCount < 100 && renderedWordCount > rawWordCount * 2 && renderedWordCount > 200) ||
      (rawH1Count === 0 && h1.length > 0) ||
      (rawInternalLinks === 0 && renderedInternalLinks > 0)
    ) ? 1 : 0;
    const screenshotPath = options.collectScreenshots && options.screenshotDir
      ? await saveScreenshot(page, options.screenshotDir, sample)
      : null;

    await page.close().catch(() => {});
    return {
      status: response && response.status() >= 400 ? 'error' : stable ? 'success' : 'unstable',
      finalUrl,
      title,
      h1Count: h1.length,
      renderedWordCount,
      renderedLinksCount,
      rawRenderedWordDelta,
      consoleErrorsCount: consoleErrors.length,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      pageErrorsCount: pageErrors.length,
      pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
      cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
      networkErrorsCount: networkErrors.length,
      networkErrorsJson: JSON.stringify(networkErrors.slice(0, 25)),
      jsRequiredLikely,
      screenshotPath,
      loadTimeMs,
      domContentLoadedMs,
      navigationError: null,
      textNormalizationVersion: VISIBLE_TEXT_NORMALIZATION_VERSION,
      settlingStatus: collected.settling.status,
      settlingDurationMs: collected.settlingDurationMs,
      renderSnapshotCount: collected.snapshots.length,
      renderFingerprint: settledState?.semanticFingerprint || null,
      initialRenderedStateJson: JSON.stringify(initialState),
      settledRenderedStateJson: JSON.stringify(settledState),
      renderProvenanceJson: JSON.stringify(buildRenderProvenance(collected.config, collected.snapshots, collected.settling.status, collected.settlingDurationMs, 1, response, {
        requestedUrl: sample.url,
        finalUrl,
        navigationStartedAt,
        navigationCompletedAt,
        navigationDurationMs: loadTimeMs
      })),
      browserEventsJson: JSON.stringify(normalizeBrowserEvents(events, settledState)),
      renderProvenanceVersion: RENDER_PROVENANCE_VERSION,
      settlingPolicyVersion: SETTLING_POLICY_VERSION
    };
  } catch (error) {
    const failurePhase = phase;
    const settlingStatus = failurePhase === 'navigation' ? 'navigation_failed' : 'technical_error';
    const eventType = failurePhase === 'navigation' ? 'navigation_error' : 'runner_error';
    await page.close().catch(() => {});
    return {
      status: 'error',
      finalUrl: null,
      title: null,
      h1Count: null,
      renderedWordCount: null,
      renderedLinksCount: null,
      rawRenderedWordDelta: null,
      consoleErrorsCount: consoleErrors.length,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      pageErrorsCount: pageErrors.length,
      pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
      cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
      networkErrorsCount: networkErrors.length,
      networkErrorsJson: JSON.stringify(networkErrors.slice(0, 25)),
      jsRequiredLikely: 0,
      screenshotPath: null,
      loadTimeMs: Date.now() - startedAt,
      domContentLoadedMs,
      navigationError: error.message.slice(0, 2000),
      textNormalizationVersion: VISIBLE_TEXT_NORMALIZATION_VERSION,
      settlingStatus,
      settlingDurationMs: null,
      renderSnapshotCount: 0,
      renderFingerprint: null,
      initialRenderedStateJson: null,
      settledRenderedStateJson: null,
      renderProvenanceJson: JSON.stringify(buildRenderProvenance(options.settling || {}, [], settlingStatus, 0, 1, null, {
        requestedUrl: sample.url,
        finalUrl: null,
        navigationStartedAt,
        navigationCompletedAt: new Date().toISOString(),
        navigationDurationMs: Date.now() - startedAt
      })),
      browserEventsJson: JSON.stringify(normalizeBrowserEvents([...events, { type: eventType, message: error.message, phase: failurePhase }], null)),
      renderProvenanceVersion: RENDER_PROVENANCE_VERSION,
      settlingPolicyVersion: SETTLING_POLICY_VERSION
    };
  }
}

async function saveScreenshot(page, screenshotDir, sample) {
  const file = `sample-${sample.templateClusterId || 'cluster'}-${String(sample.id || sample.url).replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`;
  const absolutePath = path.join(screenshotDir, file);
  await page.screenshot({ path: absolutePath, fullPage: true }).catch(() => null);
  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function unavailableResult(reason, requestedUrl = null) {
  return {
    status: 'unavailable',
    finalUrl: null,
    title: null,
    h1Count: null,
    renderedWordCount: null,
    renderedLinksCount: null,
    rawRenderedWordDelta: null,
    consoleErrorsCount: 0,
    consoleErrorsJson: JSON.stringify([]),
    pageErrorsCount: 0,
    pageErrorsJson: JSON.stringify([]),
    cspViolationsJson: JSON.stringify([]),
    networkErrorsCount: 0,
    networkErrorsJson: JSON.stringify([]),
    jsRequiredLikely: 0,
    screenshotPath: null,
    loadTimeMs: null,
    domContentLoadedMs: null,
    navigationError: `Playwright unavailable: ${reason}`,
    textNormalizationVersion: VISIBLE_TEXT_NORMALIZATION_VERSION,
    settlingStatus: 'not_executed',
    settlingDurationMs: null,
    renderSnapshotCount: 0,
    renderFingerprint: null,
    initialRenderedStateJson: null,
    settledRenderedStateJson: null,
    renderProvenanceJson: JSON.stringify(buildRenderProvenance({}, [], 'not_executed', 0, 1, null, { requestedUrl, finalUrl: null })),
    browserEventsJson: JSON.stringify(normalizeBrowserEvents([{
      type: 'runner_error',
      phase: 'audit_instrumentation',
      message: `Playwright unavailable: ${reason}`,
      observedAt: new Date().toISOString()
    }], null)),
    renderProvenanceVersion: RENDER_PROVENANCE_VERSION,
    settlingPolicyVersion: SETTLING_POLICY_VERSION
  };
}
