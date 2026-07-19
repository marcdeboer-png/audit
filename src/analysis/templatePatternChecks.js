import { all, count, makeResult } from '../checks/helpers.js';
import { thresholdBytes, thresholds } from '../checks/config/thresholds.js';
import {
  CANONICAL_VALIDATION_LOGIC_VERSION,
  canonicalTargetFacts,
  evaluateCanonicalPage
} from '../checks/canonicalSemantics.js';

const CANONICAL_PATTERN_MIN_EVALUATED = 3;
const CANONICAL_PATTERN_MIN_AFFECTED = 3;
const CANONICAL_PATTERN_MIN_SHARE = 0.5;
const CANONICAL_PATTERN_MIN_EVIDENCE_COVERAGE = 0.8;
const CANONICAL_ELIGIBLE_WHERE = `
  (contentType LIKE '%text/html%' OR contentType LIKE '%application/xhtml%')
  AND statusCode >= 200 AND statusCode < 300
  AND COALESCE(initialStatusCode, statusCode) >= 200 AND COALESCE(initialStatusCode, statusCode) < 300
  AND COALESCE(indexable, 1) = 1
  AND COALESCE(pageType, 'other') <> 'legal'
`;

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
  }, { priority: 'Low', effort: 'M' });
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
  }, { priority: 'Low', effort: 'M' });
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
        pageType = 'article'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%Article%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%BlogPosting%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%NewsArticle%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%Report%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%ScholarlyArticle%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%SocialMediaPosting%'
        AND COALESCE(schemaTypesJson, '') NOT LIKE '%TechArticle%'
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
  }, { priority: 'Low', effort: 'M' });
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
  }, { priority: 'Low', effort: 'L' });
}

function canonicalPatternIssue() {
  return templateCheck('template.canonical_pattern_issue', 'Template canonical pattern issue', function run(ctx) {
    const rows = canonicalPatternRows(ctx);
    return patternResult(this, rows, {
      issueLabel: 'canonical generation pattern',
      finding: rows.length
        ? `${sumAffected(rows)} URL(s) across ${rows.length} template/page-type pattern(s) have canonical generation issues.`
        : 'No systematic canonical template pattern detected.',
      recommendation: 'Fix canonical rules in templates and validate status/indexability of canonical targets.',
      priority: 'High',
      patternThreshold: `evaluated >= ${CANONICAL_PATTERN_MIN_EVALUATED}, affected >= ${CANONICAL_PATTERN_MIN_AFFECTED}, affected share >= ${CANONICAL_PATTERN_MIN_SHARE}, evidence coverage >= ${CANONICAL_PATTERN_MIN_EVIDENCE_COVERAGE}`,
      logicVersion: CANONICAL_VALIDATION_LOGIC_VERSION,
      requirements: {
        requiredFacts: ['successfulIndexableHtmlPages', 'completeEffectiveCanonicalState', 'homogeneousTemplateOrPageTypeScope'],
        optionalFacts: ['knownCanonicalTargetGetMeasurement'],
        missingFacts: [],
        minimumCoverage: CANONICAL_PATTERN_MIN_EVIDENCE_COVERAGE,
        canCollectWithTargetedRun: true
      }
    });
  }, { priority: 'High', effort: 'M' });
}

function canonicalPatternRows(ctx) {
  const current = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${CANONICAL_ELIGIBLE_WHERE} AND rawDocumentStateJson IS NOT NULL`, [ctx.run.id]) > 0;
  const pages = all(ctx.db, `
    SELECT id, url, normalizedUrl, finalUrl, canonical, effectiveCanonical,
      rawDocumentStateJson, effectiveDocumentStateJson, metadataProvenanceComplete,
      pageType, templateClusterKey, statusCode, initialStatusCode, redirectChainJson, contentType
    FROM pages WHERE runId = ? AND ${CANONICAL_ELIGIBLE_WHERE}
    ORDER BY id
  `, [ctx.run.id]);
  const targetRows = all(ctx.db, `SELECT url, normalizedUrl, finalUrl, statusCode, initialStatusCode, redirectChainJson, contentType FROM pages WHERE runId = ?`, [ctx.run.id]);
  const groups = new Map();
  for (const page of pages) {
    const patternKey = page.templateClusterKey || `${page.pageType || 'other'}:unclustered`;
    const evaluated = !current || Number(page.metadataProvenanceComplete) === 1;
    const issueType = evaluated ? canonicalPatternIssueType(evaluateCanonicalPage(page, ctx.project.finalDomain, current), targetRows) : null;
    addCanonicalPatternObservation(groups, {
      key: `${patternKey}\n${page.pageType || 'other'}`,
      patternKey,
      pageType: page.pageType || 'other',
      scopeSource: page.templateClusterKey ? 'template_fingerprint' : 'page_type_fallback'
    }, page.url, evaluated, issueType);
    addCanonicalPatternObservation(groups, {
      key: 'site:all\nmixed',
      patternKey: 'site:all',
      pageType: 'mixed',
      scopeSource: 'sitewide'
    }, page.url, evaluated, issueType);
  }

  const output = [];
  for (const group of groups.values()) {
    const evidenceCoverage = group.totalInPattern ? group.evaluatedCount / group.totalInPattern : 0;
    for (const [issueType, issue] of group.issues) {
      const affectedShare = group.evaluatedCount ? issue.affectedCount / group.evaluatedCount : 0;
      if (group.evaluatedCount < CANONICAL_PATTERN_MIN_EVALUATED) continue;
      if (issue.affectedCount < CANONICAL_PATTERN_MIN_AFFECTED) continue;
      if (affectedShare < CANONICAL_PATTERN_MIN_SHARE) continue;
      if (evidenceCoverage < CANONICAL_PATTERN_MIN_EVIDENCE_COVERAGE) continue;
      output.push({
        patternKey: group.patternKey,
        pageType: group.pageType,
        scopeSource: group.scopeSource,
        issueType,
        affectedCount: issue.affectedCount,
        totalInPattern: group.totalInPattern,
        evaluatedCount: group.evaluatedCount,
        evidenceCoverage: Number(evidenceCoverage.toFixed(3)),
        affectedShare: Number(affectedShare.toFixed(3)),
        sampleUrls: issue.sampleUrls,
        confidence: group.evaluatedCount >= 5 && evidenceCoverage === 1 ? 'high' : 'medium',
        rootCauseKey: `canonical_pattern:${group.patternKey}:${issueType}`,
        affectedUrls: issue.affectedUrls
      });
    }
  }
  const specific = output.filter((row) => row.scopeSource !== 'sitewide');
  const coveredByIssue = new Map();
  for (const row of specific) {
    const covered = coveredByIssue.get(row.issueType) || new Set();
    for (const url of row.affectedUrls) covered.add(url);
    coveredByIssue.set(row.issueType, covered);
  }
  const sitewide = output.filter((row) => row.scopeSource === 'sitewide').filter((row) => {
    const covered = coveredByIssue.get(row.issueType) || new Set();
    return covered.size === 0;
  });
  return [...specific, ...sitewide].sort((left, right) => right.affectedCount - left.affectedCount || left.rootCauseKey.localeCompare(right.rootCauseKey));
}

function addCanonicalPatternObservation(groups, scope, url, evaluated, issueType) {
  const group = groups.get(scope.key) || {
    patternKey: scope.patternKey,
    pageType: scope.pageType,
    scopeSource: scope.scopeSource,
    totalInPattern: 0,
    evaluatedCount: 0,
    issues: new Map()
  };
  group.totalInPattern += 1;
  if (evaluated) {
    group.evaluatedCount += 1;
    if (issueType) {
      const issue = group.issues.get(issueType) || { affectedCount: 0, sampleUrls: [], affectedUrls: [] };
      issue.affectedCount += 1;
      issue.affectedUrls.push(url);
      if (issue.sampleUrls.length < 10) issue.sampleUrls.push(url);
      group.issues.set(issueType, issue);
    }
  }
  groups.set(scope.key, group);
}

function canonicalPatternIssueType(evaluation, targetRows) {
  if (evaluation.missing) return 'canonical_missing';
  if (evaluation.conflict) return 'conflicting_canonical_tags';
  const targetIssue = canonicalTargetFacts(evaluation, targetRows).find((target) => target.known && (target.finalNon200 || target.finalNonHtml || target.initialRedirect));
  if (targetIssue) return targetIssue.issueType;
  if (evaluation.crossDomainValues.length) return 'cross_registrable_domain';
  if (!evaluation.isSelf) return 'canonical_non_self';
  return null;
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
      patternThreshold: options.patternThreshold || 'affectedCount >= 3 and >= 50% of pattern URLs unless check-specific threshold differs',
      logicVersion: options.logicVersion || null,
      patterns: rows.map((row) => ({
        patternKey: row.patternKey,
        pageType: row.pageType,
        affectedCount: row.affectedCount,
        totalInPattern: row.totalInPattern,
        affectedShare: row.affectedShare ?? (row.totalInPattern ? Number((row.affectedCount / row.totalInPattern).toFixed(3)) : null),
        evaluatedCount: row.evaluatedCount,
        evidenceCoverage: row.evidenceCoverage,
        scopeSource: row.scopeSource,
        issueType: row.issueType,
        confidence: row.confidence,
        rootCauseKey: row.rootCauseKey,
        sampleUrls: row.sampleUrls || [],
        avgTitleLength: row.avgTitleLength,
        avgMetaDescriptionLength: row.avgMetaDescriptionLength,
        avgRawHtmlSize: row.avgRawHtmlSize,
        distinctCanonicals: row.distinctCanonicals,
        affectedPageTypes: row.affectedPageTypes
      })),
      rootCauseCandidates: rows.map((row) => ({
        key: row.rootCauseKey || `template.pattern:${row.patternKey}`,
        family: 'tech.canonical_pattern',
        occurrenceCount: Number(row.affectedCount || 0),
        affectedUrlCount: Number(row.affectedCount || 0),
        scopeType: 'template',
        deduplicationConfidence: 'high',
        reason: row.issueType ? `Homogeneous canonical pattern: ${row.issueType}.` : 'Template pattern.'
      }))
    },
    findingType: options.findingType || 'core_issue',
    scoreEligible: false,
    scoreExclusionReason: 'Derived template roll-up; the underlying page-level check owns any score impact.',
    confidence: rows.length > 1 || affectedCount >= 10 ? 'high' : rows.length ? 'medium' : 'high',
    reviewRecommended: rows.length > 0,
    reportGroupingKey: 'template.patterns',
    requirements: options.requirements
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
  if (rows.some((row) => Array.isArray(row.affectedUrls))) {
    return new Set(rows.flatMap((row) => row.affectedUrls || [])).size;
  }
  return rows.reduce((sum, row) => sum + Number(row.affectedCount || 0), 0);
}
