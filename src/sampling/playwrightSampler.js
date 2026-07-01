import fs from 'node:fs';
import path from 'node:path';
import { cleanText, countWords } from '../extractors/htmlExtractor.js';
import { isInternalUrl, normalizeUrl } from '../utils/url.js';

export async function createPlaywrightSampler({
  finalDomain,
  timeoutMs = 30000,
  userAgent = null,
  collectScreenshots = false,
  screenshotDir = null,
  log = null,
  forceUnavailable = false
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
      async sample() {
        return unavailableResult(error.message);
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
        screenshotDir
      });
    }
  };
}

async function sampleWithBrowser(browser, sample, options) {
  const page = await browser.newPage(options.userAgent ? { userAgent: options.userAgent } : undefined);
  const consoleErrors = [];
  const networkErrors = [];
  const startedAt = Date.now();
  let domContentLoadedMs = null;

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, 1000));
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message.slice(0, 1000));
  });
  page.on('requestfailed', (request) => {
    networkErrors.push({
      url: request.url().slice(0, 1000),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'request failed'
    });
  });
  page.on('domcontentloaded', () => {
    domContentLoadedMs = Date.now() - startedAt;
  });

  try {
    const response = await page.goto(sample.url, { waitUntil: 'load', timeout: options.timeoutMs });
    const loadTimeMs = Date.now() - startedAt;
    const finalUrl = normalizeUrl(page.url()) || page.url();
    const title = await page.title().catch(() => null);
    const renderedText = cleanText(await page.locator('body').textContent({ timeout: 2000 }).catch(() => ''));
    const h1 = await page.locator('h1').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean)).catch(() => []);
    const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.href).filter(Boolean)).catch(() => []);
    const normalizedLinks = [...new Set(links.map((link) => normalizeUrl(link)).filter(Boolean))];
    const renderedLinksCount = normalizedLinks.length;
    const renderedWordCount = countWords(renderedText);
    const rawWordCount = Number(sample.wordCountRaw || 0);
    const rawRenderedWordDelta = renderedWordCount - rawWordCount;
    const rawH1Count = Number(sample.h1Count || 0);
    const rawInternalLinks = Number(sample.internalLinksCount || 0);
    const renderedInternalLinks = normalizedLinks.filter((link) => isInternalUrl(link, options.finalDomain)).length;
    const jsRequiredLikely = (
      (rawWordCount < 100 && renderedWordCount > rawWordCount * 2 && renderedWordCount > 200) ||
      (rawH1Count === 0 && h1.length > 0) ||
      (rawInternalLinks === 0 && renderedInternalLinks > 0)
    ) ? 1 : 0;
    const screenshotPath = options.collectScreenshots && options.screenshotDir
      ? await saveScreenshot(page, options.screenshotDir, sample)
      : null;

    await page.close().catch(() => {});
    return {
      status: response && response.status() >= 400 ? 'error' : 'success',
      finalUrl,
      title,
      h1Count: h1.length,
      renderedWordCount,
      renderedLinksCount,
      rawRenderedWordDelta,
      consoleErrorsCount: consoleErrors.length,
      consoleErrorsJson: JSON.stringify(consoleErrors.slice(0, 25)),
      networkErrorsCount: networkErrors.length,
      networkErrorsJson: JSON.stringify(networkErrors.slice(0, 25)),
      jsRequiredLikely,
      screenshotPath,
      loadTimeMs,
      domContentLoadedMs
    };
  } catch (error) {
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
      consoleErrorsJson: JSON.stringify([...consoleErrors, `Navigation error: ${error.message}`].slice(0, 25)),
      networkErrorsCount: networkErrors.length,
      networkErrorsJson: JSON.stringify(networkErrors.slice(0, 25)),
      jsRequiredLikely: 0,
      screenshotPath: null,
      loadTimeMs: Date.now() - startedAt,
      domContentLoadedMs
    };
  }
}

async function saveScreenshot(page, screenshotDir, sample) {
  const file = `sample-${sample.templateClusterId || 'cluster'}-${String(sample.id || sample.url).replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`;
  const absolutePath = path.join(screenshotDir, file);
  await page.screenshot({ path: absolutePath, fullPage: true }).catch(() => null);
  return fs.existsSync(absolutePath) ? absolutePath : null;
}

function unavailableResult(reason) {
  return {
    status: 'unavailable',
    finalUrl: null,
    title: null,
    h1Count: null,
    renderedWordCount: null,
    renderedLinksCount: null,
    rawRenderedWordDelta: null,
    consoleErrorsCount: 0,
    consoleErrorsJson: JSON.stringify([`Playwright unavailable: ${reason}`]),
    networkErrorsCount: 0,
    networkErrorsJson: JSON.stringify([]),
    jsRequiredLikely: 0,
    screenshotPath: null,
    loadTimeMs: null,
    domContentLoadedMs: null
  };
}
