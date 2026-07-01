import { evaluateUrlPatterns, patternsFromRun } from './crawlConfig.js';
import { enqueueSkippedUrl, enqueueUrl } from '../queue/sqliteQueue.js';
import { isLikelyHtmlPage, normalizeUrl } from '../utils/url.js';

export function enqueueUrlWithPolicy(db, run, options) {
  const normalizedUrl = normalizeUrl(options.url, options.baseUrl || null);
  if (!normalizedUrl) return { inserted: false, normalizedUrl: null, reason: 'invalid' };

  if (!options.allowNonHtml && !isLikelyHtmlPage(normalizedUrl)) {
    return { inserted: false, normalizedUrl, reason: 'non_html' };
  }

  const sourceType = options.sourceType || 'internal_link';
  if (run.crawlMode === 'sitemap_only' && sourceType === 'internal_link') {
    return enqueueSkippedUrl(db, {
      ...options,
      runId: run.id,
      url: normalizedUrl,
      normalizedUrl
    }, 'Skipped by crawlMode=sitemap_only');
  }

  if (run.crawlMode === 'internal_links_only' && ['sitemap', 'robots_sitemap'].includes(sourceType)) {
    return enqueueSkippedUrl(db, {
      ...options,
      runId: run.id,
      url: normalizedUrl,
      normalizedUrl
    }, 'Skipped by crawlMode=internal_links_only');
  }

  const patternResult = evaluateUrlPatterns(normalizedUrl, patternsFromRun(run));
  if (!patternResult.allowed) {
    return enqueueSkippedUrl(db, {
      ...options,
      runId: run.id,
      url: normalizedUrl,
      normalizedUrl
    }, patternResult.reason);
  }

  return enqueueUrl(db, {
    ...options,
    runId: run.id,
    url: normalizedUrl
  });
}

export function enqueueBatchWithPolicy(db, run, rows) {
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = enqueueUrlWithPolicy(db, run, row);
    if (result.inserted) inserted += 1;
    else if (result.reason && result.reason.startsWith('Skipped')) skipped += 1;
  }
  return { inserted, skipped };
}
