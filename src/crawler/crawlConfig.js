const CRAWL_MODES = new Set(['hybrid', 'sitemap_only', 'internal_links_only', 'template_sample']);
const PLAYWRIGHT_MODES = new Set(['off', 'all', 'sample', 'gate']);

export function parsePatternList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeCrawlMode(value) {
  return CRAWL_MODES.has(value) ? value : 'hybrid';
}

export function normalizePlaywrightMode(value, usePlaywright = false) {
  if (!usePlaywright) return 'off';
  return PLAYWRIGHT_MODES.has(value) ? value : 'off';
}

export function matchesPattern(url, pattern) {
  const text = String(url || '');
  const raw = String(pattern || '').trim();
  if (!raw) return false;

  const regexMatch = raw.match(/^\/(.+)\/([a-z]*)$/i);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(text);
    } catch {
      return text.toLowerCase().includes(raw.toLowerCase());
    }
  }

  if (text.toLowerCase().includes(raw.toLowerCase())) return true;

  try {
    return new RegExp(raw, 'i').test(text);
  } catch {
    return false;
  }
}

export function evaluateUrlPatterns(url, { includePatterns = [], excludePatterns = [] } = {}) {
  const excludedBy = excludePatterns.find((pattern) => matchesPattern(url, pattern));
  if (excludedBy) {
    return { allowed: false, reason: `Excluded by pattern: ${excludedBy}` };
  }

  if (includePatterns.length) {
    const includedBy = includePatterns.find((pattern) => matchesPattern(url, pattern));
    if (!includedBy) {
      return { allowed: false, reason: 'Did not match includePatterns' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

export function patternsFromRun(run) {
  return {
    includePatterns: safeJson(run.includePatternsJson, []),
    excludePatterns: safeJson(run.excludePatternsJson, [])
  };
}

export function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
