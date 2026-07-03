import { crawlerDefaults } from '../crawler/defaults.js';
import { headersToObject } from '../utils/http.js';

export const TARGETED_CRAWLER_DEFAULTS = Object.freeze({
  timeoutMs: 10000,
  concurrency: 3,
  maxConcurrency: 5,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  userAgent: 'OMfireAuditEvidenceBot/0.1 (+targeted-facts; no-raw-html-storage)',
  respectRobots: false
});

export async function fetchTargetedHtml(url, options = {}) {
  const config = normalizeTargetedCrawlerConfig(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent,
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2'
      }
    });
    const headers = headersToObject(response.headers);
    const contentLength = Number(headers['content-length'] || 0);
    if (contentLength > config.maxResponseBytes) {
      throw responseTooLargeError(contentLength, config.maxResponseBytes);
    }
    const body = await readCappedBody(response, config.maxResponseBytes);
    return {
      ok: response.ok,
      url: response.url,
      statusCode: response.status,
      contentType: response.headers.get('content-type') || '',
      headers,
      body,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
      ttfbMs: null,
      loadTimeMs: Date.now() - started,
      redirected: response.redirected,
      truncated: false
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runWithConcurrency(items = [], worker, options = {}) {
  const concurrency = normalizeTargetedCrawlerConfig(options).concurrency;
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

export function normalizeTargetedCrawlerConfig(input = {}) {
  const timeoutMs = clampNumber(input.timeoutMs, 1000, 30000, TARGETED_CRAWLER_DEFAULTS.timeoutMs);
  const maxResponseBytes = clampNumber(input.maxResponseBytes, 1024, 2 * 1024 * 1024, TARGETED_CRAWLER_DEFAULTS.maxResponseBytes);
  const concurrency = clampNumber(input.concurrency, 1, TARGETED_CRAWLER_DEFAULTS.maxConcurrency, TARGETED_CRAWLER_DEFAULTS.concurrency);
  return {
    timeoutMs,
    maxResponseBytes,
    concurrency,
    maxConcurrency: TARGETED_CRAWLER_DEFAULTS.maxConcurrency,
    userAgent: String(input.userAgent || TARGETED_CRAWLER_DEFAULTS.userAgent || crawlerDefaults.userAgent),
    respectRobots: Boolean(input.respectRobots)
  };
}

async function readCappedBody(response, maxBytes) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw responseTooLargeError(buffer.length, maxBytes);
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw responseTooLargeError(bytes, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responseTooLargeError(sizeBytes, maxBytes) {
  const error = new Error(`Response exceeds targeted evidence maxResponseBytes (${sizeBytes} > ${maxBytes})`);
  error.code = 'TARGETED_RESPONSE_TOO_LARGE';
  error.sizeBytes = sizeBytes;
  error.maxBytes = maxBytes;
  return error;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
