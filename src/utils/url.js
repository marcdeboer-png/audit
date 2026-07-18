const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid'
]);

const NON_PAGE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar',
  '.7z', '.gz', '.tar', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif',
  '.svg', '.mp4', '.mov', '.avi', '.wmv', '.mp3', '.wav', '.ogg', '.css',
  '.js', '.json', '.xml', '.txt', '.woff', '.woff2', '.ttf', '.eot'
]);

export function sanitizeDomainInput(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Domain is required');
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, '') + (parsed.port ? `:${parsed.port}` : '');
  } catch {
    throw new Error(`Invalid domain: ${input}`);
  }
}

export function originCandidates(input) {
  const domain = sanitizeDomainInput(input);
  const host = hostFromSanitizedDomain(domain);
  const candidates = [
    `https://${domain}`,
    `http://${domain}`
  ];
  if (!isIpAddress(host)) {
    candidates.splice(1, 0, `https://www.${domain}`);
    candidates.push(`http://www.${domain}`);
  }
  return candidates;
}

export function normalizeUrl(input, baseUrl = null) {
  return normalizeHttpUrl(input, baseUrl, { preserveTrailingSlash: false });
}

// Queue identity deliberately ignores a trailing slash, but the authored URL
// still has to be requested verbatim. Otherwise `/path/` can be crawled as
// `/path`, manufacturing a redirect that the page never linked to.
export function normalizeRequestUrl(input, baseUrl = null) {
  return normalizeHttpUrl(input, baseUrl, { preserveTrailingSlash: true });
}

function normalizeHttpUrl(input, baseUrl = null, { preserveTrailingSlash = false } = {}) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (/^(mailto|tel|javascript|data|sms|ftp):/i.test(trimmed)) return null;

  let parsed;
  try {
    parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();

  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (!preserveTrailingSlash && parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}

export function stripWww(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

export function sameSiteHost(hostA, hostB) {
  return stripWww(hostA) === stripWww(hostB);
}

export function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isInternalUrl(url, finalDomainOrUrl) {
  try {
    const host = new URL(url).hostname;
    const baseHost = finalDomainOrUrl.includes('://')
      ? new URL(finalDomainOrUrl).hostname
      : finalDomainOrUrl;
    return sameSiteHost(host, baseHost);
  } catch {
    return false;
  }
}

export function getExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.[a-z0-9]{1,8}$/);
    return match ? match[0] : '';
  } catch {
    return '';
  }
}

export function isLikelyHtmlPage(url) {
  const extension = getExtension(url);
  return !extension || !NON_PAGE_EXTENSIONS.has(extension);
}

export function resourceTypeFromUrl(url) {
  const extension = getExtension(url);
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg'].includes(extension)) return 'image';
  if (extension === '.css') return 'stylesheet';
  if (extension === '.js') return 'script';
  if (['.woff', '.woff2', '.ttf', '.eot'].includes(extension)) return 'font';
  return 'other';
}

export function absoluteUrl(input, baseUrl) {
  return normalizeUrl(input, baseUrl);
}

export function urlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostFromSanitizedDomain(domain) {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return String(domain || '').split(':')[0];
  }
}

function isIpAddress(host) {
  const value = String(host || '').replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value);
}
