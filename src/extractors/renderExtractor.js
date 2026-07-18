import { countWords } from './htmlExtractor.js';
import { normalizeUrl, isInternalUrl } from '../utils/url.js';
import { selectedHeaders } from '../utils/http.js';
import { browserVisibleTextEvaluator, normalizeVisibleText, textHash } from './visibleText.js';

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
  if (!browser) {
    return emptyRenderResult();
  }

  const page = await browser.newPage(userAgent ? { userAgent } : undefined);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const cspViolations = [];
  const resources = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const value = message.text().slice(0, 1000);
      if (/content security policy|refused to (load|execute|apply|connect|frame)/i.test(value)) cspViolations.push(value);
      else consoleErrors.push(value);
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message.slice(0, 1000));
  });
  page.on('requestfailed', (request) => {
    requestFailures.push({
      url: request.url().slice(0, 1000),
      method: request.method(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || 'request failed'
    });
  });

  page.on('response', async (response) => {
    try {
      const request = response.request();
      const resourceUrl = normalizeUrl(response.url());
      if (!resourceUrl || resourceUrl === normalizeUrl(url)) return;
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

  let navigationError = null;
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    if (!response) navigationError = 'Navigation returned no main-document response.';
  } catch (error) {
    navigationError = error.message.slice(0, 2000);
  }

  if (navigationError) {
    await page.close().catch(() => {});
    return {
      ...emptyRenderResult(),
      renderStatus: 'technical_error',
      navigationError,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
      requestFailuresJson: JSON.stringify(requestFailures.slice(0, 25)),
      cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
      resources
    };
  }

  const renderedText = normalizeVisibleText(await page.evaluate(browserVisibleTextEvaluator).catch(() => ''));
  const h1 = await page.locator('h1').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean)).catch(() => []);
  const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href).filter(Boolean)).catch(() => []);
  const renderedHtml = options.captureHtml ? await page.content().catch(() => null) : null;
  await page.close().catch(() => {});

  const normalizedLinks = [...new Set(links.map((link) => normalizeUrl(link)).filter(Boolean))];
  const internalLinks = normalizedLinks.filter((link) => isInternalUrl(link, finalDomain));

  return {
    renderedTextLength: renderedText.length,
    renderedVisibleTextLength: renderedText.length,
    renderedVisibleTextHash: textHash(renderedText),
    wordCountRendered: countWords(renderedText),
    renderedH1Json: JSON.stringify(h1.slice(0, 50)),
    renderedH1Count: h1.length,
    renderedLinksCount: internalLinks.length,
    consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
    pageErrorsJson: JSON.stringify(pageErrors.slice(0, 25)),
    requestFailuresJson: JSON.stringify(requestFailures.slice(0, 25)),
    cspViolationsJson: JSON.stringify(cspViolations.slice(0, 25)),
    navigationError: null,
    renderStatus: 'success',
    resources,
    renderedHtml
  };
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
    navigationError: null,
    renderStatus: 'not_executed',
    resources: [],
    renderedHtml: null
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
