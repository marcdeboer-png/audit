import { countWords, cleanText } from './htmlExtractor.js';
import { normalizeUrl, isInternalUrl } from '../utils/url.js';
import { selectedHeaders } from '../utils/http.js';

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
  const resources = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, 1000));
    }
  });

  page.on('pageerror', (error) => {
    consoleErrors.push(error.message.slice(0, 1000));
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
      resources.push({
        pageUrl: url,
        resourceUrl,
        resourceType,
        statusCode: response.status(),
        sizeBytes: sizeHeader ? Number(sizeHeader) : null,
        contentType: headers['content-type'] || null,
        isThirdParty: isInternalUrl(resourceUrl, finalDomain) ? 0 : 1,
        responseHeadersJson: JSON.stringify(selectedHeaders(headers)).slice(0, 20000)
      });
    } catch {
      // Resource evidence is best-effort and must not break page extraction.
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
  } catch (error) {
    consoleErrors.push(`Render navigation error: ${error.message}`.slice(0, 1000));
  }

  const renderedText = cleanText(await page.locator('body').textContent({ timeout: 2000 }).catch(() => ''));
  const h1 = await page.locator('h1').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean)).catch(() => []);
  const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href).filter(Boolean)).catch(() => []);
  const renderedHtml = options.captureHtml ? await page.content().catch(() => null) : null;
  await page.close().catch(() => {});

  const normalizedLinks = [...new Set(links.map((link) => normalizeUrl(link)).filter(Boolean))];
  const internalLinks = normalizedLinks.filter((link) => isInternalUrl(link, finalDomain));

  return {
    renderedTextLength: renderedText.length,
    wordCountRendered: countWords(renderedText),
    renderedH1Json: JSON.stringify(h1.slice(0, 50)),
    renderedH1Count: h1.length,
    renderedLinksCount: internalLinks.length,
    consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
    resources,
    renderedHtml
  };
}

function emptyRenderResult() {
  return {
    renderedTextLength: null,
    wordCountRendered: null,
    renderedH1Json: JSON.stringify([]),
    renderedH1Count: 0,
    renderedLinksCount: null,
    consoleErrorsJson: JSON.stringify([]),
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
