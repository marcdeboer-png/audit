import { crawlerDefaults } from '../crawler/defaults.js';

export function headersToObject(headers) {
  const output = {};
  if (!headers) return output;
  for (const [key, value] of headers.entries()) {
    output[key.toLowerCase()] = value;
  }
  return output;
}

export function selectedHeaders(headersObject) {
  const wanted = [
    'content-type',
    'charset',
    'cache-control',
    'age',
    'expires',
    'etag',
    'last-modified',
    'via',
    'x-cache',
    'x-cache-hits',
    'cf-cache-status',
    'x-azure-ref',
    'x-served-by',
    'server',
    'content-encoding',
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'x-robots-tag'
  ];
  const output = {};
  for (const key of wanted) {
    if (headersObject[key]) output[key] = headersObject[key];
  }
  return output;
}

export async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = 15000,
    maxBytes = 5 * 1024 * 1024,
    method = 'GET',
    redirect = 'follow'
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  let currentUrl = url;
  const redirectChain = [];
  let initialStatusCode = null;

  try {
    const maxRedirects = Math.max(0, Number(options.maxRedirects ?? 8));
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      response = await fetch(currentUrl, {
        method,
        redirect: redirect === 'follow' ? 'manual' : redirect,
        signal: controller.signal,
        headers: {
          'user-agent': options.userAgent || crawlerDefaults.userAgent,
          'accept': 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8',
          ...(options.headers || {})
        }
      });
      if (initialStatusCode === null) initialStatusCode = response.status;
      const location = response.headers.get('location');
      const nextUrl = location ? new URL(location, currentUrl).toString() : null;
      const isRedirect = response.status >= 300 && response.status < 400;
      if (isRedirect) redirectChain.push({ url: currentUrl, statusCode: response.status, location: nextUrl });
      if (redirect === 'follow' && isRedirect && nextUrl) {
        if (attempt === maxRedirects) throw new Error(`Too many redirects for ${url}`);
        currentUrl = nextUrl;
        continue;
      }
      break;
    }

    const ttfbMs = Date.now() - started;
    const arrayBuffer = await response.arrayBuffer();
    const loadTimeMs = Date.now() - started;
    const bytes = Buffer.from(arrayBuffer);
    const truncated = bytes.length > maxBytes;
    const body = bytes.subarray(0, maxBytes).toString('utf8');

    return {
      ok: response.ok,
      url: response.url || currentUrl,
      statusCode: response.status,
      initialStatusCode,
      redirectChain,
      contentType: response.headers.get('content-type') || '',
      headers: headersToObject(response.headers),
      body,
      buffer: bytes.subarray(0, maxBytes),
      sizeBytes: bytes.length,
      truncated,
      ttfbMs,
      loadTimeMs,
      redirected: redirectChain.length > 0
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function followRedirectChain(startUrl, options = {}) {
  const maxRedirects = options.maxRedirects || 8;
  const timeoutMs = options.timeoutMs || 10000;
  let currentUrl = startUrl;
  const chain = [];

  for (let i = 0; i <= maxRedirects; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': options.userAgent || crawlerDefaults.userAgent,
          'accept': 'text/html,*/*;q=0.8'
        }
      });
      const location = response.headers.get('location');
      const entry = {
        url: currentUrl,
        statusCode: response.status,
        location: location ? new URL(location, currentUrl).toString() : null
      };
      chain.push(entry);

      if (response.status >= 300 && response.status < 400 && location) {
        currentUrl = entry.location;
        continue;
      }

      return {
        startUrl,
        finalUrl: currentUrl,
        statusCode: response.status,
        ok: response.status >= 200 && response.status < 500,
        chain
      };
    } catch (error) {
      chain.push({
        url: currentUrl,
        statusCode: null,
        location: null,
        error: error.message
      });
      return {
        startUrl,
        finalUrl: currentUrl,
        statusCode: null,
        ok: false,
        chain,
        error: error.message
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    startUrl,
    finalUrl: currentUrl,
    statusCode: null,
    ok: false,
    chain,
    error: 'Too many redirects'
  };
}
