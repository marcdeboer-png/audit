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
    'content-security-policy-report-only',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'alt-svc',
    'x-powered-by',
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
    let bytes;
    let observedBytes;
    let truncated;
    if (options.abortOnMaxBytes && response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let retainedBytes = 0;
      observedBytes = 0;
      truncated = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        observedBytes += value.byteLength;
        const retained = Math.max(0, maxBytes - retainedBytes);
        if (retained > 0) {
          const chunk = Buffer.from(value).subarray(0, retained);
          chunks.push(chunk);
          retainedBytes += chunk.length;
        }
        if (observedBytes > maxBytes) {
          truncated = true;
          await reader.cancel('maximum response bytes exceeded');
          break;
        }
      }
      bytes = Buffer.concat(chunks);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      bytes = Buffer.from(arrayBuffer);
      observedBytes = bytes.length;
      truncated = bytes.length > maxBytes;
      bytes = bytes.subarray(0, maxBytes);
    }
    const loadTimeMs = Date.now() - started;
    const body = bytes.toString('utf8');

    return {
      ok: response.ok,
      url: response.url || currentUrl,
      statusCode: response.status,
      initialStatusCode,
      redirectChain,
      contentType: response.headers.get('content-type') || '',
      headers: headersToObject(response.headers),
      body,
      buffer: bytes,
      sizeBytes: observedBytes,
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
  const visited = new Set();

  for (let i = 0; i <= maxRedirects; i += 1) {
    if (visited.has(currentUrl)) {
      return {
        startUrl,
        finalUrl: currentUrl,
        statusCode: null,
        ok: false,
        chain,
        loopDetected: true,
        errorType: 'redirect_loop',
        error: 'Redirect loop detected'
      };
    }
    visited.add(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
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
        location: location ? new URL(location, currentUrl).toString() : null,
        headers: selectedHeaders(headersToObject(response.headers)),
        contentType: response.headers.get('content-type') || '',
        durationMs: Date.now() - started
      };
      chain.push(entry);
      if (response.body) await response.body.cancel().catch(() => {});

      if (response.status >= 300 && response.status < 400 && location) {
        if (visited.has(entry.location)) {
          return {
            startUrl,
            finalUrl: entry.location,
            statusCode: null,
            ok: false,
            chain,
            loopDetected: true,
            errorType: 'redirect_loop',
            error: 'Redirect loop detected'
          };
        }
        currentUrl = entry.location;
        continue;
      }

      return {
        startUrl,
        finalUrl: currentUrl,
        statusCode: response.status,
        // A valid HTTP response proves transport reachability even when the
        // website itself returns 5xx. Status checks decide whether it is healthy.
        ok: response.status >= 100 && response.status <= 599,
        chain,
        initialHeaders: chain[0]?.headers || {},
        finalHeaders: entry.headers,
        contentType: entry.contentType,
        loopDetected: false,
        errorType: null
      };
    } catch (error) {
      const errorType = classifyFetchError(error);
      chain.push({
        url: currentUrl,
        statusCode: null,
        location: null,
        error: error.message,
        errorType,
        durationMs: Date.now() - started
      });
      return {
        startUrl,
        finalUrl: currentUrl,
        statusCode: null,
        ok: false,
        chain,
        loopDetected: false,
        errorType,
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
    loopDetected: false,
    errorType: 'redirect_hops_exceeded',
    error: 'Too many redirects'
  };
}

function classifyFetchError(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if ([
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ].includes(code)) return 'certificate_error';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'ETIMEDOUT' || error?.name === 'AbortError') return 'timeout';
  return 'technical_error';
}
