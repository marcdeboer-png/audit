import { all, count, makeResult } from '../checks/helpers.js';
import { thresholdBytes, thresholds } from '../checks/config/thresholds.js';

const templateCheck = (id, name, run, options = {}) => ({
  id,
  category: 'Template Pattern Analysis',
  name,
  auditType: 'tech',
  priority: options.priority || 'Medium',
  effort: options.effort || 'M',
  recommendation: options.recommendation || '',
  run
});

export function templatePatternChecks() {
  return [
    titlePatternIssue(),
    metaPatternIssue(),
    noindexPattern(),
    schemaMissingPattern(),
    largeHtmlPattern(),
    canonicalPatternIssue()
  ];
}

function titlePatternIssue() {
  return templateCheck('template.title_pattern_issue', 'Template title pattern issue', function run(ctx) {
    const rows = patternRows(ctx.db, ctx.run.id, `
      title IS NULL OR title = '' OR titleLength > ${thresholds.titleTooLong} OR titleLength < ${thresholds.titleTooShort}
    `, {
      extraSelect: 'AVG(titleLength) AS avgTitleLength',
      minAffected: 3
    });
    return patternResult(this, rows, {
      issueLabel: 'title length/missing pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) have systematic title issues.`
        : 'No systematic title pattern issue detected.',
      recommendation: 'Fix title generation at template level rather than editing individual URLs.'
    });
  }, { priority: 'High', effort: 'M' });
}

function metaPatternIssue() {
  return templateCheck('template.meta_pattern_issue', 'Template meta description pattern issue', function run(ctx) {
    const rows = patternRows(ctx.db, ctx.run.id, `
      metaDescription IS NULL OR metaDescription = '' OR metaDescriptionLength > ${thresholds.descriptionTooLong} OR metaDescriptionLength < ${thresholds.descriptionTooShort}
    `, {
      extraSelect: 'AVG(metaDescriptionLength) AS avgMetaDescriptionLength',
      minAffected: 3
    });
    return patternResult(this, rows, {
      issueLabel: 'meta description generation pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) have systematic meta description issues.`
        : 'No systematic meta description pattern issue detected.',
      recommendation: 'Adjust meta description generation at template level and validate representative pages.'
    });
  }, { priority: 'Medium', effort: 'M' });
}

function noindexPattern() {
  return templateCheck('template.noindex_pattern', 'Template noindex pattern', function run(ctx) {
    const rows = patternRows(ctx.db, ctx.run.id, `
      COALESCE(noindex, 0) = 1 OR LOWER(COALESCE(metaRobots, '') || ' ' || COALESCE(xRobotsTag, '')) LIKE '%noindex%'
    `, {
      minAffected: 2,
      whereExtra: "AND COALESCE(pageType, 'other') <> 'legal'"
    });
    return patternResult(this, rows, {
      issueLabel: 'noindex directive pattern',
      finding: rows.length
        ? `${sumAffected(rows)} non-legal URL(s) across ${rows.length} template/page-type pattern(s) carry noindex.`
        : 'No non-legal noindex template pattern detected.',
      recommendation: 'Review template-level robots directives and remove noindex where indexable content is intended.',
      priority: 'High'
    });
  }, { priority: 'High', effort: 'S' });
}

function schemaMissingPattern() {
  return templateCheck('template.schema_missing_pattern', 'Template schema missing pattern', function run(ctx) {
    const where = `
      (
        pageType = 'article' AND COALESCE(schemaTypesJson, '') NOT LIKE '%Article%'
      ) OR (
        pageType = 'product' AND COALESCE(schemaTypesJson, '') NOT LIKE '%Product%'
      ) OR (
        pageType = 'location' AND COALESCE(schemaTypesJson, '') NOT LIKE '%LocalBusiness%'
      ) OR (
        COALESCE(pageType, 'other') IN ('article', 'product', 'category', 'location')
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%BreadcrumbList%'
      )
    `;
    const rows = patternRows(ctx.db, ctx.run.id, where, {
      extraSelect: 'GROUP_CONCAT(DISTINCT pageType) AS affectedPageTypes',
      minAffected: 3
    });
    return patternResult(this, rows, {
      issueLabel: 'structured data coverage pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) miss expected schema coverage.`
        : 'No systematic schema-missing template pattern detected.',
      recommendation: 'Add schema at template level where visible content supports it.',
      findingType: 'opportunity'
    });
  }, { priority: 'Medium', effort: 'M' });
}

function largeHtmlPattern() {
  return templateCheck('template.large_html_pattern', 'Template large HTML pattern', function run(ctx) {
    const rows = patternRows(ctx.db, ctx.run.id, `rawHtmlSize > ${thresholdBytes.largeHtmlBytes}`, {
      extraSelect: 'AVG(rawHtmlSize) AS avgRawHtmlSize',
      minAffected: 3
    });
    return patternResult(this, rows, {
      issueLabel: 'large HTML template pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) exceed ${thresholds.largeHtmlKb} KB raw HTML.`
        : 'No systematic large-HTML template pattern detected.',
      recommendation: 'Reduce template HTML weight, duplicated markup and server-rendered payload bloat.'
    });
  }, { priority: 'Medium', effort: 'L' });
}

function canonicalPatternIssue() {
  return templateCheck('template.canonical_pattern_issue', 'Template canonical pattern issue', function run(ctx) {
    const rows = patternRows(ctx.db, ctx.run.id, `
      canonical IS NULL OR canonical = '' OR canonical <> normalizedUrl OR COALESCE(canonicalStatus, '') GLOB '*4*' OR COALESCE(canonicalStatus, '') GLOB '*5*'
    `, {
      extraSelect: 'COUNT(DISTINCT canonical) AS distinctCanonicals',
      minAffected: 3
    });
    return patternResult(this, rows, {
      issueLabel: 'canonical generation pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) have canonical generation issues.`
        : 'No systematic canonical template pattern detected.',
      recommendation: 'Fix canonical rules in templates and validate status/indexability of canonical targets.',
      priority: 'High'
    });
  }, { priority: 'High', effort: 'M' });
}

function patternRows(db, runId, issueWhere, options = {}) {
  const minAffected = Number(options.minAffected || 3);
  const whereExtra = options.whereExtra || '';
  const extraSelect = options.extraSelect ? `, ${options.extraSelect}` : '';
  return all(db, `
    SELECT
      COALESCE(templateClusterKey, COALESCE(pageType, 'other') || ':unclustered') AS patternKey,
      COALESCE(pageType, 'other') AS pageType,
      COUNT(*) AS affectedCount,
      (SELECT COUNT(*) FROM pages allp WHERE allp.runId = p.runId AND COALESCE(allp.templateClusterKey, COALESCE(allp.pageType, 'other') || ':unclustered') = COALESCE(p.templateClusterKey, COALESCE(p.pageType, 'other') || ':unclustered')) AS totalInPattern,
      (SELECT sampleUrlsJson FROM template_clusters tc WHERE tc.runId = p.runId AND tc.clusterKey = p.templateClusterKey LIMIT 1) AS templateSampleUrlsJson
      ${extraSelect}
    FROM pages p
    WHERE p.runId = ?
      AND (p.contentType LIKE '%text/html%' OR p.contentType LIKE '%application/xhtml%' OR p.contentType IS NULL)
      ${whereExtra}
      AND (${issueWhere})
    GROUP BY patternKey, pageType
    HAVING affectedCount >= ? AND affectedCount >= MAX(2, totalInPattern * 0.5)
    ORDER BY affectedCount DESC, totalInPattern DESC, patternKey ASC
    LIMIT 20
  `, [runId, minAffected]).map((row) => ({
    ...row,
    sampleUrls: sampleUrlsForPattern(db, runId, row.patternKey, issueWhere, options.whereExtra)
  }));
}

function patternResult(check, rows, options = {}) {
  const sampleUrls = rows.flatMap((row) => row.sampleUrls || []).slice(0, 10);
  const affectedCount = sumAffected(rows);
  return makeResult(check, rows.length ? 'Warning' : 'OK', {
    priority: options.priority || check.priority,
    affectedCount,
    sampleUrls,
    finding: options.finding,
    recommendation: options.recommendation,
    details: rows.length
      ? `Pattern-level finding: ${options.issueLabel}. ${rows.length} impacted template/page-type group(s).`
      : 'No affected template/page-type group passed the pattern threshold.',
    evidence: {
      issueLabel: options.issueLabel,
      patternThreshold: 'affectedCount >= 3 and >= 50% of pattern URLs unless check-specific threshold differs',
      patterns: rows.map((row) => ({
        patternKey: row.patternKey,
        pageType: row.pageType,
        affectedCount: row.affectedCount,
        totalInPattern: row.totalInPattern,
        affectedShare: row.totalInPattern ? Number((row.affectedCount / row.totalInPattern).toFixed(3)) : null,
        sampleUrls: row.sampleUrls || [],
        avgTitleLength: row.avgTitleLength,
        avgMetaDescriptionLength: row.avgMetaDescriptionLength,
        avgRawHtmlSize: row.avgRawHtmlSize,
        distinctCanonicals: row.distinctCanonicals,
        affectedPageTypes: row.affectedPageTypes
      }))
    },
    findingType: options.findingType || 'core_issue',
    confidence: rows.length > 1 || affectedCount >= 10 ? 'high' : rows.length ? 'medium' : 'high',
    reviewRecommended: rows.length > 0,
    reportGroupingKey: 'template.patterns'
  });
}

function sampleUrlsForPattern(db, runId, patternKey, issueWhere, whereExtra = '') {
  return all(db, `
    SELECT url
    FROM pages p
    WHERE p.runId = ?
      AND COALESCE(templateClusterKey, COALESCE(pageType, 'other') || ':unclustered') = ?
      ${whereExtra || ''}
      AND (${issueWhere})
    ORDER BY id ASC
    LIMIT 10
  `, [runId, patternKey]).map((row) => row.url);
}

function sumAffected(rows) {
  return rows.reduce((sum, row) => sum + Number(row.affectedCount || 0), 0);
}
