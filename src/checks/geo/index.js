import {
  HTML_WHERE,
  all,
  count,
  dedupeLinkSamples,
  htmlPageCount,
  makeResult,
  safeJson,
  sampleUrls
} from '../helpers.js';
import { blocksTxtFiles, summarizeAiBotRules } from '../../utils/robots.js';

const geo = (id, category, name, run, options = {}) => ({
  id: `geo.${id}`,
  category,
  name,
  auditType: 'geo',
  priority: options.priority || 'Medium',
  effort: options.effort || 'M',
  recommendation: options.recommendation || '',
  run
});

const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot'];
const ABOUT_TARGET_PATTERNS = [
  { needle: '/about', pattern: /(^|\/)about(\/|$)/i },
  { needle: '/about-us', pattern: /(^|\/)about-us(\/|$)/i },
  { needle: '/ueber', pattern: /(^|\/)ueber(\/|$)/i },
  { needle: '/ueber-uns', pattern: /(^|\/)ueber-uns(\/|$)/i },
  { needle: '/über-uns', pattern: /(^|\/)über-uns(\/|$)/i },
  { needle: '/ueber-mich', pattern: /(^|\/)ueber-mich(\/|$)/i },
  { needle: '/über-mich', pattern: /(^|\/)über-mich(\/|$)/i },
  { needle: '/unternehmen', pattern: /(^|\/)unternehmen(\/|$)/i },
  { needle: '/company', pattern: /(^|\/)company(\/|$)/i },
  { needle: '/team', pattern: /(^|\/)team(\/|$)/i }
];
const ABOUT_ANCHOR_LABELS = [
  'about',
  'about us',
  'ueber',
  'ueber uns',
  'über uns',
  'ueber mich',
  'über mich',
  'unternehmen',
  'company',
  'team',
  'das team'
];

export function geoChecks() {
  return [
    llmsTxtPresent(),
    llmsTxtStatus(),
    llmsFullTxtPresent(),
    robotsBlocksTxt(),
    ...AI_BOTS.map((bot) => robotsMentionsBot(bot)),
    aiBotsPolicySummary(),
    markdownTwinCheck(),
    faqHtmlMissingSchema(),
    tablesCoverage(),
    signalCoverage('bulletpoints_lists_present', 'Content Structure Signals', 'Bulletpoints/lists present', 'hasLists', 'lists'),
    sourceLinksPresent(),
    articleSignalCoverage('visible_dates_present', 'Entity & Freshness Signals', 'Visible date signals present', 'hasVisibleDate', 'dates'),
    articleSignalCoverage('author_hints_present', 'Entity & Freshness Signals', 'Author hints heuristically present', 'hasAuthorPattern', 'author hints'),
    internalNavLink('impressum_linked', 'Trust & Contact Signals', 'Impressum internally linked', ['impressum', 'legal notice']),
    internalNavLink('datenschutz_linked', 'Trust & Contact Signals', 'Datenschutz internally linked', ['datenschutz', 'privacy']),
    internalNavLink('about_linked', 'Trust & Contact Signals', 'About/Über-uns page internally linked', ['about', 'ueber-uns', 'über-uns', 'company', 'unternehmen']),
    internalNavLink('contact_linked', 'Trust & Contact Signals', 'Contact page internally linked', ['contact', 'kontakt']),
    organizationSameAs(),
    breadcrumbPresence(),
    schemaPresence('speakable_present', 'GEO Opportunities', 'Speakable Schema vorhanden', 'SpeakableSpecification', 'Low'),
    articleBlogWithArticleSchema(),
    lowStructuredSections()
  ];
}

function getAsset(ctx, type) {
  return ctx.db.prepare(`
    SELECT *
    FROM domain_assets
    WHERE runId = ? AND type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(ctx.run.id, type);
}

function contentTypeForAsset(_ctx, assetOrUrl) {
  const row = typeof assetOrUrl === 'object' && assetOrUrl
    ? assetOrUrl
    : null;
  const headers = safeJson(row?.responseHeadersJson, {});
  return String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
}

function isMarkdownLikeAsset(row, contentType = '') {
  const url = String(row?.url || '').toLowerCase();
  const sample = String(row?.contentSample || '').trim();
  if (/text\/markdown|text\/plain|application\/markdown/.test(contentType)) return true;
  if (/text\/html/.test(contentType)) return false;
  if (/\.(md|markdown|txt)(?:[?#]|$)/.test(url)) {
    return /^#\s|\n#\s|^- |\n- |\[[^\]]+\]\([^)]+\)/m.test(sample) || !/<html[\s>]/i.test(sample);
  }
  return false;
}

function llmsTxtPresent() {
  return geo('llms_txt_present', 'GEO Opportunities', 'llms.txt vorhanden', function run(ctx) {
    const asset = getAsset(ctx, 'llms');
    const ok = asset && asset.statusCode >= 200 && asset.statusCode < 300;
    return makeResult(this, ok ? 'OK' : 'Warning', {
      affectedCount: ok ? 0 : 1,
      finding: ok ? 'llms.txt returned a 2xx status.' : 'llms.txt did not return a 2xx status.',
      recommendation: 'Publish /llms.txt if it is part of the site AI-readiness strategy.',
      evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null, bytes: asset?.content?.length || 0 }
    });
  }, { priority: 'Low' });
}

function llmsTxtStatus() {
  return geo('llms_txt_http_status', 'GEO Opportunities', 'llms.txt HTTP status', function run(ctx) {
    const asset = getAsset(ctx, 'llms');
    const ok = asset && asset.statusCode >= 200 && asset.statusCode < 300;
    return makeResult(this, asset ? (ok ? 'OK' : 'Warning') : 'NA', {
      affectedCount: asset && !ok ? 1 : 0,
      finding: asset ? `llms.txt status recorded: ${asset.statusCode ?? 'fetch failed'}.` : 'llms.txt was not fetched.',
      recommendation: 'Review the returned status and content when llms.txt should be available.',
      evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null },
      findingType: ok ? 'info' : 'opportunity',
      confidence: 'high'
    });
  }, { priority: 'Low', effort: 'S' });
}

function llmsFullTxtPresent() {
  return geo('llms_full_txt_present', 'GEO Opportunities', 'llms-full.txt vorhanden', function run(ctx) {
    const asset = getAsset(ctx, 'llms_full');
    const ok = asset && asset.statusCode >= 200 && asset.statusCode < 300;
    const references = llmsFullReferences(ctx);
    const broken = !ok && asset && (asset.statusCode === null || asset.statusCode >= 400);
    const status = ok ? 'OK' : broken ? 'Warning' : 'NA';
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? 1 : 0,
      finding: ok
        ? 'llms-full.txt returned a 2xx status.'
        : references.length
          ? `llms-full.txt is referenced but returned ${asset?.statusCode ?? 'fetch failed'} instead of a usable 2xx status.`
          : `llms-full.txt returned ${asset?.statusCode ?? 'fetch failed'} instead of 2xx and is not referenced by stored assets; treat as optional unless a full AI-readable corpus is intended.`,
      recommendation: 'Publish /llms-full.txt only if the site maintains a full Markdown/AI-readable corpus.',
      evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null, bytes: asset?.content?.length || 0, references },
      findingType: ok ? 'info' : 'opportunity',
      confidence: references.length ? 'high' : 'medium',
      reviewRecommended: references.length > 0
    });
  }, { priority: 'Low' });
}

function llmsFullReferences(ctx) {
  const references = [];
  const assets = all(ctx.db, `
    SELECT type, url, content
    FROM domain_assets
    WHERE runId = ?
  `, [ctx.run.id]);
  for (const asset of assets) {
    if (/llms-full\.txt/i.test(asset.content || '')) {
      references.push({ sourceType: asset.type, sourceUrl: asset.url });
    }
  }
  const linkRows = all(ctx.db, `
    SELECT sourceUrl, targetUrl
    FROM page_links
    WHERE runId = ? AND LOWER(targetUrl) LIKE '%llms-full.txt%'
    LIMIT 10
  `, [ctx.run.id]);
  for (const row of linkRows) references.push({ sourceType: 'html_link', sourceUrl: row.sourceUrl, targetUrl: row.targetUrl });
  const resourceRows = all(ctx.db, `
    SELECT pageUrl, resourceUrl
    FROM resources
    WHERE runId = ? AND LOWER(resourceUrl) LIKE '%llms-full.txt%'
    LIMIT 10
  `, [ctx.run.id]);
  for (const row of resourceRows) references.push({ sourceType: 'resource', sourceUrl: row.pageUrl, targetUrl: row.resourceUrl });
  return references.slice(0, 20);
}

function robotsBlocksTxt() {
  return geo('robots_blocks_txt_files', 'AI File Access', 'robots.txt blockiert .txt-Dateien', function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    const blocked = blocksTxtFiles(robots?.content || '');
    return makeResult(this, blocked ? 'Warning' : 'OK', {
      affectedCount: blocked ? 1 : 0,
      finding: blocked ? 'robots.txt contains a .txt blocking pattern.' : 'No .txt blocking pattern detected in robots.txt.',
      recommendation: 'Verify that Markdown or llms text files are not unintentionally blocked.',
      evidence: { robotsUrl: robots?.url, statusCode: robots?.statusCode ?? null, blocksTxtFiles: blocked }
    });
  });
}

function robotsMentionsBot(botName) {
  const id = `robots_mentions_${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  return geo(id, 'AI Crawler Policy', `robots.txt mentions ${botName}`, function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    const content = robots?.content || '';
    const mentioned = new RegExp(`(^|\\n)\\s*user-agent\\s*:\\s*${escapeRegex(botName)}\\s*(\\n|$)`, 'i').test(content);
    return makeResult(this, mentioned ? 'OK' : 'Warning', {
      affectedCount: mentioned ? 0 : 1,
      finding: mentioned ? `robots.txt has an explicit ${botName} user-agent block.` : `robots.txt does not explicitly mention ${botName}.`,
      recommendation: `Add explicit ${botName} rules only if the crawl policy should be unambiguous.`,
      evidence: { botName, mentioned, robotsStatusCode: robots?.statusCode ?? null },
      findingType: mentioned ? 'info' : 'opportunity',
      confidence: 'high',
      reportGroupingKey: `ai_crawler_policy.${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
    });
  }, { priority: 'Low' });
}

function aiBotsPolicySummary() {
  return geo('ai_bots_policy_summary', 'AI Crawler Policy', 'AI bots allowed/blocked/unclear from robots.txt', function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    if (!robots?.content) {
      return makeResult(this, 'NA', {
        finding: 'robots.txt content unavailable.',
        recommendation: 'Fetchable robots.txt is required for bot policy inference.',
        evidence: { robotsStatusCode: robots?.statusCode ?? null }
      });
    }
    const summary = summarizeAiBotRules(robots.url, robots.content);
    const blocked = summary.filter((item) => item.status === 'blocked');
    const unmentioned = summary.filter((item) => !item.mentioned);
    const status = blocked.length || unmentioned.length ? 'Warning' : 'OK';
    return makeResult(this, status, {
      priority: blocked.length ? 'Medium' : 'Low',
      affectedCount: blocked.length + unmentioned.length,
      finding: blocked.length
        ? `${blocked.length} tracked AI bot(s) appear blocked at root.`
        : unmentioned.length
          ? `${unmentioned.length} tracked AI bot(s) are not explicitly mentioned.`
          : 'Tracked AI bots are explicitly mentioned and not blocked at root.',
      recommendation: 'Make AI crawler policy explicit in robots.txt where business policy requires it.',
      evidence: { summary },
      findingType: status === 'OK' ? 'info' : 'opportunity',
      confidence: blocked.length ? 'high' : 'medium',
      reportGroupingKey: 'ai_crawler_policy.summary'
    });
  });
}

function markdownTwinCheck() {
  return geo('markdown_twin_homepage', 'GEO Opportunities', 'Markdown Twin für Startseite prüfen', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT type, url, statusCode, LENGTH(content) AS bytes
        , responseHeadersJson, substr(content, 1, 400) AS contentSample
      FROM domain_assets
      WHERE runId = ? AND (
        type IN ('llms', 'llms_full') OR
        url LIKE '%/index.md' OR url LIKE '%/index.md.txt' OR url LIKE '%/README.md'
      )
      ORDER BY url
    `, [ctx.run.id]);
    const enrichedRows = rows.map((row) => {
      const contentType = contentTypeForAsset(ctx, row);
      const markdownLike = isMarkdownLikeAsset(row, contentType);
      return {
        type: row.type,
        url: row.url,
        statusCode: row.statusCode,
        bytes: row.bytes,
        contentType,
        markdownLike
      };
    });
    const okRows = enrichedRows.filter((row) => row.statusCode >= 200 && row.statusCode < 300 && row.markdownLike);
    return makeResult(this, okRows.length ? 'OK' : 'Warning', {
      affectedCount: okRows.length ? 0 : 1,
      finding: okRows.length ? `${okRows.length} Markdown/AI-readable candidate file(s) returned usable 2xx content.` : 'No checked Markdown Twin candidate returned usable 2xx Markdown/text content.',
      recommendation: 'Provide a maintained Markdown twin only when it can stay consistent with canonical HTML.',
      details: 'Candidates must return 2xx and Markdown/text-like content; HTML responses are not counted as Markdown twins.',
      evidence: { checkedFiles: enrichedRows }
    });
  }, { priority: 'Low' });
}

function faqHtmlMissingSchema() {
  return geo('faq_html_present_schema_missing', 'Structured Content', 'FAQ blocks in HTML but FAQPage schema missing', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
      LIMIT 10
    `, [ctx.run.id]);
    const faqPages = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND hasFaqPattern = 1', [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
    `, [ctx.run.id]);
    const weakFaqPages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
    `, [ctx.run.id]);
    const weakRows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
      LIMIT 10
    `, [ctx.run.id]);
    const status = faqPages ? (affectedCount ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      priority: 'Low',
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: faqPages
        ? `${affectedCount}/${faqPages} page(s) with strong FAQ structure lack FAQPage schema.`
        : weakFaqPages
          ? `${weakFaqPages} page(s) have weak FAQ hints; review before treating them as FAQ content.`
          : 'No qualifying FAQ structures detected.',
      recommendation: 'Use FAQPage schema only when the visible content qualifies for it.',
      details: 'GEO perspective: FAQPage can improve answer extraction only when visible Q&A structure is real.',
      evidence: { strongFaqPages: faqPages, weakFaqPages, affectedCount, sampleUrls: rows.map((row) => row.url), weakSampleUrls: weakRows.map((row) => row.url) },
      findingType: faqPages ? 'opportunity' : weakFaqPages ? 'opportunity' : 'info',
      confidence: faqPages ? 'high' : 'low',
      reviewRecommended: weakFaqPages > 0,
      reportGroupingKey: 'schema.faqpage',
      relatedCheckIds: ['tech.faqpage_missing_low_coverage']
    });
  });
}

function signalCoverage(id, category, name, column, label) {
  return geo(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const signalWhere = `${column} = 1`;
    const signalCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${signalWhere}`, [ctx.run.id]);
    const status = !total ? 'NA' : signalCount ? 'OK' : 'Warning';
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? total : 0,
      sampleUrls: signalCount ? sampleUrls(ctx.db, ctx.run.id, signalWhere) : [],
      finding: total ? `${signalCount}/${total} HTML page(s) have ${label} signal(s).` : 'No HTML pages stored.',
      recommendation: `Use ${label} where it naturally improves machine-readable structure.`,
      details: `Based on stored ${column}=1 page signal.`,
      evidence: { totalHtmlPages: total, signalPages: signalCount, signalColumn: column, label }
    });
  }, { priority: 'Low' });
}

function tablesCoverage() {
  return geo('tables_present', 'Content Structure Signals', 'Tables present', function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const signalWhere = 'hasTables = 1';
    const signalCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${signalWhere}`, [ctx.run.id]);
    const status = !total ? 'NA' : signalCount ? 'OK' : 'NA';
    return makeResult(this, status, {
      affectedCount: 0,
      sampleUrls: signalCount ? sampleUrls(ctx.db, ctx.run.id, signalWhere) : [],
      finding: total ? `${signalCount}/${total} HTML page(s) have table signal(s).` : 'No HTML pages stored.',
      recommendation: 'Use tables where tabular comparisons, prices, datasets or specifications are actually present.',
      details: 'Tables are optional structure signals and are not required on every service or landing page.',
      evidence: { totalHtmlPages: total, signalPages: signalCount, signalColumn: 'hasTables', label: 'tables', applicability: signalCount ? 'present' : 'optional_not_detected' },
      findingType: signalCount ? 'info' : 'opportunity',
      confidence: 'high'
    });
  }, { priority: 'Low' });
}

function articleSignalCoverage(id, category, name, column, label) {
  return geo(id, category, name, function run(ctx) {
    const candidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'article' OR
      featureFlagsJson LIKE '%"articleLike":true%'
    )`;
    const total = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${candidateWhere}`, [ctx.run.id]);
    const signalWhere = `${candidateWhere} AND ${column} = 1`;
    const signalCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${signalWhere}`, [ctx.run.id]) : 0;
    const missingWhere = `${candidateWhere} AND COALESCE(${column}, 0) = 0`;
    const missingCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${missingWhere}`, [ctx.run.id]) : 0;
    const status = !total ? 'NA' : missingCount ? 'Warning' : 'OK';
    return makeResult(this, status, {
      affectedCount: missingCount,
      sampleUrls: missingCount ? sampleUrls(ctx.db, ctx.run.id, missingWhere) : sampleUrls(ctx.db, ctx.run.id, signalWhere),
      finding: total ? `${signalCount}/${total} article-like page(s) have ${label} signal(s).` : `No article-like pages detected for ${label} evaluation.`,
      recommendation: `Use ${label} where it improves editorial provenance, freshness or citation quality.`,
      details: `Evaluated only article-like pages, not every service, legal or landing page.`,
      evidence: { candidatePages: total, signalPages: signalCount, missingPages: missingCount, signalColumn: column, label },
      findingType: status === 'Warning' ? 'opportunity' : 'info',
      confidence: total ? 'high' : 'medium'
    });
  }, { priority: 'Low' });
}

function sourceLinksPresent() {
  return geo('source_or_external_links_present', 'Content Structure', 'Quellenbereiche oder externe Quellenlinks vorhanden', function run(ctx) {
    const candidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'article' OR
      featureFlagsJson LIKE '%"articleLike":true%'
    )`;
    const total = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${candidateWhere}`, [ctx.run.id]);
    const sourcePages = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${candidateWhere} AND externalSourceLinksCount > 0`, [ctx.run.id]) : 0;
    const missingWhere = `${candidateWhere} AND COALESCE(externalSourceLinksCount, 0) = 0`;
    const missingCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${missingWhere}`, [ctx.run.id]) : 0;
    return makeResult(this, !total ? 'NA' : sourcePages ? 'OK' : 'Warning', {
      affectedCount: missingCount,
      sampleUrls: missingCount ? sampleUrls(ctx.db, ctx.run.id, missingWhere) : [],
      finding: total ? `${sourcePages}/${total} article-like page(s) include external/source-link signals.` : 'No article-like pages detected for source-link evaluation.',
      recommendation: 'Use external source links where claims depend on citeable references.',
      details: 'Source links are evaluated on article-like pages only; generic service pages are not expected to cite external sources by default.',
      evidence: { candidatePages: total, sourceSignalPages: sourcePages, missingPages: missingCount },
      findingType: total ? 'opportunity' : 'info',
      confidence: total ? 'high' : 'medium'
    });
  }, { priority: 'Low' });
}

function internalNavLink(id, category, name, needles) {
  return geo(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        finding: `${name}: no HTML pages stored.`,
        evidence: { totalHtmlPages: 0, needles }
      });
    }
    if (id === 'about_linked') {
      const candidates = all(ctx.db, `
        SELECT sourceUrl, sourceUrl AS url, targetUrl, anchorText
        FROM page_links
        WHERE runId = ? AND linkType = 'internal'
        ORDER BY id ASC
        LIMIT 500
      `, [ctx.run.id]);
      const matched = [];
      for (const row of candidates) {
        const match = matchAboutLink(row);
        if (!match) continue;
        matched.push({ ...row, matchedNeedle: match.matchedNeedle, matchSource: match.matchSource });
      }
      const samples = dedupeLinkSamples(matched, 10);
      return makeResult(this, samples.length ? 'OK' : 'Warning', {
        affectedCount: samples.length ? 0 : 1,
        sampleUrls: samples.map((row) => row.sourceUrl || row.url),
        finding: samples.length ? `${samples.length} clear about/company internal link sample(s) found.` : 'No clear about/company internal link found in crawled pages.',
        recommendation: 'Expose the about, company or team page through a crawlable internal link.',
        details: 'Matches require a clear target URL pattern or a concise about/company/team anchor, not incidental body-like anchor text.',
        evidence: {
          strongTargetPatterns: ABOUT_TARGET_PATTERNS.map((item) => item.needle),
          strongAnchorLabels: ABOUT_ANCHOR_LABELS,
          matchedNeedle: samples[0]?.matchedNeedle || null,
          matchSource: samples[0]?.matchSource || null,
          samples
        }
      });
    }
    const conditions = needles.map(() => '(LOWER(targetUrl) LIKE ? OR LOWER(anchorText) LIKE ?)').join(' OR ');
    const params = needles.flatMap((needle) => [`%${needle.toLowerCase()}%`, `%${needle.toLowerCase()}%`]);
    const rows = dedupeLinkSamples(all(ctx.db, `
      SELECT sourceUrl, sourceUrl AS url, targetUrl, anchorText
      FROM page_links
      WHERE runId = ? AND linkType = 'internal' AND (${conditions})
      LIMIT 30
    `, [ctx.run.id, ...params]));
    return makeResult(this, rows.length ? 'OK' : 'Warning', {
      affectedCount: rows.length ? 0 : 1,
      sampleUrls: rows.map((row) => row.sourceUrl || row.url),
      finding: rows.length ? `${rows.length} matching internal link sample(s) found.` : 'No matching internal link found in crawled pages.',
      recommendation: 'Expose important trust/contact pages through crawlable internal links.',
      evidence: { needles, samples: rows }
    });
  }, { priority: 'Low' });
}

function organizationSameAs() {
  return geo('organization_schema_sameas', 'Structured Data', 'Organization Schema mit sameAs vorhanden', function run(ctx) {
    const rows = all(ctx.db, "SELECT pageUrl AS url, rawJson FROM schemas WHERE runId = ? AND schemaType = 'Organization'", [ctx.run.id]);
    const matches = rows.filter((row) => /"sameAs"\s*:/.test(row.rawJson || ''));
    return makeResult(this, matches.length ? 'OK' : 'Warning', {
      affectedCount: matches.length ? 0 : 1,
      sampleUrls: matches.map((row) => row.url),
      finding: matches.length ? 'Organization schema with sameAs found.' : 'Organization schema with sameAs not found.',
      recommendation: 'Add sameAs only for verified official profiles.',
      evidence: { organizationBlocks: rows.length, sameAsBlocks: matches.length, sampleUrls: matches.map((row) => row.url).slice(0, 10) }
    });
  });
}

function schemaPresence(id, category, name, schemaType, priority = 'Medium') {
  return geo(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        finding: `${schemaType} schema could not be evaluated because no HTML pages were stored.`,
        evidence: { totalHtmlPages: 0, schemaType }
      });
    }
    const rows = all(ctx.db, `
      SELECT DISTINCT pageUrl AS url
      FROM schemas
      WHERE runId = ? AND schemaType = ? AND parseStatus = 'ok'
      LIMIT 10
    `, [ctx.run.id, schemaType]);
    return makeResult(this, rows.length ? 'OK' : 'Warning', {
      affectedCount: rows.length ? 0 : 1,
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? `${schemaType} schema found.` : `${schemaType} schema not found.`,
      recommendation: `Use ${schemaType} schema where it accurately matches visible content.`,
      evidence: { schemaType, sampleUrls: rows.map((row) => row.url) },
      reportGroupingKey: schemaType === 'SpeakableSpecification' ? 'schema.speakable' : undefined,
      relatedCheckIds: schemaType === 'SpeakableSpecification' ? ['tech.speakable_missing'] : [],
      findingType: schemaType === 'SpeakableSpecification' ? 'opportunity' : undefined,
      confidence: schemaType === 'SpeakableSpecification' ? 'medium' : 'high'
    });
  }, { priority });
}

function breadcrumbPresence() {
  return geo('breadcrumblist_present', 'Structured Data', 'BreadcrumbList vorhanden', function run(ctx) {
    const candidateWhere = `
      ${HTML_WHERE}
      AND COALESCE(pageType, 'other') NOT IN ('homepage', 'blog_index', 'article_index', 'product_index', 'category_index', 'legal', 'contact')
      AND (
        COALESCE(pageType, 'other') IN ('article', 'product', 'category', 'location')
        OR LOWER(url) LIKE '%/fakta/%'
        OR LOWER(url) LIKE '%/fakten/%'
        OR LOWER(url) LIKE '%/facts/%'
        OR depth > 1
      )`;
    const candidatePages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${candidateWhere}
    `, [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND ${candidateWhere}
        AND COALESCE(schemaTypesJson, '') LIKE '%BreadcrumbList%'
      LIMIT 10
    `, [ctx.run.id]);
    const pagesWithBreadcrumbList = rows.length ? count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${candidateWhere}
        AND COALESCE(schemaTypesJson, '') LIKE '%BreadcrumbList%'
    `, [ctx.run.id]) : 0;
    const coverage = candidatePages ? pagesWithBreadcrumbList / candidatePages : null;
    return makeResult(this, candidatePages ? (rows.length ? 'OK' : 'Warning') : 'NA', {
      affectedCount: candidatePages && !rows.length ? candidatePages : 0,
      sampleUrls: rows.map((row) => row.url),
      finding: candidatePages ? `${pagesWithBreadcrumbList}/${candidatePages} eligible deeper page(s) include BreadcrumbList schema; ${rows.length} sample URL(s) shown.` : 'No deeper eligible pages detected.',
      recommendation: 'Use BreadcrumbList where visible breadcrumbs exist on deeper templates.',
      details: 'Homepage, index, legal and contact pages are excluded from this GEO signal.',
      evidence: { eligiblePages: candidatePages, pagesWithBreadcrumbList, coverage, samplePresentUrls: rows.map((row) => row.url) },
      findingType: 'opportunity',
      confidence: 'high'
    });
  }, { priority: 'Low' });
}

function articleBlogWithArticleSchema() {
  return geo('article_blog_pages_article_schema', 'Structured Data', 'Article/Blog-Seiten mit Article Schema', function run(ctx) {
    const candidateCount = count(ctx.db, "SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND pageType = 'article'", [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND pageType = 'article' AND COALESCE(schemaTypesJson, '') NOT LIKE '%Article%'
      LIMIT 10
    `, [ctx.run.id]);
    const status = candidateCount ? (rows.length ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      affectedCount: rows.length,
      sampleUrls: rows.map((row) => row.url),
      finding: candidateCount ? `${rows.length}/${candidateCount} article page(s) lack Article schema.` : 'No article pages detected by stored heuristics.',
      recommendation: 'Use Article schema on qualifying editorial pages.',
      details: "Evaluated only pages classified as pageType='article'.",
      evidence: { candidateCount, missingArticleSchemaSamples: rows.map((row) => row.url) },
      findingType: 'opportunity',
      reportGroupingKey: 'schema.article',
      relatedCheckIds: ['tech.article_coverage_on_article_like_pages']
    });
  });
}

function lowStructuredSections() {
  return geo('low_structured_sections', 'Content Structure', 'Seiten mit wenig strukturierten Abschnitten markieren', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND featureFlagsJson LIKE '%"lowStructuredSections":true%'
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND featureFlagsJson LIKE '%"lowStructuredSections":true%'
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} page(s) have low structured-section signals.` : 'No low-structure pages detected by stored heuristics.',
      recommendation: 'Add meaningful headings, lists or tables only where they improve content structure.',
      evidence: { affectedCount, sampleUrls: rows.map((row) => row.url) }
    });
  }, { priority: 'Low' });
}

function matchAboutLink(row) {
  const targetPath = normalizedPath(row.targetUrl);
  for (const item of ABOUT_TARGET_PATTERNS) {
    if (item.pattern.test(targetPath)) return { matchedNeedle: item.needle, matchSource: 'targetUrl' };
  }
  const anchor = normalizeAnchor(row.anchorText);
  if (ABOUT_ANCHOR_LABELS.includes(anchor)) {
    return { matchedNeedle: anchor, matchSource: 'anchor' };
  }
  return null;
}

function normalizedPath(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    return safeDecode(new URL(input).pathname).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    const withoutQuery = input.split(/[?#]/)[0] || '';
    return safeDecode(withoutQuery).toLowerCase().replace(/\/+$/, '') || '/';
  }
}

function normalizeAnchor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|:;,.!?]+$/g, '')
    .trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value || '');
  }
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
