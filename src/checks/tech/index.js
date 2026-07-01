import {
  HTML_WHERE,
  all,
  checkStatusForCoverage,
  count,
  dedupeImageSamples,
  htmlPageCount,
  issueCheck,
  makeResult,
  pageCount,
  parseProjectJson,
  safeJson,
  sampleUrls
} from '../helpers.js';
import { stripWww } from '../../utils/url.js';
import { thresholdBytes, thresholds } from '../config/thresholds.js';
import { templatePatternChecks } from '../../analysis/templatePatternChecks.js';

const tech = (id, category, name, run, options = {}) => ({
  id: id.startsWith('template.') ? id : `tech.${id}`,
  category,
  name,
  auditType: 'tech',
  priority: options.priority || 'Medium',
  effort: options.effort || 'M',
  recommendation: options.recommendation || '',
  run
});

const LEGAL_PAGE_WHERE = "COALESCE(pageType, 'other') = 'legal'";
const NON_LEGAL_PAGE_WHERE = "COALESCE(pageType, 'other') <> 'legal'";
const INDEXABLE_CONTENT_HTML_WHERE = `${HTML_WHERE} AND COALESCE(indexable, 1) = 1 AND ${NON_LEGAL_PAGE_WHERE}`;
const ROBOTS_TEXT_EXPR = "LOWER(COALESCE(metaRobots, '') || ' ' || COALESCE(xRobotsTag, ''))";
const NON_DECORATIVE_IMAGE_WHERE = `
  COALESCE(likelyDecorativeImage, 0) = 0
  AND COALESCE(likelyBadgeImage, 0) = 0
  AND COALESCE(likelyTrackingPixel, 0) = 0
  AND COALESCE(likelyIcon, 0) = 0
`;
const NOT_SMALL_IMAGE_WHERE = `
  (
    NULLIF(width, '') IS NULL OR
    NULLIF(height, '') IS NULL OR
    CAST(width AS INTEGER) > 64 OR
    CAST(height AS INTEGER) > 64
  )
`;
const NOT_LIKELY_HERO_IMAGE_WHERE = `
  COALESCE(imageRole, '') <> 'hero'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%hero%'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%masthead%'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%banner%'
`;

export function techChecks() {
  return [
    domainHttpsReachable(),
    httpToHttpsRedirect(),
    wwwConsistency(),
    statusCodeDistribution(),
    pageStatusCheck('4xx_pages', 'Server & Infrastructure', '4xx pages present', 'statusCode >= 400 AND statusCode < 500', 'Warning'),
    pageStatusCheck('5xx_pages', 'Server & Infrastructure', '5xx pages present', 'statusCode >= 500', 'Error', 'High'),
    pageStatusCheck('redirect_pages', 'Server & Infrastructure', 'Redirect pages present', '(statusCode >= 300 AND statusCode < 400) OR finalUrl <> url', 'Warning'),
    headerPresence('compression_header', 'Server & Infrastructure', 'Compression header present', 'content-encoding', 'Low'),
    headerPresence('cache_control_header', 'Server/Performance Best Practice', 'Cache-Control header present', 'cache-control', 'Low', {
      findingType: 'best_practice',
      missingFinding: (affected, total) => `${affected}/${total} HTML page(s) have no detected HTTP Cache-Control header.`,
      okFinding: 'HTML responses include a Cache-Control header where stored.',
      recommendation: 'HTTP Cache-Control header not detected for HTML responses. Review caching policy for performance and freshness control.'
    }),
    httpVersionSupport(),
    cdnCacheSignals(),
    headerPresence('hsts_header', 'Security Best Practice', 'HSTS present', 'strict-transport-security', 'Medium'),
    headerPresence('content_security_policy', 'Security Best Practice', 'Content-Security-Policy present', 'content-security-policy', 'Medium'),
    headerPresence('x_frame_options', 'Security Best Practice', 'X-Frame-Options present', 'x-frame-options', 'Low'),
    headerPresence('x_content_type_options', 'Security Best Practice', 'X-Content-Type-Options present', 'x-content-type-options', 'Low'),
    headerPresence('referrer_policy', 'Security Best Practice', 'Referrer-Policy present', 'referrer-policy', 'Low'),
    headerPresence('permissions_policy', 'Security Best Practice', 'Permissions-Policy present', 'permissions-policy', 'Low'),
    xRobotsTagCheck(),
    contentTypeHtmlCheck(),
    charsetUtf8Check(),
    robotsTxtPresent(),
    sitemapPresent(),
    sitemapInRobots(),
    sitemapUrlsNon200(),
    noindexPagesCheck(),
    nofollowPagesCheck(),
    canonicalMissing(),
    pageStatusCheck('canonical_non_self', 'Crawling & Indexing', 'Canonical non-self', 'canonical IS NOT NULL AND canonical <> normalizedUrl', 'Warning'),
    canonicalOtherDomain(),
    canonicalTargetNon200(),
    internalLinksToStatus('internal_links_to_3xx', 'Internal links to 3xx', 'p.statusCode >= 300 AND p.statusCode < 400', 'Warning'),
    internalLinksToStatus('internal_links_to_4xx_5xx', 'Internal links to 4xx/5xx', 'p.statusCode >= 400', 'Error', 'High'),
    orphanLikeSitemapUrls(),
    contentMissingField('title_missing', 'HTML Head & Meta', 'Title missing', 'title', 'Error'),
    contentLengthCheck('title_too_short', 'HTML Head & Meta', `Title too short < ${thresholds.titleTooShort}`, `titleLength < ${thresholds.titleTooShort} AND COALESCE(title, '') <> ''`, 'Warning'),
    contentLengthCheck('title_too_long', 'HTML Head & Meta', `Title too long > ${thresholds.titleTooLong}`, `titleLength > ${thresholds.titleTooLong}`, 'Warning'),
    duplicateContentField('duplicate_titles', 'HTML Head & Meta', 'Duplicate titles', 'title', 'Warning'),
    contentMissingField('meta_description_missing', 'HTML Head & Meta', 'Meta description missing', 'metaDescription', 'Warning'),
    contentLengthCheck('meta_description_too_short', 'HTML Head & Meta', `Meta description too short < ${thresholds.descriptionTooShort}`, `metaDescriptionLength < ${thresholds.descriptionTooShort} AND COALESCE(metaDescription, '') <> ''`, 'Warning', 'Low'),
    contentLengthCheck('meta_description_too_long', 'HTML Head & Meta', `Meta description too long > ${thresholds.descriptionTooLong}`, `metaDescriptionLength > ${thresholds.descriptionTooLong}`, 'Warning', 'Low'),
    duplicateContentField('duplicate_meta_descriptions', 'HTML Head & Meta', 'Duplicate meta descriptions', 'metaDescription', 'Warning', 'Low'),
    pageStatusCheck('h1_missing', 'HTML Head & Meta', 'H1 missing', `${HTML_WHERE} AND h1Count = 0`, 'Error'),
    pageStatusCheck('multiple_h1', 'HTML Head & Meta', 'Multiple H1', `${HTML_WHERE} AND h1Count > 1`, 'Warning'),
    missingField('html_lang_missing', 'HTML Head & Meta', 'HTML lang missing', 'htmlLang', 'Warning'),
    missingField('viewport_missing', 'HTML Head & Meta', 'Viewport missing', 'viewport', 'Warning'),
    openGraphMissing(),
    missingField('favicon_missing', 'HTML Head & Meta', 'Favicon missing', 'favicon', 'Warning', 'Low'),
    appIconsIncomplete(),
    missingField('webmanifest_missing', 'Browser Metadata Opportunity', 'Webmanifest missing', 'manifest', 'Warning', 'Low'),
    hreflangXDefaultMissing(),
    consentTechnicalSignals(),
    pageStatusCheck('raw_html_size_large', 'Performance Light', `Raw HTML size > ${thresholds.largeHtmlKb} KB`, `rawHtmlSize > ${thresholdBytes.largeHtmlBytes}`, 'Warning'),
    resourceCountCheck('too_many_js', 'Performance Light', `Too many JS resources > ${thresholds.tooManyJsResources} per page`, 'script', thresholds.tooManyJsResources, 'Warning'),
    resourceCountCheck('too_many_css', 'Performance Light', `Too many CSS resources > ${thresholds.tooManyCssResources} per page`, 'stylesheet', thresholds.tooManyCssResources, 'Warning'),
    resourceBytesCheck('large_js_total', 'Performance Light', 'Large JS total size > 1 MB per page', 'script', thresholds.largeJsTotalBytes, 'Warning'),
    resourceBytesCheck('large_css_total', 'Performance Light', 'Large CSS total size > 300 KB per page', 'stylesheet', thresholds.largeCssTotalBytes, 'Warning'),
    thirdPartyScripts(),
    preloadMissing(),
    preconnectMissing(),
    resourceHintsSummary(),
    importedResourcePerformanceSignals(),
    highTtfbCheck(),
    pageStatusCheck('rendered_word_count_delta', 'JavaScript & Rendering', `Rendered word count > raw word count * ${thresholds.renderedRawWordCountRatio}`, `wordCountRendered IS NOT NULL AND wordCountRendered > wordCountRaw * ${thresholds.renderedRawWordCountRatio} AND wordCountRendered - wordCountRaw > 50`, 'Warning'),
    pageStatusCheck('raw_h1_missing_rendered_present', 'JavaScript & Rendering', 'Raw H1 missing but rendered H1 present', 'h1Count = 0 AND renderedH1Count > 0', 'Warning'),
    pageStatusCheck('raw_internal_links_fewer_rendered', 'JavaScript & Rendering', 'Raw internal links much fewer than rendered links', 'renderedLinksCount IS NOT NULL AND renderedLinksCount > internalLinksCount * 1.5 AND renderedLinksCount - internalLinksCount > 5', 'Warning'),
    consoleErrorsPresent(),
    pageStatusCheck('js_dependent_content', 'JavaScript & Rendering', 'Main content likely JS-dependent', 'wordCountRaw < 100 AND wordCountRendered IS NOT NULL AND wordCountRendered > wordCountRaw * 2 AND wordCountRendered > 200', 'Warning'),
    templateLowLighthousePerformance(),
    templateLowLighthouseSeo(),
    templateHighLcp(),
    templateHighTbt(),
    templateConsoleErrors(),
    templateJsRequiredContent(),
    templateLighthouseUnavailable(),
    templatePlaywrightUnavailable(),
    ...templatePatternChecks(),
    jsonLdParseErrors(),
    schemaCoverageSummary(),
    schemaMissing('organization_missing', 'Structured Data', 'Organization missing', 'Organization', 'Warning'),
    schemaMissing('website_missing', 'Structured Data', 'WebSite missing', 'WebSite', 'Warning'),
    breadcrumbCoverage(),
    faqPageCoverage(),
    articleCoverage(),
    productCoverage(),
    localBusinessDomainHint(),
    personSchemaCoverage(),
    speakableOpportunity(),
    organizationSameAsMissing(),
    imagesWithoutAlt(),
    emptyAltTexts(),
    imageAttributeCheck('images_without_width_height', 'Media SEO', 'Images without width/height', "(width IS NULL OR width = '' OR height IS NULL OR height = '')", 'Warning'),
    imageAttributeCheck('images_without_lazy_loading', 'Media SEO', 'Images without lazy loading', "(loading IS NULL OR LOWER(loading) <> 'lazy')", 'Warning', 'Low', {
      findingType: 'best_practice',
      extraContentWhere: `${NOT_SMALL_IMAGE_WHERE} AND ${NOT_LIKELY_HERO_IMAGE_WHERE}`,
      finding: 'Some non-critical images do not use lazy loading.',
      recommendation: 'Some non-critical images do not use lazy loading. Review whether below-the-fold images should use loading=lazy.',
      issueReason: 'non-critical image missing loading=lazy'
    }),
    largeImages(),
    modernImageCoverageLow(),
    videoObjectCheck()
  ];
}

function domainHttpsReachable() {
  return tech('https_reachable', 'Server & Infrastructure', 'HTTPS reachable', function run(ctx) {
    const candidates = parseProjectJson(ctx.project, 'protocolBehaviorJson', []);
    const httpsCandidates = candidates.filter((item) => item.startUrl?.startsWith('https://'));
    const reachable = httpsCandidates.filter((item) => item.statusCode && item.statusCode < 500);
    return makeResult(this, reachable.length ? 'OK' : 'Error', {
      affectedCount: reachable.length ? 0 : 1,
      finding: reachable.length ? 'At least one HTTPS candidate was reachable.' : 'No HTTPS candidate was reachable.',
      recommendation: 'Serve the canonical site via HTTPS.',
      evidence: { httpsCandidates }
    });
  }, { priority: 'High', effort: 'M' });
}

function httpToHttpsRedirect() {
  return tech('http_to_https_redirect', 'Server & Infrastructure', 'HTTP to HTTPS redirect', function run(ctx) {
    const candidates = parseProjectJson(ctx.project, 'protocolBehaviorJson', []);
    const http = candidates.filter((item) => item.startUrl?.startsWith('http://') && item.statusCode);
    const notRedirecting = http.filter((item) => !item.redirectsToHttps);
    const status = !http.length ? 'NA' : notRedirecting.length ? 'Warning' : 'OK';
    return makeResult(this, status, {
      affectedCount: notRedirecting.length,
      finding: status === 'OK' ? 'Reachable HTTP candidates redirect to HTTPS.' : `${notRedirecting.length} HTTP candidate(s) did not end on HTTPS.`,
      recommendation: 'Redirect all HTTP variants to the canonical HTTPS URL.',
      evidence: { httpCandidates: http }
    });
  });
}

function wwwConsistency() {
  return tech('www_non_www_consistency', 'Server & Infrastructure', 'www/non-www consistency', function run(ctx) {
    const data = parseProjectJson(ctx.project, 'wwwBehaviorJson', { candidates: [] });
    const reachableHosts = [...new Set((data.candidates || [])
      .filter((item) => item.statusCode && item.statusCode < 500 && item.finalHost)
      .map((item) => item.finalHost))];
    const hostVariants = [...new Set(reachableHosts.map((host) => stripWww(host)))];
    const mixedWww = reachableHosts.some((host) => host.startsWith('www.')) && reachableHosts.some((host) => !host.startsWith('www.'));
    const status = hostVariants.length > 1 || mixedWww ? 'Warning' : 'OK';
    return makeResult(this, status, {
      affectedCount: status === 'OK' ? 0 : reachableHosts.length,
      finding: status === 'OK' ? 'Reachable variants converge consistently.' : 'Reachable variants do not converge to one host form.',
      recommendation: 'Choose one canonical host variant and redirect alternates to it.',
      evidence: { reachableHosts, selectedHost: data.selectedHost }
    });
  });
}

function statusCodeDistribution() {
  return tech('status_code_distribution', 'Server & Infrastructure', 'Status code distribution', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT COALESCE(statusCode, 0) AS statusCode, COUNT(*) AS count
      FROM pages
      WHERE runId = ?
      GROUP BY COALESCE(statusCode, 0)
      ORDER BY statusCode
    `, [ctx.run.id]);
    return makeResult(this, rows.length ? 'OK' : 'NA', {
      finding: rows.length ? 'Status code distribution calculated from crawled pages.' : 'No page responses stored.',
      details: rows.map((row) => `${row.statusCode}: ${row.count}`).join(', '),
      evidence: { distribution: rows }
    });
  }, { priority: 'Low', effort: 'S' });
}

function pageStatusCheck(id, category, name, where, status = 'Warning', priority = 'Medium') {
  return issueCheck({
    id: `tech.${id}`,
    category,
    name,
    auditType: 'tech',
    priority,
    effort: 'S',
    where,
    status
  });
}

function highTtfbCheck() {
  return tech('high_ttfb', 'Performance Light', `High TTFB > ${thresholds.highTtfbMs}ms`, function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, ttfbMs, loadTimeMs, statusCode, pageType
      FROM pages
      WHERE runId = ? AND ttfbMs IS NOT NULL AND ttfbMs > ?
      ORDER BY ttfbMs DESC
      LIMIT 10
    `, [ctx.run.id, thresholds.highTtfbMs]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ttfbMs IS NOT NULL AND ttfbMs > ?
    `, [ctx.run.id, thresholds.highTtfbMs]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} URL(s) exceeded ${thresholds.highTtfbMs}ms TTFB in the stored crawl measurement.` : `No stored page TTFB exceeded ${thresholds.highTtfbMs}ms.`,
      recommendation: affectedCount ? 'Treat TTFB as volatile: confirm with repeated measurements or a follow-up run before prioritizing infrastructure work.' : 'No TTFB action from the stored crawl data.',
      details: 'Based on the stored crawl TTFB value. Network timing is volatile and should be confirmed with repeated measurements for final decisions.',
      evidence: {
        thresholdMs: thresholds.highTtfbMs,
        measurementType: 'single_crawl_ttfb_ms',
        volatility: 'network_timing',
        suggestedValidation: 'repeat_measurements_or_follow_up_run',
        samples: rows
      },
      findingType: 'best_practice',
      confidence: affectedCount > 3 ? 'medium' : affectedCount ? 'low' : 'high',
      reviewRecommended: affectedCount > 0
    });
  }, { priority: 'Medium', effort: 'M' });
}

function headerPresence(id, category, name, headerKey, priority = 'Medium', options = {}) {
  return tech(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const where = `${HTML_WHERE} AND (responseHeadersJson IS NULL OR responseHeadersJson NOT LIKE ?)`;
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id, `%"${headerKey}"%`]);
    const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, where, [`%"${headerKey}"%`]) : [];
    return makeResult(this, checkStatusForCoverage(total, affectedCount, 'Warning'), {
      affectedCount,
      sampleUrls: samples,
      finding: total
        ? affectedCount
          ? (typeof options.missingFinding === 'function' ? options.missingFinding(affectedCount, total) : `${affectedCount}/${total} HTML page(s) are missing ${headerKey}.`)
          : (options.okFinding || `HTML pages include ${headerKey}.`)
        : 'No HTML pages stored.',
      recommendation: options.recommendation || `Review whether the ${headerKey} header should be sent for HTML responses.`,
      evidence: { totalHtmlPages: total, missingHeaderPages: affectedCount, headerKey, sampleUrls: samples },
      findingType: options.findingType || (category === 'Security Best Practice' ? 'best_practice' : undefined),
      confidence: 'high'
    });
  }, { priority, effort: 'M' });
}

function httpVersionSupport() {
  return tech('http_version_support', 'Server/Performance Best Practice', 'HTTP protocol version evidence', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, responseHeadersJson, featureFlagsJson
      FROM pages
      WHERE runId = ? AND (
        COALESCE(responseHeadersJson, '') LIKE '%x-http-version%' OR
        COALESCE(featureFlagsJson, '') LIKE '%httpVersion%'
      )
      LIMIT 20
    `, [ctx.run.id]);
    if (!rows.length) {
      return makeResult(this, 'NA', {
        finding: 'No HTTP protocol version data is stored for this run.',
        recommendation: 'Import a Requests/Screaming-Frog header export or capture protocol metadata before judging HTTP/2 or HTTP/3 coverage.',
        evidence: { requiredData: ['protocol_version', 'response_headers'] },
        findingType: 'info',
        confidence: 'high'
      });
    }
    const weak = rows.filter((row) => !/h2|http\/2|http\/3|h3/i.test(`${row.responseHeadersJson || ''} ${row.featureFlagsJson || ''}`));
    return makeResult(this, weak.length ? 'Warning' : 'OK', {
      affectedCount: weak.length,
      sampleUrls: weak.map((row) => row.url).slice(0, 10),
      finding: weak.length
        ? `${weak.length} sampled page(s) have protocol evidence but no HTTP/2+/HTTP/3 signal.`
        : 'Stored protocol evidence includes HTTP/2+/HTTP/3 signals where available.',
      recommendation: 'Verify protocol support with request-level tooling before using this as a final infrastructure finding.',
      evidence: { checkedRows: rows.length, samples: rows.slice(0, 10) },
      findingType: 'best_practice',
      confidence: 'medium',
      reviewRecommended: weak.length > 0
    });
  }, { priority: 'Low', effort: 'S' });
}

function cdnCacheSignals() {
  return tech('cdn_cache_signals', 'Server/Performance Best Practice', 'CDN/cache header signals', function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const rows = all(ctx.db, `
      SELECT url, responseHeadersJson
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
        AND COALESCE(responseHeadersJson, '') <> ''
      LIMIT 50
    `, [ctx.run.id]);
    if (!rows.length) {
      return makeResult(this, total ? 'NA' : 'NA', {
        finding: 'No compact response header data is stored for CDN/cache assessment.',
        recommendation: 'Store response headers or import SF/Requests headers to evaluate cache/CDN patterns.',
        evidence: { totalHtmlPages: total, requiredHeaders: ['cache-control', 'age', 'via', 'x-cache', 'cf-cache-status', 'x-azure-ref', 'server'] },
        findingType: 'info'
      });
    }
    const signalRows = rows.filter((row) => /cache-control|age|via|x-cache|cf-cache-status|x-azure-ref|x-served-by|cloudflare|akamai|fastly|azure/i.test(row.responseHeadersJson || ''));
    const status = signalRows.length ? 'OK' : 'Warning';
    return makeResult(this, status, {
      affectedCount: status === 'OK' ? 0 : total,
      sampleUrls: status === 'OK' ? [] : rows.slice(0, 10).map((row) => row.url),
      finding: signalRows.length
        ? `${signalRows.length}/${rows.length} sampled HTML page(s) include CDN/cache header signals.`
        : 'Stored headers do not show CDN/cache signals in the sampled HTML responses.',
      recommendation: 'Use this as technical evidence only; validate CDN architecture and cache policy with header exports or infrastructure data.',
      evidence: { sampledHeaderRows: rows.length, signalRows: signalRows.slice(0, 10) },
      findingType: 'best_practice',
      confidence: rows.length >= 10 ? 'medium' : 'low',
      reviewRecommended: true
    });
  }, { priority: 'Low', effort: 'S' });
}

function xRobotsTagCheck() {
  return tech('x_robots_tag_unusual', 'Server & Infrastructure', 'x-robots-tag present/auffaellig', function run(ctx) {
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count FROM pages
      WHERE runId = ? AND xRobotsTag IS NOT NULL AND xRobotsTag <> ''
        AND LOWER(xRobotsTag) GLOB '*noindex*'
        AND ${NON_LEGAL_PAGE_WHERE}
    `, [ctx.run.id]);
    const legalNoindexCount = count(ctx.db, `
      SELECT COUNT(*) AS count FROM pages
      WHERE runId = ? AND xRobotsTag IS NOT NULL AND xRobotsTag <> ''
        AND LOWER(xRobotsTag) GLOB '*noindex*'
        AND ${LEGAL_PAGE_WHERE}
    `, [ctx.run.id]);
    const present = count(ctx.db, "SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND xRobotsTag IS NOT NULL AND xRobotsTag <> ''", [ctx.run.id]);
    const samples = affectedCount
      ? sampleUrls(ctx.db, ctx.run.id, `xRobotsTag IS NOT NULL AND LOWER(xRobotsTag) LIKE "%noindex%" AND ${NON_LEGAL_PAGE_WHERE}`)
      : [];
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: samples,
      finding: affectedCount
        ? `${affectedCount} non-legal page(s) have auffaellige X-Robots-Tag noindex values.`
        : legalNoindexCount
          ? `${present} page(s) include X-Robots-Tag; only legal noindex values were detected.`
          : `${present} page(s) include X-Robots-Tag; no noindex value detected.`,
      recommendation: 'Verify that X-Robots-Tag directives match indexing intent.',
      evidence: { presentCount: present, contentNoindexCount: affectedCount, legalNoindexCount, sampleUrls: samples },
      findingType: affectedCount ? 'core_issue' : 'info'
    });
  });
}

function contentTypeHtmlCheck() {
  return tech('content_type_html_correct', 'Server & Infrastructure', 'Content-Type HTML korrekt', function run(ctx) {
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count FROM pages
      WHERE runId = ? AND (contentType IS NULL OR (${HTML_WHERE}) = 0)
    `, [ctx.run.id]);
    const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, `(contentType IS NULL OR (${HTML_WHERE}) = 0)`) : [];
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: samples,
      finding: affectedCount ? `${affectedCount} queued page URL(s) returned non-HTML content types.` : 'Stored page responses use HTML content types.',
      recommendation: 'Avoid queueing non-HTML URLs as crawl pages; serve HTML pages with text/html or application/xhtml+xml.',
      evidence: { affectedCount, sampleUrls: samples }
    });
  }, { priority: 'Low', effort: 'S' });
}

function charsetUtf8Check() {
  return tech('charset_utf8_present', 'Server & Infrastructure', 'Charset UTF-8 present', function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const where = `${HTML_WHERE}
      AND COALESCE(hasHeaderUtf8, 0) = 0
      AND COALESCE(hasMetaCharsetUtf8, 0) = 0`;
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id]);
    const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, where) : [];
    return makeResult(this, checkStatusForCoverage(total, affectedCount, 'Warning'), {
      affectedCount,
      sampleUrls: samples,
      finding: total ? `${affectedCount}/${total} HTML page(s) have no UTF-8 signal in the HTTP header or HTML meta charset.` : 'No HTML pages stored.',
      recommendation: 'Declare UTF-8 via the HTTP Content-Type header or an HTML meta charset.',
      details: 'The check treats either an HTTP Content-Type UTF-8 charset or a HTML meta charset UTF-8 declaration as sufficient evidence.',
      evidence: { totalHtmlPages: total, affectedCount, sampleUrls: samples, acceptedSignals: ['http_content_type_charset_utf8', 'html_meta_charset_utf8'] },
      findingType: 'best_practice',
      confidence: 'high'
    });
  }, { priority: 'Low', effort: 'S' });
}

function robotsTxtPresent() {
  return tech('robots_txt_present', 'Crawling & Indexing', 'robots.txt vorhanden', function run(ctx) {
    const asset = ctx.db.prepare("SELECT * FROM domain_assets WHERE runId = ? AND type = 'robots' ORDER BY id DESC LIMIT 1").get(ctx.run.id);
    const ok = asset && asset.statusCode >= 200 && asset.statusCode < 300;
    return makeResult(this, ok ? 'OK' : 'Warning', {
      affectedCount: ok ? 0 : 1,
      finding: ok ? 'robots.txt was fetched successfully.' : 'robots.txt was not fetched with a 2xx status.',
      recommendation: 'Provide a robots.txt file at the canonical origin.',
      evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null }
    });
  });
}

function sitemapPresent() {
  return tech('sitemap_present', 'Crawling & Indexing', 'Sitemap vorhanden', function run(ctx) {
    const rows = all(ctx.db, "SELECT url, statusCode FROM domain_assets WHERE runId = ? AND type = 'sitemap'", [ctx.run.id]);
    const okRows = rows.filter((row) => row.statusCode >= 200 && row.statusCode < 300);
    return makeResult(this, okRows.length ? 'OK' : 'Warning', {
      affectedCount: okRows.length ? 0 : 1,
      finding: okRows.length ? `${okRows.length} sitemap asset(s) returned 2xx.` : 'No sitemap asset returned 2xx.',
      recommendation: 'Expose an XML sitemap and reference it from robots.txt.',
      evidence: { sitemaps: rows }
    });
  });
}

function sitemapInRobots() {
  return tech('sitemap_in_robots', 'Crawling & Indexing', 'Sitemap in robots.txt referenziert', function run(ctx) {
    const asset = ctx.db.prepare("SELECT * FROM domain_assets WHERE runId = ? AND type = 'robots' ORDER BY id DESC LIMIT 1").get(ctx.run.id);
    const hasReference = /(^|\n)\s*sitemap\s*:/i.test(asset?.content || '');
    return makeResult(this, hasReference ? 'OK' : 'Warning', {
      affectedCount: hasReference ? 0 : 1,
      finding: hasReference ? 'robots.txt references at least one sitemap.' : 'robots.txt does not reference a sitemap.',
      recommendation: 'Add Sitemap directives to robots.txt.',
      evidence: { robotsUrl: asset?.url, statusCode: asset?.statusCode ?? null, hasReference }
    });
  }, { priority: 'Low' });
}

function sitemapUrlsNon200() {
  return tech('sitemap_urls_non_200', 'Crawling & Indexing', 'Sitemap URLs with non-200 status', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT p.url, p.statusCode
      FROM pages p
      JOIN crawl_queue q ON q.runId = p.runId AND q.normalizedUrl = p.normalizedUrl
      WHERE p.runId = ? AND q.sourceType IN ('sitemap', 'robots_sitemap') AND COALESCE(p.statusCode, 0) <> 200
      ORDER BY p.id
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages p
      JOIN crawl_queue q ON q.runId = p.runId AND q.normalizedUrl = p.normalizedUrl
      WHERE p.runId = ? AND q.sourceType IN ('sitemap', 'robots_sitemap') AND COALESCE(p.statusCode, 0) <> 200
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} sitemap URL(s) did not return 200.` : 'Crawled sitemap URLs returned 200.',
      recommendation: 'Remove or fix sitemap URLs that do not return 200.',
      evidence: { affectedCount, samples: rows }
    });
  });
}

function noindexPagesCheck() {
  return tech('noindex_pages', 'Crawling & Indexing', 'noindex pages present', function run(ctx) {
    const totalHtmlPages = htmlPageCount(ctx.db, ctx.run.id);
    const directiveWhere = `${HTML_WHERE} AND (COALESCE(noindex, 0) = 1 OR ${ROBOTS_TEXT_EXPR} LIKE '%noindex%')`;
    const contentWhere = `${directiveWhere} AND ${NON_LEGAL_PAGE_WHERE}`;
    const legalWhere = `${directiveWhere} AND ${LEGAL_PAGE_WHERE}`;
    const contentNoindexCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${contentWhere}`, [ctx.run.id]);
    const legalNoindexCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${legalWhere}`, [ctx.run.id]);
    const samples = contentNoindexCount ? sampleUrls(ctx.db, ctx.run.id, contentWhere) : [];
    const status = !totalHtmlPages ? 'NA' : contentNoindexCount ? 'Warning' : 'OK';
    return makeResult(this, status, {
      affectedCount: contentNoindexCount,
      sampleUrls: samples,
      finding: contentNoindexCount
        ? `${contentNoindexCount} non-legal HTML page(s) carry noindex.`
        : legalNoindexCount
          ? `Only legal page noindex directives were detected (${legalNoindexCount} page(s)).`
          : 'No HTML page has a noindex directive.',
      recommendation: 'Keep noindex on legal/utility pages only when intentional; review noindex on indexable content pages.',
      details: 'Legal pages are counted separately and are not treated as core crawling warnings.',
      evidence: { totalHtmlPages, contentNoindexCount, legalNoindexCount, sampleUrls: samples },
      findingType: contentNoindexCount ? 'core_issue' : 'info',
      confidence: 'high'
    });
  }, { priority: 'Medium', effort: 'S' });
}

function nofollowPagesCheck() {
  return tech('nofollow_pages', 'Crawling & Indexing', 'nofollow pages present', function run(ctx) {
    const totalHtmlPages = htmlPageCount(ctx.db, ctx.run.id);
    const directiveWhere = `${HTML_WHERE} AND (COALESCE(nofollow, 0) = 1 OR ${ROBOTS_TEXT_EXPR} LIKE '%nofollow%')`;
    const contentWhere = `${directiveWhere} AND ${NON_LEGAL_PAGE_WHERE}`;
    const legalWhere = `${directiveWhere} AND ${LEGAL_PAGE_WHERE}`;
    const contentNofollowCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${contentWhere}`, [ctx.run.id]);
    const legalNofollowCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${legalWhere}`, [ctx.run.id]);
    const samples = contentNofollowCount ? sampleUrls(ctx.db, ctx.run.id, contentWhere) : [];
    const status = !totalHtmlPages ? 'NA' : contentNofollowCount ? 'Warning' : 'OK';
    return makeResult(this, status, {
      affectedCount: contentNofollowCount,
      sampleUrls: samples,
      finding: contentNofollowCount
        ? `${contentNofollowCount} non-legal HTML page(s) carry nofollow.`
        : legalNofollowCount
          ? `Only legal page nofollow directives were detected (${legalNofollowCount} page(s)).`
          : 'No HTML page has a nofollow directive.',
      recommendation: 'Use page-level nofollow only where link discovery should intentionally be limited.',
      details: 'Legal pages are counted separately and are not treated as core crawling warnings.',
      evidence: { totalHtmlPages, contentNofollowCount, legalNofollowCount, sampleUrls: samples },
      findingType: contentNofollowCount ? 'core_issue' : 'info',
      confidence: 'high'
    });
  }, { priority: 'Low', effort: 'S' });
}

function missingField(id, category, name, field, status = 'Warning', priority = 'Medium') {
  return pageStatusCheck(id, category, name, `${HTML_WHERE} AND (${field} IS NULL OR ${field} = '')`, status, priority);
}

function lengthCheck(id, category, name, where, status = 'Warning', priority = 'Medium') {
  return pageStatusCheck(id, category, name, `${HTML_WHERE} AND ${where}`, status, priority);
}

function canonicalMissing() {
  return pageStatusCheck('canonical_missing', 'Crawling & Indexing', 'Canonical missing', `${INDEXABLE_CONTENT_HTML_WHERE} AND (canonical IS NULL OR canonical = '')`, 'Warning');
}

function contentMissingField(id, category, name, field, status = 'Warning', priority = 'Medium') {
  return pageStatusCheck(id, category, name, `${INDEXABLE_CONTENT_HTML_WHERE} AND (${field} IS NULL OR ${field} = '')`, status, priority);
}

function contentLengthCheck(id, category, name, where, status = 'Warning', priority = 'Medium') {
  return pageStatusCheck(id, category, name, `${INDEXABLE_CONTENT_HTML_WHERE} AND ${where}`, status, priority);
}

function duplicateField(id, category, name, field, status = 'Warning', priority = 'Medium') {
  return tech(id, category, name, function run(ctx) {
    const groups = all(ctx.db, `
      SELECT ${field} AS value, COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE} AND ${field} IS NOT NULL AND ${field} <> ''
      GROUP BY LOWER(${field})
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = groups.reduce((sum, row) => sum + row.count, 0);
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      finding: affectedCount ? `${affectedCount} URLs share duplicate ${field} values.` : `No duplicate ${field} values found.`,
      recommendation: `Make ${field} values unique where pages target different intents.`,
      evidence: { duplicateGroups: groups }
    });
  }, { priority });
}

function duplicateContentField(id, category, name, field, status = 'Warning', priority = 'Medium') {
  return tech(id, category, name, function run(ctx) {
    const groups = all(ctx.db, `
      SELECT ${field} AS value, COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${INDEXABLE_CONTENT_HTML_WHERE} AND ${field} IS NOT NULL AND ${field} <> ''
      GROUP BY LOWER(${field})
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = groups.reduce((sum, row) => sum + row.count, 0);
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      finding: affectedCount ? `${affectedCount} indexable content URLs share duplicate ${field} values.` : `No duplicate ${field} values found on indexable content pages.`,
      recommendation: `Make ${field} values unique where indexable content pages target different intents.`,
      details: 'Legal/noindex/non-content pages are excluded from this duplicate check.',
      evidence: { duplicateGroups: groups, scope: 'indexable_non_legal_html_pages' }
    });
  }, { priority });
}

function openGraphMissing() {
  return tech('open_graph_basics_missing', 'HTML Head & Meta', 'Open Graph basics missing', function run(ctx) {
    const where = `${INDEXABLE_CONTENT_HTML_WHERE} AND (
      ogJson IS NULL OR
      ogJson NOT LIKE '%"og:title":"%' OR
      ogJson NOT LIKE '%"og:description":"%' OR
      ogJson NOT LIKE '%"og:image":"%' OR
      ogJson NOT LIKE '%"og:url":"%' OR
      ogJson NOT LIKE '%"og:type":"%'
    )`;
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id]);
    const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, where) : [];
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: samples,
      finding: affectedCount ? `${affectedCount} page(s) miss one or more Open Graph basics.` : 'Open Graph basics are present on crawled HTML pages.',
      recommendation: 'Add og:title, og:description, og:image, og:url and og:type where social previews matter.',
      evidence: { affectedCount, sampleUrls: samples }
    });
  }, { priority: 'Low' });
}

function appIconsIncomplete() {
  return tech('app_icons_incomplete', 'Browser Metadata Opportunity', 'Favicon/App icon signals incomplete', function run(ctx) {
    const candidates = all(ctx.db, `
      SELECT url, favicon, manifest, featureFlagsJson
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
      LIMIT 500
    `, [ctx.run.id]);
    const affected = candidates.filter((row) => {
      const flags = safeJson(row.featureFlagsJson, {});
      return !row.favicon || Number(flags.appleTouchIconCount || 0) <= 0;
    });
    const rows = affected.slice(0, 10);
    const affectedCount = affected.length;
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} page(s) have incomplete favicon/app icon signals.` : 'Favicon/app icon signals are present where checked.',
      recommendation: 'Provide favicon and Apple touch/app icon signals for robust browser and sharing metadata.',
      evidence: { samples: rows },
      findingType: 'best_practice',
      confidence: 'medium'
    });
  }, { priority: 'Low', effort: 'S' });
}

function hreflangXDefaultMissing() {
  return tech('hreflang_x_default_missing', 'HTML Head & Meta', 'Hreflang x-default missing when hreflang exists', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, featureFlagsJson
      FROM pages
      WHERE runId = ? AND COALESCE(featureFlagsJson, '') LIKE '%hreflang%'
      LIMIT 50
    `, [ctx.run.id]);
    const hreflangRows = rows.filter((row) => {
      const flags = safeJson(row.featureFlagsJson, {});
      return Number(flags.hreflangCount || 0) > 0 || (flags.hreflangLanguages || []).length > 0;
    });
    if (!hreflangRows.length) {
      return makeResult(this, 'NA', {
        finding: 'No hreflang data is stored for this run.',
        recommendation: 'Import Screaming Frog hreflang exports or crawl pages with hreflang extraction before evaluating internationalisation.',
        evidence: { requiredData: ['hreflang_export', 'html_head'] },
        findingType: 'info'
      });
    }
    const missing = hreflangRows.filter((row) => !safeJson(row.featureFlagsJson, {}).hasHreflangXDefault);
    return makeResult(this, missing.length ? 'Warning' : 'OK', {
      affectedCount: missing.length,
      sampleUrls: missing.slice(0, 10).map((row) => row.url),
      finding: missing.length
        ? `${missing.length}/${hreflangRows.length} page(s) with hreflang signals have no x-default signal.`
        : 'Stored hreflang signals include x-default where detected.',
      recommendation: 'Review hreflang clusters and return links in SF before final internationalisation recommendations.',
      evidence: { hreflangRows: hreflangRows.length, missingSamples: missing.slice(0, 10) },
      findingType: 'best_practice',
      confidence: 'medium',
      reviewRecommended: true
    });
  }, { priority: 'Low', effort: 'M' });
}

function consentTechnicalSignals() {
  return tech('consent_technical_signals', 'Consent/Privacy Technical Review', 'Consent and tag-manager technical signals', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, featureFlagsJson
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
      LIMIT 500
    `, [ctx.run.id]);
    if (!rows.length) {
      return makeResult(this, 'NA', {
        finding: 'No HTML pages are stored for consent technical signal detection.',
        recommendation: 'Run a crawl or import rendered/JavaScript facts before reviewing consent implementation.',
        evidence: {}
      });
    }
    const parsed = rows.map((row) => ({ url: row.url, flags: safeJson(row.featureFlagsJson, {}) }));
    const cmpRows = parsed.filter((row) => row.flags.hasConsentSignal || (row.flags.consentVendorSignals || []).length);
    const tagRows = parsed.filter((row) => row.flags.hasGoogleTagManager || row.flags.hasGtag || row.flags.hasDataLayer || row.flags.hasMetaPixel);
    const status = tagRows.length && !cmpRows.length ? 'Warning' : cmpRows.length ? 'OK' : 'Warning';
    return makeResult(this, status, {
      affectedCount: status === 'OK' ? 0 : Math.max(1, tagRows.length || rows.length),
      sampleUrls: (tagRows.length ? tagRows : parsed).slice(0, 10).map((row) => row.url),
      finding: cmpRows.length
        ? `${cmpRows.length} sampled page(s) show CMP/consent technical signals; ${tagRows.length} show tag-manager/marketing signals.`
        : tagRows.length
          ? `${tagRows.length} sampled page(s) show tag-manager/marketing signals, but no CMP/consent signal was detected in stored HTML.`
          : 'No CMP or tag-manager technical signals detected in stored HTML.',
      recommendation: 'Treat this as technical detection only. Legal/GDPR assessment requires human review and consent-mode verification.',
      evidence: {
        sampledPages: rows.length,
        consentSignalSamples: cmpRows.slice(0, 10),
        tagSignalSamples: tagRows.slice(0, 10),
        legalJudgment: 'needs_human_review'
      },
      findingType: 'best_practice',
      confidence: 'medium',
      reviewRecommended: true
    });
  }, { priority: 'Low', effort: 'M' });
}

function canonicalOtherDomain() {
  return tech('canonical_to_other_domain', 'Crawling & Indexing', 'Canonical to other domain', function run(ctx) {
    const host = new URL(ctx.project.finalDomain).hostname.replace(/^www\./, '');
    const where = `${HTML_WHERE} AND canonical IS NOT NULL AND canonical <> '' AND
      canonical NOT LIKE 'https://${host}%' AND canonical NOT LIKE 'http://${host}%' AND
      canonical NOT LIKE 'https://www.${host}%' AND canonical NOT LIKE 'http://www.${host}%'`;
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id]);
    const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, where) : [];
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: samples,
      finding: affectedCount ? `${affectedCount} page(s) canonicalize to another domain.` : 'No cross-domain canonicals found.',
      recommendation: 'Verify cross-domain canonicals are intentional.',
      evidence: { affectedCount, sampleUrls: samples, acceptedHost: host }
    });
  });
}

function canonicalTargetNon200() {
  return tech('canonical_target_non_200', 'Crawling & Indexing', 'Canonical target non-200 if known', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT source.url, source.canonical, target.statusCode
      FROM pages source
      JOIN pages target ON target.runId = source.runId AND target.normalizedUrl = source.canonical
      WHERE source.runId = ? AND source.canonical IS NOT NULL AND COALESCE(target.statusCode, 0) <> 200
      ORDER BY source.id
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages source
      JOIN pages target ON target.runId = source.runId AND target.normalizedUrl = source.canonical
      WHERE source.runId = ? AND source.canonical IS NOT NULL AND COALESCE(target.statusCode, 0) <> 200
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} known canonical target(s) are non-200.` : 'Known canonical targets are 200.',
      recommendation: 'Point canonicals to indexable 200 URLs.',
      evidence: { samples: rows }
    });
  });
}

function internalLinksToStatus(id, name, targetWhere, status = 'Warning', priority = 'Medium') {
  return tech(id, 'Crawling & Indexing', name, function run(ctx) {
    const rows = all(ctx.db, `
      SELECT l.sourceUrl AS url, l.targetUrl, p.statusCode
      FROM page_links l
      JOIN pages p ON p.runId = l.runId AND p.normalizedUrl = l.normalizedTargetUrl
      WHERE l.runId = ? AND l.linkType = 'internal' AND ${targetWhere}
      ORDER BY l.id
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_links l
      JOIN pages p ON p.runId = l.runId AND p.normalizedUrl = l.normalizedTargetUrl
      WHERE l.runId = ? AND l.linkType = 'internal' AND ${targetWhere}
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} internal link(s) point to matching target status.` : 'No matching internal link targets found among crawled pages.',
      recommendation: 'Update internal links to point directly to 200 destinations.',
      evidence: { samples: rows }
    });
  }, { priority });
}

function orphanLikeSitemapUrls() {
  return tech('orphan_like_sitemap_urls', 'Crawling & Indexing', 'Orphan-like sitemap URLs without internal links', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT p.url
      FROM pages p
      JOIN crawl_queue q ON q.runId = p.runId AND q.normalizedUrl = p.normalizedUrl
      LEFT JOIN page_links l ON l.runId = p.runId AND l.normalizedTargetUrl = p.normalizedUrl AND l.linkType = 'internal'
      WHERE p.runId = ? AND q.sourceType IN ('sitemap', 'robots_sitemap') AND l.id IS NULL
      ORDER BY p.id
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages p
      JOIN crawl_queue q ON q.runId = p.runId AND q.normalizedUrl = p.normalizedUrl
      LEFT JOIN page_links l ON l.runId = p.runId AND l.normalizedTargetUrl = p.normalizedUrl AND l.linkType = 'internal'
      WHERE p.runId = ? AND q.sourceType IN ('sitemap', 'robots_sitemap') AND l.id IS NULL
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} sitemap URL(s) have no observed internal inlinks.` : 'Crawled sitemap URLs have observed internal inlinks where detectable.',
      recommendation: 'Review XML-only URLs and add crawlable internal links where they should be discoverable.',
      evidence: { affectedCount, sampleUrls: rows.map((row) => row.url) }
    });
  }, { priority: 'Low' });
}

function resourceCountCheck(id, category, name, resourceType, threshold, status = 'Warning') {
  return tech(id, category, name, function run(ctx) {
    const rows = all(ctx.db, `
      SELECT pageUrl AS url, COUNT(*) AS count
      FROM resources
      WHERE runId = ? AND resourceType = ?
      GROUP BY pageUrl
      HAVING COUNT(*) > ?
      ORDER BY count DESC
      LIMIT 10
    `, [ctx.run.id, resourceType, threshold]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT pageUrl
        FROM resources
        WHERE runId = ? AND resourceType = ?
        GROUP BY pageUrl
        HAVING COUNT(*) > ?
      )
    `, [ctx.run.id, resourceType, threshold]);
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} page(s) exceed the browser-captured ${resourceType} resource threshold.` : `No page exceeds ${threshold} browser-captured ${resourceType} resources.`,
      recommendation: 'Reduce, defer or consolidate resources where possible.',
      details: 'Based on captured browser/network resource rows, not only static HTML tags.',
      evidence: { threshold, resourceType, basis: 'browser_captured_resources', samples: rows }
    });
  });
}

function resourceBytesCheck(id, category, name, resourceType, threshold, status = 'Warning') {
  return tech(id, category, name, function run(ctx) {
    const rows = all(ctx.db, `
      SELECT pageUrl AS url, SUM(sizeBytes) AS totalBytes, COUNT(*) AS knownResources
      FROM resources
      WHERE runId = ? AND resourceType = ? AND sizeBytes IS NOT NULL
      GROUP BY pageUrl
      HAVING SUM(sizeBytes) > ?
      ORDER BY totalBytes DESC
      LIMIT 10
    `, [ctx.run.id, resourceType, threshold]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT pageUrl
        FROM resources
        WHERE runId = ? AND resourceType = ? AND sizeBytes IS NOT NULL
        GROUP BY pageUrl
        HAVING SUM(sizeBytes) > ?
      )
    `, [ctx.run.id, resourceType, threshold]);
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} page(s) exceed known ${resourceType} byte totals.` : `No page exceeds known ${resourceType} byte threshold.`,
      recommendation: 'Audit large resources and reduce transfer size.',
      evidence: { thresholdBytes: threshold, resourceType, samples: rows }
    });
  });
}

function thirdPartyScripts() {
  return tech('third_party_scripts_detected', 'Performance Light', 'Third-party scripts detected', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT pageUrl AS url, COUNT(*) AS thirdPartyScripts
      FROM resources
      WHERE runId = ? AND resourceType = 'script' AND isThirdParty = 1
      GROUP BY pageUrl
      ORDER BY thirdPartyScripts DESC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT pageUrl
        FROM resources
        WHERE runId = ? AND resourceType = 'script' AND isThirdParty = 1
        GROUP BY pageUrl
      )
    `, [ctx.run.id]);
    return makeResult(this, rows.length ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? `${rows.length} page(s) load third-party scripts.` : 'No third-party scripts detected in stored resources.',
      recommendation: 'Review third-party scripts for performance, privacy and necessity.',
      evidence: { samples: rows }
    });
  }, { priority: 'Low' });
}

function preloadMissing() {
  return tech('preload_missing', 'Performance Light', 'Preload missing when resource signals are strong', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT p.url, COUNT(r.id) AS resources
      FROM pages p
      JOIN resources r ON r.runId = p.runId AND r.pageUrl = p.finalUrl
      WHERE p.runId = ? AND r.resourceType IN ('script', 'stylesheet', 'font')
        AND COALESCE(p.featureFlagsJson, '') NOT LIKE '%"hasPreload":true%'
      GROUP BY p.url
      HAVING COUNT(r.id) > 10
      ORDER BY resources DESC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT p.url
        FROM pages p
        JOIN resources r ON r.runId = p.runId AND r.pageUrl = p.finalUrl
        WHERE p.runId = ? AND r.resourceType IN ('script', 'stylesheet', 'font')
          AND COALESCE(p.featureFlagsJson, '') NOT LIKE '%"hasPreload":true%'
        GROUP BY p.url
        HAVING COUNT(r.id) > 10
      )
    `, [ctx.run.id]);
    return makeResult(this, rows.length ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? `${rows.length} page(s) have many resources and no stored preload hint.` : 'No strong preload-missing signal detected.',
      recommendation: 'Consider preload only for critical resources validated by performance testing.',
      evidence: { samples: rows }
    });
  }, { priority: 'Low' });
}

function preconnectMissing() {
  return tech('preconnect_missing', 'Performance Light', 'Preconnect missing for external font/CDN origins', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT p.url, COUNT(r.id) AS thirdPartyResources
      FROM pages p
      JOIN resources r ON r.runId = p.runId AND r.pageUrl = p.finalUrl
      WHERE p.runId = ? AND r.isThirdParty = 1 AND r.resourceType IN ('script', 'stylesheet', 'font')
        AND COALESCE(p.featureFlagsJson, '') NOT LIKE '%"hasPreconnect":true%'
      GROUP BY p.url
      ORDER BY thirdPartyResources DESC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT p.url
        FROM pages p
        JOIN resources r ON r.runId = p.runId AND r.pageUrl = p.finalUrl
        WHERE p.runId = ? AND r.isThirdParty = 1 AND r.resourceType IN ('script', 'stylesheet', 'font')
          AND COALESCE(p.featureFlagsJson, '') NOT LIKE '%"hasPreconnect":true%'
        GROUP BY p.url
      )
    `, [ctx.run.id]);
    return makeResult(this, rows.length ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? `${rows.length} page(s) use external resources without stored preconnect/dns-prefetch hints.` : 'No preconnect-missing signal detected.',
      recommendation: 'Consider preconnect or dns-prefetch for critical third-party origins only.',
      evidence: { samples: rows }
    });
  }, { priority: 'Low' });
}

function resourceHintsSummary() {
  return tech('resource_hints_summary', 'Performance Light', 'Resource hint coverage summary', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, featureFlagsJson
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
      LIMIT 500
    `, [ctx.run.id]);
    if (!rows.length) {
      return makeResult(this, 'NA', {
        finding: 'No HTML pages are stored for resource hint assessment.',
        recommendation: 'Run a crawl or import HTML-head/resource-hint facts.',
        evidence: {}
      });
    }
    const parsed = rows.map((row) => ({ url: row.url, flags: safeJson(row.featureFlagsJson, {}) }));
    const withHints = parsed.filter((row) => {
      const counts = row.flags.resourceHintCounts || {};
      return row.flags.hasPreload || row.flags.hasPreconnect || Number(counts.preload || 0) || Number(counts.preconnect || 0) || Number(counts.dnsPrefetch || 0) || Number(counts.prefetch || 0);
    });
    return makeResult(this, withHints.length ? 'OK' : 'Warning', {
      affectedCount: withHints.length ? 0 : rows.length,
      sampleUrls: withHints.length ? [] : rows.slice(0, 10).map((row) => row.url),
      finding: withHints.length
        ? `${withHints.length}/${rows.length} sampled page(s) include preload/preconnect/dns-prefetch/prefetch signals.`
        : 'No resource hint signals detected in sampled pages.',
      recommendation: 'Use resource hints only for validated critical origins/assets; confirm with Lighthouse/field data before prioritizing.',
      evidence: { sampledPages: rows.length, withHints: withHints.slice(0, 10) },
      findingType: 'best_practice',
      confidence: 'medium'
    });
  }, { priority: 'Low', effort: 'S' });
}

function importedResourcePerformanceSignals() {
  return tech('imported_resource_performance_signals', 'Performance Light', 'Imported JS/CSS resource performance signals', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url, featureFlagsJson
      FROM pages
      WHERE runId = ? AND COALESCE(featureFlagsJson, '') <> ''
      LIMIT 1000
    `, [ctx.run.id]);
    const parsed = rows.map((row) => ({ url: row.url, flags: safeJson(row.featureFlagsJson, {}) }));
    const withImportedMetrics = parsed.filter((row) =>
      Number(row.flags.jsCount || 0) ||
      Number(row.flags.cssCount || 0) ||
      Number(row.flags.totalJsBytes || 0) ||
      Number(row.flags.totalCssBytes || 0)
    );
    if (!withImportedMetrics.length) {
      return makeResult(this, 'NA', {
        finding: 'No imported JS/CSS count or byte metrics are available.',
        recommendation: 'Import SF JavaScript/rendered/resource exports or run browser sampling before evaluating JS/CSS totals at enterprise scale.',
        evidence: { requiredData: ['resource_facts', 'sf_javascript_rendered_export'] },
        findingType: 'info'
      });
    }
    const heavy = withImportedMetrics.filter((row) =>
      Number(row.flags.jsCount || 0) > thresholds.tooManyJsResources ||
      Number(row.flags.cssCount || 0) > thresholds.tooManyCssResources ||
      Number(row.flags.totalJsBytes || 0) > thresholds.largeJsTotalBytes ||
      Number(row.flags.totalCssBytes || 0) > thresholds.largeCssTotalBytes
    );
    return makeResult(this, heavy.length ? 'Warning' : 'OK', {
      affectedCount: heavy.length,
      sampleUrls: heavy.slice(0, 10).map((row) => row.url),
      finding: heavy.length
        ? `${heavy.length}/${withImportedMetrics.length} page(s) exceed imported JS/CSS count or byte thresholds.`
        : 'Imported JS/CSS metrics do not exceed configured thresholds.',
      recommendation: 'Use imported SF/browser resource metrics to prioritize template-level JS/CSS optimization.',
      evidence: { thresholds: {
        tooManyJsResources: thresholds.tooManyJsResources,
        tooManyCssResources: thresholds.tooManyCssResources,
        largeJsTotalBytes: thresholds.largeJsTotalBytes,
        largeCssTotalBytes: thresholds.largeCssTotalBytes
      }, samples: heavy.slice(0, 10) },
      findingType: 'best_practice',
      confidence: 'medium'
    });
  }, { priority: 'Medium', effort: 'M' });
}

function consoleErrorsPresent() {
  return tech('console_errors_present', 'JavaScript & Rendering', 'Console errors present', function run(ctx) {
    const where = `consoleErrorsJson IS NOT NULL AND consoleErrorsJson <> '[]'`;
    const rows = all(ctx.db, `SELECT url, consoleErrorsJson FROM pages WHERE runId = ? AND ${where} LIMIT 10`, [ctx.run.id]);
    return makeResult(this, rows.length ? 'Warning' : 'OK', {
      affectedCount: count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id]),
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? 'Console errors were captured during Playwright rendering.' : 'No console errors captured during rendering.',
      recommendation: 'Review rendering errors that may affect indexable content or UX.',
      evidence: { samples: rows.map((row) => ({ url: row.url, errors: safeJson(row.consoleErrorsJson, []) })) }
    });
  });
}

function templateLowLighthousePerformance() {
  return tech('template.low_lighthouse_performance', 'Template Performance & Rendering', 'Template Lighthouse performance low', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.lighthouseEnabled || !data.lighthouseSuccessCount) return unavailableSamplingResult(this, data, 'lighthouse');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, lighthouseSuccessCount, avgPerformanceScore, minPerformanceScore, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ?
        AND (
          (avgPerformanceScore IS NOT NULL AND avgPerformanceScore < ?)
          OR (minPerformanceScore IS NOT NULL AND minPerformanceScore < ?)
        )
      ORDER BY minPerformanceScore ASC, avgPerformanceScore ASC
      LIMIT 10
    `, [ctx.run.id, thresholds.lighthousePerformanceWarning, thresholds.lighthousePerformanceWarning]);
    const errorCount = rows.filter((row) =>
      Number(row.avgPerformanceScore) < thresholds.lighthousePerformanceError ||
      Number(row.minPerformanceScore) < thresholds.lighthousePerformanceError
    ).length;
    return templateFinding(this, rows, errorCount ? 'Error' : rows.length ? 'Warning' : 'OK', {
      finding: rows.length ? `${rows.length} template cluster(s) have low sampled Lighthouse performance.` : 'No low Lighthouse performance template signal found.',
      recommendation: 'Prioritize slow templates and validate representative samples before broad rollout.',
      evidence: {
        thresholds: {
          warning: thresholds.lighthousePerformanceWarning,
          error: thresholds.lighthousePerformanceError,
          scoreScale: '0-1'
        },
        templates: mapTemplateRows(rows)
      },
      findingType: 'core_issue'
    });
  }, { priority: 'High', effort: 'L' });
}

function templateLowLighthouseSeo() {
  return tech('template.low_lighthouse_seo', 'Template Performance & Rendering', 'Template Lighthouse SEO score low', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.lighthouseEnabled || !data.lighthouseSuccessCount) return unavailableSamplingResult(this, data, 'lighthouse');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, lighthouseSuccessCount, avgSeoScore, minSeoScore, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ?
        AND (
          (avgSeoScore IS NOT NULL AND avgSeoScore < ?)
          OR (minSeoScore IS NOT NULL AND minSeoScore < ?)
        )
      ORDER BY minSeoScore ASC, avgSeoScore ASC
      LIMIT 10
    `, [ctx.run.id, thresholds.lighthouseSeoWarning, thresholds.lighthouseSeoWarning]);
    return templateFinding(this, rows, rows.length ? 'Warning' : 'OK', {
      finding: rows.length ? `${rows.length} template cluster(s) have low sampled Lighthouse SEO scores.` : 'No low Lighthouse SEO template signal found.',
      recommendation: 'Inspect Lighthouse SEO audit details for affected templates.',
      evidence: { threshold: thresholds.lighthouseSeoWarning, scoreScale: '0-1', templates: mapTemplateRows(rows) },
      findingType: 'best_practice'
    });
  }, { priority: 'Medium', effort: 'M' });
}

function templateHighLcp() {
  return tech('template.high_lcp', 'Template Performance & Rendering', 'Template LCP high', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.lighthouseEnabled || !data.lighthouseSuccessCount) return unavailableSamplingResult(this, data, 'lighthouse');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, lighthouseSuccessCount, avgLcpMs, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ? AND avgLcpMs IS NOT NULL AND avgLcpMs > ?
      ORDER BY avgLcpMs DESC
      LIMIT 10
    `, [ctx.run.id, thresholds.lcpWarningMs]);
    const status = rows.some((row) => Number(row.avgLcpMs) > thresholds.lcpErrorMs) ? 'Error' : rows.length ? 'Warning' : 'OK';
    return templateFinding(this, rows, status, {
      finding: rows.length ? `${rows.length} template cluster(s) have high sampled Lighthouse LCP.` : 'No high sampled Lighthouse LCP template signal found.',
      recommendation: rows.length
        ? 'Optimize critical rendering path and largest above-the-fold assets for affected templates; confirm with repeated Lighthouse or field data before final prioritization.'
        : 'No LCP action from stored Lighthouse samples.',
      evidence: {
        thresholds: { warningMs: thresholds.lcpWarningMs, errorMs: thresholds.lcpErrorMs },
        measurementType: 'lighthouse_lab_sample',
        volatility: 'lab_performance_measurement',
        templates: mapTemplateRows(rows)
      },
      findingType: 'core_issue'
    });
  }, { priority: 'High', effort: 'L' });
}

function templateHighTbt() {
  return tech('template.high_tbt', 'Template Performance & Rendering', 'Template TBT high', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.lighthouseEnabled || !data.lighthouseSuccessCount) return unavailableSamplingResult(this, data, 'lighthouse');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, lighthouseSuccessCount, avgTbtMs, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ? AND avgTbtMs IS NOT NULL AND avgTbtMs > ?
      ORDER BY avgTbtMs DESC
      LIMIT 10
    `, [ctx.run.id, thresholds.tbtWarningMs]);
    const status = rows.some((row) => Number(row.avgTbtMs) > thresholds.tbtErrorMs) ? 'Error' : rows.length ? 'Warning' : 'OK';
    return templateFinding(this, rows, status, {
      finding: rows.length ? `${rows.length} template cluster(s) have high sampled Total Blocking Time.` : 'No high sampled TBT template signal found.',
      recommendation: 'Reduce main-thread JavaScript work on affected templates.',
      evidence: { thresholds: { warningMs: thresholds.tbtWarningMs, errorMs: thresholds.tbtErrorMs }, templates: mapTemplateRows(rows) },
      findingType: 'core_issue'
    });
  }, { priority: 'Medium', effort: 'L' });
}

function templateConsoleErrors() {
  return tech('template.console_errors', 'Template Performance & Rendering', 'Template sample console errors', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.playwrightEnabled || !data.playwrightSuccessCount) return unavailableSamplingResult(this, data, 'playwright');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, playwrightSuccessCount, consoleErrorSampleCount, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ? AND consoleErrorSampleCount >= ?
      ORDER BY consoleErrorSampleCount DESC, templateClusterKey ASC
      LIMIT 10
    `, [ctx.run.id, thresholds.consoleErrorsWarning]);
    return templateFinding(this, rows, rows.length ? 'Warning' : 'OK', {
      finding: rows.length ? `${rows.length} template cluster(s) produced console errors during sampled rendering.` : 'No sampled template console errors found.',
      recommendation: 'Review console errors from sampled URLs and fix errors that can affect rendering or user interactions.',
      evidence: { threshold: thresholds.consoleErrorsWarning, templates: mapTemplateRows(rows) },
      findingType: 'core_issue',
      reviewRecommended: true
    });
  }, { priority: 'Medium', effort: 'M' });
}

function templateJsRequiredContent() {
  return tech('template.js_required_content', 'Template Performance & Rendering', 'Template content likely JS-dependent', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount || !data.playwrightEnabled || !data.playwrightSuccessCount) return unavailableSamplingResult(this, data, 'playwright');
    const rows = all(ctx.db, `
      SELECT templateClusterKey, sampleCount, playwrightSuccessCount, jsRequiredCount, worstSampleUrlsJson
      FROM template_performance_summary
      WHERE runId = ? AND jsRequiredCount > 0
      ORDER BY jsRequiredCount DESC, templateClusterKey ASC
      LIMIT 10
    `, [ctx.run.id]);
    return templateFinding(this, rows, rows.length ? 'Warning' : 'OK', {
      finding: rows.length ? `${rows.length} template cluster(s) look JS-dependent in sampled rendering.` : 'No sampled JS-dependent content signal found.',
      recommendation: 'Validate server-rendered content coverage for affected templates.',
      evidence: { heuristic: 'raw/rendered word, H1 and link deltas', templates: mapTemplateRows(rows) },
      findingType: 'core_issue',
      reviewRecommended: true
    });
  }, { priority: 'Medium', effort: 'L' });
}

function templateLighthouseUnavailable() {
  return tech('template.lighthouse_unavailable', 'Template Performance & Rendering', 'Lighthouse sampling unavailable', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount) return unavailableSamplingResult(this, data, 'lighthouse');
    const unavailable = count(ctx.db, "SELECT COUNT(*) AS count FROM template_sample_results WHERE runId = ? AND lighthouseStatus = 'unavailable'", [ctx.run.id]);
    return makeResult(this, unavailable ? 'NA' : 'OK', {
      affectedCount: unavailable,
      finding: unavailable ? 'Lighthouse sampling was requested but unavailable for sample URLs.' : 'Lighthouse sampling was either successful or not requested.',
      recommendation: 'Install local Lighthouse and Chromium only when lab performance sampling is needed.',
      evidence: { ...data, unavailableSamples: unavailable },
      findingType: 'info',
      confidence: 'low',
      reviewRecommended: false
    });
  }, { priority: 'Low', effort: 'S' });
}

function templatePlaywrightUnavailable() {
  return tech('template.playwright_unavailable', 'Template Performance & Rendering', 'Playwright sampling unavailable', function run(ctx) {
    const data = samplingState(ctx.db, ctx.run.id);
    if (!data.sampleCount) return unavailableSamplingResult(this, data, 'playwright');
    const unavailable = count(ctx.db, "SELECT COUNT(*) AS count FROM template_sample_results WHERE runId = ? AND playwrightStatus = 'unavailable'", [ctx.run.id]);
    return makeResult(this, unavailable ? 'NA' : 'OK', {
      affectedCount: unavailable,
      finding: unavailable ? 'Playwright sampling was requested but unavailable for sample URLs.' : 'Playwright sampling was either successful or not requested.',
      recommendation: 'Install Chromium with `npx playwright install chromium` when rendered template sampling is needed.',
      evidence: { ...data, unavailableSamples: unavailable },
      findingType: 'info',
      confidence: 'low',
      reviewRecommended: false
    });
  }, { priority: 'Low', effort: 'S' });
}

function templateFinding(check, rows, status, options) {
  const samples = rows.flatMap((row) => safeJson(row.worstSampleUrlsJson, []).map((sample) => sample.url)).filter(Boolean).slice(0, 10);
  const affectedSamples = rows.reduce((sum, row) => sum + Number(row.sampleCount || 0), 0);
  return makeResult(check, status, {
    affectedCount: rows.length,
    sampleUrls: samples,
    finding: options.finding,
    recommendation: options.recommendation,
    evidence: options.evidence,
    findingType: options.findingType || 'core_issue',
    confidence: confidenceForTemplateRows(rows),
    reviewRecommended: options.reviewRecommended ?? rows.some((row) => Number(row.sampleCount || 0) < 2 || Number(row.lighthouseSuccessCount || row.playwrightSuccessCount || 0) < Number(row.sampleCount || 0)),
    details: rows.length
      ? `Based on ${affectedSamples} sampled URL(s) across ${rows.length} template cluster(s).`
      : 'No affected template cluster found in stored sampling summaries.'
  });
}

function unavailableSamplingResult(check, data, tool) {
  const enabled = tool === 'lighthouse' ? data.lighthouseEnabled : data.playwrightEnabled;
  const successCount = tool === 'lighthouse' ? data.lighthouseSuccessCount : data.playwrightSuccessCount;
  return makeResult(check, 'NA', {
    affectedCount: 0,
    finding: enabled
      ? `${tool} sampling did not produce successful template measurements.`
      : `${tool} sampling is disabled for this run.`,
    recommendation: enabled
      ? `Review local ${tool} availability if template sampling should collect these measurements.`
      : `Enable ${tool} sampling only when rendered/lab measurements are needed for representative templates.`,
    evidence: { ...data, tool, enabled, successCount },
    findingType: 'info',
    confidence: 'low'
  });
}

function samplingState(db, runId) {
  const run = db.prepare(`
    SELECT enableTemplateSampling, enablePlaywrightSampling, enableLighthouseSampling,
      samplesTotal, samplesProcessed
    FROM runs
    WHERE id = ?
  `).get(runId) || {};
  const samples = db.prepare(`
    SELECT
      COUNT(*) AS sampleCount,
      SUM(CASE WHEN playwrightStatus = 'success' THEN 1 ELSE 0 END) AS playwrightSuccessCount,
      SUM(CASE WHEN lighthouseStatus = 'success' THEN 1 ELSE 0 END) AS lighthouseSuccessCount,
      SUM(CASE WHEN playwrightStatus = 'unavailable' THEN 1 ELSE 0 END) AS playwrightUnavailableCount,
      SUM(CASE WHEN lighthouseStatus = 'unavailable' THEN 1 ELSE 0 END) AS lighthouseUnavailableCount
    FROM template_sample_results
    WHERE runId = ?
  `).get(runId);
  return {
    templateSamplingEnabled: Boolean(run.enableTemplateSampling),
    playwrightEnabled: Boolean(run.enablePlaywrightSampling),
    lighthouseEnabled: Boolean(run.enableLighthouseSampling),
    samplesTotal: run.samplesTotal || 0,
    samplesProcessed: run.samplesProcessed || 0,
    sampleCount: samples.sampleCount || 0,
    playwrightSuccessCount: samples.playwrightSuccessCount || 0,
    lighthouseSuccessCount: samples.lighthouseSuccessCount || 0,
    playwrightUnavailableCount: samples.playwrightUnavailableCount || 0,
    lighthouseUnavailableCount: samples.lighthouseUnavailableCount || 0
  };
}

function mapTemplateRows(rows) {
  return rows.map((row) => ({
    ...row,
    worstSampleUrls: safeJson(row.worstSampleUrlsJson, [])
  }));
}

function confidenceForTemplateRows(rows) {
  if (!rows.length) return 'high';
  const sampleTotal = rows.reduce((sum, row) => sum + Number(row.sampleCount || 0), 0);
  if (sampleTotal >= 4 && rows.length > 1) return 'high';
  if (sampleTotal >= 2) return 'medium';
  return 'low';
}

function jsonLdParseErrors() {
  return tech('json_ld_parse_errors', 'Structured Data', 'JSON-LD parse errors', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT pageUrl AS url, parseError
      FROM schemas
      WHERE runId = ? AND parseStatus = 'error'
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, "SELECT COUNT(*) AS count FROM schemas WHERE runId = ? AND parseStatus = 'error'", [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Error' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} JSON-LD block(s) failed parsing.` : 'All detected JSON-LD blocks were parseable.',
      recommendation: 'Fix invalid JSON-LD syntax.',
      evidence: { samples: rows }
    });
  }, { priority: 'High' });
}

function schemaCoverageSummary() {
  return tech('schema_types_coverage_summary', 'Structured Data', 'Schema types coverage summary', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT schemaType, COUNT(DISTINCT pageUrl) AS pages
      FROM schemas
      WHERE runId = ? AND parseStatus = 'ok' AND schemaType IS NOT NULL
      GROUP BY schemaType
      ORDER BY pages DESC, schemaType ASC
    `, [ctx.run.id]);
    const total = htmlPageCount(ctx.db, ctx.run.id);
    return makeResult(this, !total ? 'NA' : rows.length ? 'OK' : 'Warning', {
      finding: rows.length ? 'Schema type coverage calculated.' : 'No parseable schema types found.',
      recommendation: 'Use structured data where it accurately describes page content.',
      evidence: { totalHtmlPages: total, schemaTypes: rows }
    });
  }, { priority: 'Low', effort: 'S' });
}

function schemaMissing(id, category, name, schemaType, priority = 'Medium') {
  return tech(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        finding: `${schemaType} schema could not be evaluated because no HTML pages were stored.`,
        evidence: { totalHtmlPages: 0, schemaType }
      });
    }
    const present = count(ctx.db, "SELECT COUNT(*) AS count FROM schemas WHERE runId = ? AND schemaType = ? AND parseStatus = 'ok'", [ctx.run.id, schemaType]);
    return makeResult(this, present ? 'OK' : 'Warning', {
      affectedCount: present ? 0 : 1,
      finding: present ? `${schemaType} schema found.` : `${schemaType} schema not found in stored JSON-LD.`,
      recommendation: `Add ${schemaType} schema only where it accurately represents the page or entity.`,
      evidence: { schemaType, occurrences: present }
    });
  }, { priority });
}

function schemaPresentMissing(id, category, name, schemaType, priority = 'Medium') {
  return schemaMissing(id, category, name, schemaType, priority);
}

function personSchemaCoverage() {
  return tech('person_present_missing', 'Structured Data', 'Person present/missing', function run(ctx) {
    const candidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'article'
      OR COALESCE(hasAuthorPattern, 0) = 1
      OR LOWER(url) LIKE '%/team%'
      OR LOWER(url) LIKE '%/autor%'
      OR LOWER(url) LIKE '%/author%'
      OR LOWER(COALESCE(title, '')) LIKE '%autor%'
      OR LOWER(COALESCE(title, '')) LIKE '%team%'
    )`;
    const candidatePages = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${candidateWhere}`, [ctx.run.id]);
    const present = count(ctx.db, "SELECT COUNT(DISTINCT pageUrl) AS count FROM schemas WHERE runId = ? AND schemaType = 'Person' AND parseStatus = 'ok'", [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url, pageType, hasAuthorPattern
      FROM pages
      WHERE runId = ? AND ${candidateWhere} AND COALESCE(schemaTypesJson, '') NOT LIKE '%Person%'
      ORDER BY id ASC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${candidateWhere} AND COALESCE(schemaTypesJson, '') NOT LIKE '%Person%'
    `, [ctx.run.id]);
    const status = present ? 'OK' : candidatePages ? 'Warning' : 'NA';
    return makeResult(this, status, {
      priority: 'Low',
      affectedCount: status === 'Warning' ? affectedCount : 0,
      sampleUrls: rows.map((row) => row.url),
      finding: present
        ? 'Person schema found on at least one suitable page.'
        : candidatePages
          ? `${affectedCount}/${candidatePages} article/author/team candidate page(s) lack Person schema.`
          : 'No article, author or team pages detected for Person schema evaluation.',
      recommendation: 'Use Person schema only where visible author or team/person information is present.',
      details: 'General service pages are not treated as Person-schema candidates.',
      evidence: { candidatePages, personSchemaPages: present, affectedCount: status === 'Warning' ? affectedCount : 0, samples: rows },
      findingType: status === 'Warning' ? 'opportunity' : 'info',
      confidence: candidatePages ? 'medium' : 'low',
      reviewRecommended: status === 'Warning'
    });
  }, { priority: 'Low', effort: 'S' });
}

function speakableOpportunity() {
  return tech('speakable_missing', 'Structured Data Opportunity', 'Speakable missing', function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        priority: 'Low',
        finding: 'Speakable schema could not be evaluated because no HTML pages were stored.',
        recommendation: 'Consider Speakable only where it accurately marks concise spoken-answer content.',
        evidence: { totalHtmlPages: 0, schemaType: 'SpeakableSpecification' },
        findingType: 'info',
        confidence: 'low',
        reportGroupingKey: 'schema.speakable',
        relatedCheckIds: ['geo.speakable_present']
      });
    }
    const present = count(ctx.db, "SELECT COUNT(*) AS count FROM schemas WHERE runId = ? AND schemaType = 'SpeakableSpecification' AND parseStatus = 'ok'", [ctx.run.id]);
    return makeResult(this, present ? 'OK' : 'NA', {
      priority: 'Low',
      affectedCount: 0,
      finding: present ? 'Speakable schema found.' : 'Speakable schema was not found; this is treated as a GEO opportunity rather than a technical error.',
      recommendation: 'Use Speakable only for suitable editorial or answer-focused content where the markup matches visible text.',
      details: 'Optional future-facing structured data signal; the GEO check carries the active opportunity finding.',
      evidence: { totalHtmlPages: total, schemaType: 'SpeakableSpecification', occurrences: present },
      findingType: present ? 'info' : 'opportunity',
      confidence: 'medium',
      reportGroupingKey: 'schema.speakable',
      relatedCheckIds: ['geo.speakable_present']
    });
  }, { priority: 'Low', effort: 'S' });
}

function articleCoverage() {
  return tech('article_coverage_on_article_like_pages', 'Structured Data', 'Article coverage on article-like pages', function run(ctx) {
    return pageTypeSchemaCoverage(this, ctx, 'article', 'Article');
  });
}

function productCoverage() {
  return tech('product_coverage_on_product_like_pages', 'Structured Data', 'Product coverage on product-like pages', function run(ctx) {
    return pageTypeSchemaCoverage(this, ctx, 'product', 'Product');
  });
}

function pageTypeSchemaCoverage(check, ctx, pageType, schemaType) {
  const rows = all(ctx.db, `
    SELECT url
    FROM pages
    WHERE runId = ? AND pageType = ? AND COALESCE(schemaTypesJson, '') NOT LIKE ?
    LIMIT 10
  `, [ctx.run.id, pageType, `%${schemaType}%`]);
  const total = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND pageType = ?', [ctx.run.id, pageType]);
  const affectedCount = count(ctx.db, `
    SELECT COUNT(*) AS count
    FROM pages
    WHERE runId = ? AND pageType = ? AND COALESCE(schemaTypesJson, '') NOT LIKE ?
  `, [ctx.run.id, pageType, `%${schemaType}%`]);
  return makeResult(check, total ? (affectedCount ? 'Warning' : 'OK') : 'NA', {
    affectedCount,
    sampleUrls: rows.map((row) => row.url),
    finding: total ? `${affectedCount}/${total} ${pageType} page(s) lack ${schemaType} schema.` : `No ${pageType} pages detected by stored heuristics.`,
    recommendation: `Add ${schemaType} schema only to matching pages.`,
    details: `Evaluated only pages classified as pageType=${pageType}.`,
    evidence: { pageType, schemaType, totalCandidatePages: total, affectedCount, sampleUrls: rows.map((row) => row.url) },
    reportGroupingKey: `schema.${schemaType.toLowerCase()}`,
    relatedCheckIds: schemaType === 'Article' ? ['geo.article_blog_pages_article_schema'] : [],
    confidence: 'high'
  });
}

function breadcrumbCoverage() {
  return tech('breadcrumb_missing_low_coverage', 'Structured Data', 'BreadcrumbList missing or low coverage', function run(ctx) {
    const candidateWhere = `${HTML_WHERE}
      AND COALESCE(pageType, 'other') NOT IN ('homepage', 'blog_index', 'article_index', 'product_index', 'category_index', 'legal', 'contact')
      AND (
        COALESCE(pageType, 'other') IN ('article', 'product', 'category', 'location')
        OR LOWER(url) LIKE '%/fakta/%'
        OR LOWER(url) LIKE '%/fakten/%'
        OR LOWER(url) LIKE '%/facts/%'
        OR depth > 1
      )`;
    const total = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${candidateWhere}`, [ctx.run.id]);
    const missingRows = all(ctx.db, `
      SELECT url, pageType, depth
      FROM pages
      WHERE runId = ? AND ${candidateWhere} AND COALESCE(schemaTypesJson, '') NOT LIKE '%BreadcrumbList%'
      ORDER BY depth DESC, id ASC
      LIMIT 10
    `, [ctx.run.id]);
    const presentRows = all(ctx.db, `
      SELECT url, pageType, depth
      FROM pages
      WHERE runId = ? AND ${candidateWhere} AND COALESCE(schemaTypesJson, '') LIKE '%BreadcrumbList%'
      ORDER BY depth DESC, id ASC
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${candidateWhere} AND COALESCE(schemaTypesJson, '') NOT LIKE '%BreadcrumbList%'
    `, [ctx.run.id]);
    const pagesWithBreadcrumbList = Math.max(0, total - affectedCount);
    const coverage = total ? pagesWithBreadcrumbList / total : null;
    const sampleMissingUrls = missingRows.map((row) => row.url);
    const samplePresentUrls = presentRows.map((row) => row.url);
    return makeResult(this, total ? (affectedCount ? 'Warning' : 'OK') : 'NA', {
      affectedCount,
      sampleUrls: sampleMissingUrls,
      finding: total ? `${affectedCount}/${total} eligible detail page(s) lack BreadcrumbList schema.` : 'No eligible detail pages for BreadcrumbList evaluation.',
      recommendation: 'Use BreadcrumbList schema where visible breadcrumbs exist on deeper templates.',
      details: 'Eligible pages include article, product, category, location, facts/fakta/fakten and deeper non-index templates. Homepage, index, legal and contact pages are excluded.',
      evidence: { eligiblePages: total, pagesWithBreadcrumbList, coverage, sampleMissingUrls, samplePresentUrls }
    });
  });
}

function faqPageCoverage() {
  return tech('faqpage_missing_low_coverage', 'Structured Data', 'FAQPage missing when FAQ structure exists', function run(ctx) {
    const total = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND hasFaqPattern = 1', [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url, pageType
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
    `, [ctx.run.id]);
    const weakRows = all(ctx.db, `
      SELECT url, pageType
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
      LIMIT 10
    `, [ctx.run.id]);
    const weakFaqPages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
    `, [ctx.run.id]);
    const status = total ? (affectedCount ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      priority: 'Low',
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: total
        ? `${affectedCount}/${total} page(s) with strong FAQ structure lack FAQPage schema.`
        : weakFaqPages
          ? `${weakFaqPages} page(s) have weak FAQ hints; review before adding FAQPage schema.`
          : 'No qualifying FAQ structures detected.',
      recommendation: 'Use FAQPage schema only when the visible content qualifies for it.',
      details: 'Strong FAQ requires multiple visible Q&A-like items. Weak single-question or label-only hints are not treated as hard issues.',
      evidence: { strongFaqPages: total, weakFaqPages, affectedCount, samples: rows, weakSamples: weakRows },
      findingType: total ? 'core_issue' : weakFaqPages ? 'opportunity' : 'info',
      confidence: total ? 'high' : 'low',
      reviewRecommended: weakFaqPages > 0,
      reportGroupingKey: 'schema.faqpage',
      relatedCheckIds: ['geo.faq_html_present_schema_missing']
    });
  }, { priority: 'Low' });
}

function localBusinessDomainHint() {
  return tech('localbusiness_present_missing', 'Structured Data', 'LocalBusiness present/missing', function run(ctx) {
    const locationCandidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'location'
      OR COALESCE(schemaTypesJson, '') LIKE '%Place%'
    ) AND (
      LOWER(url) LIKE '%/standort%'
      OR LOWER(url) LIKE '%/standorte%'
      OR LOWER(url) LIKE '%/filiale%'
      OR LOWER(url) LIKE '%/filialen%'
      OR LOWER(url) LIKE '%/location%'
      OR LOWER(url) LIKE '%/locations%'
      OR LOWER(COALESCE(title, '')) LIKE '%standort%'
      OR LOWER(COALESCE(title, '')) LIKE '%filiale%'
    )`;
    const rows = all(ctx.db, `
      SELECT url, pageType
      FROM pages
      WHERE runId = ? AND ${locationCandidateWhere} AND COALESCE(schemaTypesJson, '') NOT LIKE '%LocalBusiness%'
      ORDER BY id ASC
      LIMIT 10
    `, [ctx.run.id]);
    const locationPages = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${locationCandidateWhere}`, [ctx.run.id]);
    const present = count(ctx.db, "SELECT COUNT(DISTINCT pageUrl) AS count FROM schemas WHERE runId = ? AND schemaType = 'LocalBusiness' AND parseStatus = 'ok'", [ctx.run.id]);
    const status = present ? 'OK' : locationPages ? 'Warning' : 'NA';
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? locationPages : 0,
      finding: present ? 'LocalBusiness schema found.' : locationPages ? `${locationPages} location page(s) detected without LocalBusiness schema.` : 'No location pages detected by stored heuristics.',
      recommendation: 'Use LocalBusiness schema only for real local business/location entities.',
      details: 'This is a domain/template hint. Service pages mentioning local SEO are not treated as location pages without explicit Standort/Filiale/location URL or title signals.',
      evidence: { candidateLocationPages: locationPages, localBusinessSchemaPages: present, sampleUrls: rows.map((row) => row.url), samples: rows },
      findingType: status === 'Warning' ? 'opportunity' : 'info',
      confidence: 'medium'
    });
  });
}

function organizationSameAsMissing() {
  return tech('organization_sameas_missing', 'Structured Data', 'Organization sameAs missing', function run(ctx) {
    const orgRows = all(ctx.db, "SELECT rawJson FROM schemas WHERE runId = ? AND schemaType = 'Organization' AND parseStatus = 'ok'", [ctx.run.id]);
    const hasSameAs = orgRows.some((row) => /"sameAs"\s*:/.test(row.rawJson || ''));
    return makeResult(this, hasSameAs ? 'OK' : 'Warning', {
      affectedCount: hasSameAs ? 0 : 1,
      finding: hasSameAs ? 'Organization schema includes sameAs.' : 'Organization schema with sameAs was not found.',
      recommendation: 'Add sameAs references to Organization schema when authoritative profiles exist.',
      evidence: { organizationSchemaBlocks: orgRows.length, hasSameAs }
    });
  }, { priority: 'Low' });
}

function imagesWithoutAlt() {
  return tech('images_without_alt', 'Media SEO', 'Content images without alt', function run(ctx) {
    const contentWhere = `hasAlt = 0 AND ${NON_DECORATIVE_IMAGE_WHERE}`;
    const rows = dedupeImageSamples(all(ctx.db, `
      SELECT pageUrl AS url, imageUrl, imageRole
      FROM page_images
      WHERE runId = ? AND ${contentWhere}
      LIMIT 30
    `, [ctx.run.id]));
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM page_images WHERE runId = ? AND ${contentWhere}`, [ctx.run.id]);
    const ignoredDecorative = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND hasAlt = 0 AND (
        COALESCE(likelyDecorativeImage, 0) = 1 OR
        COALESCE(likelyBadgeImage, 0) = 1 OR
        COALESCE(likelyTrackingPixel, 0) = 1 OR
        COALESCE(likelyIcon, 0) = 1
      )
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount
        ? `${affectedCount} likely content image(s) are missing alt text.`
        : ignoredDecorative
          ? `No likely content images are missing alt text; ${ignoredDecorative} decorative/badge/icon/pixel image(s) were ignored.`
          : 'All detected likely content images have alt text.',
      recommendation: 'Add descriptive alt text for meaningful content images; empty alt is acceptable for decorative images.',
      evidence: { contentImagesMissingAlt: affectedCount, ignoredDecorativeImages: ignoredDecorative, samples: rows },
      findingType: 'core_issue',
      confidence: 'medium',
      reviewRecommended: ignoredDecorative > 0
    });
  });
}

function emptyAltTexts() {
  return tech('empty_alt_texts', 'Media SEO', 'Empty alt texts', function run(ctx) {
    const rows = dedupeImageSamples(all(ctx.db, `
      SELECT pageUrl AS url, imageUrl, imageRole
      FROM page_images
      WHERE runId = ? AND alt = ''
        AND COALESCE(likelyDecorativeImage, 0) = 0
        AND COALESCE(likelyBadgeImage, 0) = 0
        AND COALESCE(likelyTrackingPixel, 0) = 0
        AND COALESCE(likelyIcon, 0) = 0
      LIMIT 30
    `, [ctx.run.id]));
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND alt = ''
        AND COALESCE(likelyDecorativeImage, 0) = 0
        AND COALESCE(likelyBadgeImage, 0) = 0
        AND COALESCE(likelyTrackingPixel, 0) = 0
        AND COALESCE(likelyIcon, 0) = 0
    `, [ctx.run.id]);
    const decorativeEmpty = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND alt = '' AND (
        COALESCE(likelyDecorativeImage, 0) = 1 OR
        COALESCE(likelyBadgeImage, 0) = 1 OR
        COALESCE(likelyTrackingPixel, 0) = 1 OR
        COALESCE(likelyIcon, 0) = 1
      )
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} likely content image(s) have empty alt attributes.` : 'No likely content images with empty alt attributes found.',
      recommendation: 'Use empty alt only for decorative images; otherwise provide descriptive alt text.',
      evidence: { contentImagesWithEmptyAlt: affectedCount, decorativeEmptyAltImages: decorativeEmpty, samples: rows },
      findingType: 'core_issue',
      confidence: 'medium',
      reviewRecommended: decorativeEmpty > 0
    });
  });
}

function imageAttributeCheck(id, category, name, where, status = 'Warning', priority = 'Medium', options = {}) {
  return tech(id, category, name, function run(ctx) {
    const contentWhere = `(${where}) AND ${NON_DECORATIVE_IMAGE_WHERE}${options.extraContentWhere ? ` AND ${options.extraContentWhere}` : ''}`;
    const rows = dedupeImageSamples(all(ctx.db, `
      SELECT pageUrl AS url, imageUrl, imageRole, ${sqlString(options.issueReason || 'image markup issue')} AS reason
      FROM page_images
      WHERE runId = ? AND ${contentWhere}
      LIMIT 30
    `, [ctx.run.id]));
    const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM page_images WHERE runId = ? AND ${contentWhere}`, [ctx.run.id]);
    const ignoredDecorative = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND (${where}) AND (
        COALESCE(likelyDecorativeImage, 0) = 1 OR
        COALESCE(likelyBadgeImage, 0) = 1 OR
        COALESCE(likelyTrackingPixel, 0) = 1 OR
        COALESCE(likelyIcon, 0) = 1
      )
    `, [ctx.run.id]);
    const ignoredSmallImages = options.extraContentWhere ? count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND (${where}) AND ${NON_DECORATIVE_IMAGE_WHERE} AND NOT (${NOT_SMALL_IMAGE_WHERE})
    `, [ctx.run.id]) : 0;
    const ignoredHeroImages = options.extraContentWhere ? count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM page_images
      WHERE runId = ? AND (${where}) AND ${NON_DECORATIVE_IMAGE_WHERE} AND ${NOT_SMALL_IMAGE_WHERE} AND NOT (${NOT_LIKELY_HERO_IMAGE_WHERE})
    `, [ctx.run.id]) : 0;
    return makeResult(this, affectedCount ? status : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount
        ? (options.finding || `${affectedCount} likely content image(s) match this issue.`)
        : ignoredDecorative
          ? `No likely content images match this issue; ${ignoredDecorative} decorative/badge/icon/pixel image(s) were ignored.`
          : 'No matching image issue found.',
      recommendation: options.recommendation || 'Review image markup for crawlability and layout stability.',
      evidence: {
        samples: rows,
        ignoredDecorativeImages: ignoredDecorative,
        ignoredSmallImages,
        ignoredHeroImages
      },
      findingType: options.findingType,
      confidence: 'medium',
      reviewRecommended: ignoredDecorative > 0 || ignoredSmallImages > 0 || ignoredHeroImages > 0
    });
  }, { priority });
}

function sqlString(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

function largeImages() {
  return tech('large_image_resources', 'Media SEO', `Large image resources > ${Math.round(thresholds.largeImageBytes / 1024)} KB`, function run(ctx) {
    const rows = dedupeImageSamples(all(ctx.db, `
      SELECT pageUrl AS url, resourceUrl, sizeBytes
      FROM resources
      WHERE runId = ? AND resourceType = 'image' AND sizeBytes > ?
      ORDER BY sizeBytes DESC
      LIMIT 30
    `, [ctx.run.id, thresholds.largeImageBytes]));
    const affectedCount = count(ctx.db, "SELECT COUNT(*) AS count FROM resources WHERE runId = ? AND resourceType = 'image' AND sizeBytes > ?", [ctx.run.id, thresholds.largeImageBytes]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} known image resource(s) exceed ${Math.round(thresholds.largeImageBytes / 1024)} KB.` : `No known image resources exceed ${Math.round(thresholds.largeImageBytes / 1024)} KB.`,
      recommendation: 'Compress large images and use responsive sizing.',
      evidence: { thresholdBytes: thresholds.largeImageBytes, affectedCount, samples: rows }
    });
  }, { priority: 'Low' });
}

function modernImageCoverageLow() {
  return tech('modern_image_format_coverage_low', 'Media SEO', 'Modern formats WebP/AVIF coverage low', function run(ctx) {
    const resourceRows = all(ctx.db, `
      SELECT pageUrl AS url, resourceUrl, contentType
      FROM resources
      WHERE runId = ?
        AND resourceType = 'image'
        AND LOWER(COALESCE(contentType, '')) LIKE 'image/%'
        AND LOWER(COALESCE(contentType, '')) NOT LIKE '%svg%'
    `, [ctx.run.id]);
    const knownImageUrls = new Set();
    const modernImageUrls = new Set();
    for (const row of resourceRows) {
      const key = String(row.resourceUrl || '').trim() || `${row.url}:${knownImageUrls.size}`;
      if (!key) continue;
      knownImageUrls.add(key);
      if (/image\/(webp|avif)/i.test(row.contentType || '')) modernImageUrls.add(key);
    }
    const hasContentTypeBasis = knownImageUrls.size > 0;
    const total = hasContentTypeBasis
      ? knownImageUrls.size
      : count(ctx.db, `
        SELECT COUNT(*) AS count
        FROM page_images
        WHERE runId = ?
          AND LOWER(COALESCE(extension, '')) IN ('.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif')
      `, [ctx.run.id]);
    const modern = hasContentTypeBasis
      ? modernImageUrls.size
      : count(ctx.db, "SELECT COUNT(*) AS count FROM page_images WHERE runId = ? AND LOWER(COALESCE(extension, '')) IN ('.webp', '.avif')", [ctx.run.id]);
    const coverage = total ? modern / total : 0;
    const status = !total ? 'NA' : coverage < 0.3 ? 'Warning' : 'OK';
    const nonModernSamples = hasContentTypeBasis
      ? resourceRows
        .filter((row) => !/image\/(webp|avif)/i.test(row.contentType || ''))
        .slice(0, 10)
      : all(ctx.db, `
        SELECT pageUrl AS url, imageUrl AS resourceUrl, extension AS contentType
        FROM page_images
        WHERE runId = ?
          AND LOWER(COALESCE(extension, '')) IN ('.jpg', '.jpeg', '.png', '.gif')
        LIMIT 10
      `, [ctx.run.id]);
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? total - modern : 0,
      sampleUrls: nonModernSamples.map((row) => row.url),
      finding: total ? `${Math.round(coverage * 100)}% of detected raster images use WebP/AVIF (${hasContentTypeBasis ? 'Content-Type basis' : 'URL-extension fallback'}).` : 'No images detected.',
      recommendation: 'Use modern formats for suitable raster images. Server-side content negotiation counts when the stored Content-Type is WebP or AVIF.',
      details: hasContentTypeBasis
        ? 'Evaluated response Content-Type from captured image resources; URL extensions are ignored when reliable Content-Type data exists.'
        : 'No image Content-Type inventory was available, so URL extensions were used as fallback.',
      evidence: { totalImages: total, modernImages: modern, coverage, basis: hasContentTypeBasis ? 'resource_content_type' : 'image_extension', samples: nonModernSamples }
    });
  }, { priority: 'Low' });
}

function videoObjectCheck() {
  return tech('videoobject_schema_present_missing', 'Media SEO', 'VideoObject schema present/missing', function run(ctx) {
    const candidatePages = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND hasVideoEmbed = 1', [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url, pageType
      FROM pages
      WHERE runId = ? AND hasVideoEmbed = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%VideoObject%'
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND hasVideoEmbed = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%VideoObject%'
    `, [ctx.run.id]);
    const status = candidatePages ? (affectedCount ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: candidatePages ? `${affectedCount}/${candidatePages} video embed page(s) lack VideoObject schema.` : 'No video embeds detected by stored heuristics; no VideoObject missing check was applied.',
      recommendation: candidatePages ? 'Use VideoObject schema for important embedded videos.' : 'No VideoObject action unless visible video embeds are present.',
      details: 'Evaluated only pages with stored hasVideoEmbed=1. Existing VideoObject schema without a detected embed is reported elsewhere as schema coverage, not as a missing-embed issue.',
      evidence: { candidatePages, affectedCount, samples: rows }
    });
  }, { priority: 'Low' });
}
