import { applyEffectiveValues } from '../reviews/reviewWorkflow.js';
import { applyDisplaySemantics } from '../reviews/displaySemantics.js';
import { thresholds } from '../checks/config/thresholds.js';
import { retentionPolicyFromRun } from '../storage/retention.js';
import { createRunScope, requireRunId, scopeSafeCheckResult } from '../scope/runScope.js';

const DETAIL_LIMIT = 10000;
const NON_DECORATIVE_IMAGE_DETAIL_WHERE = `
  COALESCE(likelyDecorativeImage, 0) = 0
  AND COALESCE(likelyBadgeImage, 0) = 0
  AND COALESCE(likelyTrackingPixel, 0) = 0
  AND COALESCE(likelyIcon, 0) = 0
`;
const NOT_SMALL_IMAGE_DETAIL_WHERE = `
  (
    NULLIF(width, '') IS NULL OR
    NULLIF(height, '') IS NULL OR
    CAST(width AS INTEGER) > 64 OR
    CAST(height AS INTEGER) > 64
  )
`;
const NOT_LIKELY_HERO_IMAGE_DETAIL_WHERE = `
  COALESCE(imageRole, '') <> 'hero'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%hero%'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%masthead%'
  AND LOWER(COALESCE(imageUrl, '')) NOT LIKE '%banner%'
`;

export function getCheckDetail(db, runId, checkResultId, options = {}) {
  requireRunId(runId, 'load check detail');
  let checkResult = loadCheckResult(db, runId, checkResultId);
  if (!checkResult) return null;
  const run = db.prepare(`
    SELECT r.*, p.inputDomain, p.finalDomain
    FROM runs r JOIN projects p ON p.id = r.projectId
    WHERE r.id = ?
  `).get(runId) || {};
  if (run.id) {
    const scope = createRunScope(run, { id: run.projectId, inputDomain: run.inputDomain, finalDomain: run.finalDomain });
    checkResult = scopeSafeCheckResult(checkResult, scope, { id: checkResult.checkId });
  }
  const policy = retentionPolicyFromRun(run);
  const requestedRows = Number(options.maxRows || policy.maxStoredDetailRowsPerCheck || DETAIL_LIMIT);
  const maxRows = Math.max(1, Math.min(DETAIL_LIMIT, policy.maxStoredDetailRowsPerCheck || DETAIL_LIMIT, requestedRows));
  const context = {
    db,
    runId,
    checkResult,
    recommendation: checkResult.effectiveRecommendation || checkResult.recommendation || ''
  };
  const detail = handlerFor(checkResult)(context);
  const rows = normalizeRows(detail.rows || []).slice(0, maxRows);
  const columns = withReviewColumns(rows.length
    ? normalizeColumns(detail.columns || columnsFromRows(rows))
    : normalizeColumns([
        ['info', 'Info'],
        ['value', 'Value'],
        ['recommendation', 'Recommendation']
      ]));
  const enrichedRows = rows.length
    ? rows.map((row) => addReviewFields(row, checkResult))
    : [addReviewFields({
        info: checkResult.affectedCount
          ? detail.emptyMessage || 'For this check only stored sample/evidence data is available.'
          : 'No affected rows for this check',
        value: checkResult.effectiveFinding || checkResult.finding || '',
        recommendation: context.recommendation
      }, checkResult)];
  const renderProvenanceRows = pageRenderProvenanceForRows(db, runId, enrichedRows);

  return {
    checkId: checkResult.checkId,
    checkResultId: checkResult.id,
    title: checkResult.checkName,
    category: checkResult.category,
    status: checkResult.status,
    priority: checkResult.priority,
    rawStatus: checkResult.status,
    rawPriority: checkResult.priority,
    rawFindingType: checkResult.findingType,
    effectiveStatus: checkResult.effectiveStatus,
    effectivePriority: checkResult.effectivePriority,
    displayPriority: checkResult.displayPriority,
    findingType: checkResult.findingType,
    normalizedFindingType: checkResult.normalizedFindingType,
    displayFindingType: checkResult.normalizedFindingType || checkResult.findingType || 'info',
    confidence: checkResult.confidence,
    reviewRecommended: checkResult.reviewRecommended,
    displayStatus: checkResult.displayStatus,
    reviewStatus: checkResult.reviewStatus || 'unreviewed',
    actionStatus: checkResult.actionStatus || 'open',
    displayReviewStatus: checkResult.displayReviewStatus,
    displayActionStatus: checkResult.displayActionStatus,
    displayReviewRecommended: checkResult.displayReviewRecommended,
    isActionable: checkResult.isActionable,
    reportSection: checkResult.reportSection,
    affectedCount: checkResult.affectedCount || 0,
    sampleUrls: checkResult.sampleUrls,
    evaluationState: checkResult.evaluationState,
    scoreEligible: Boolean(checkResult.scoreEligible),
    scoreExclusionReason: checkResult.scoreExclusionReason || null,
    scoreDeduplicationKey: checkResult.scoreDeduplicationKey || null,
    rootCauseId: checkResult.rootCauseId || null,
    rootCauseKey: checkResult.rootCauseKey || null,
    rootCauseFamily: checkResult.rootCauseFamily || null,
    scopeType: checkResult.scopeType || null,
    occurrenceCount: Number(checkResult.occurrenceCount || 0),
    affectedUrlCount: Number(checkResult.affectedUrlCount || checkResult.affectedCount || 0),
    displayedSampleCount: Number(checkResult.displayedSampleCount || checkResult.sampleUrls?.length || 0),
    primaryCheckId: checkResult.primaryCheckId || null,
    deduplicationConfidence: checkResult.deduplicationConfidence || null,
    deduplicationReason: checkResult.deduplicationReason || null,
    rootCauseMemberships: checkResult.rootCauseMemberships || [],
    facts: checkResult.facts,
    evidence: checkResult.evidence,
    assessment: checkResult.assessment,
    recommendationMeta: checkResult.recommendationMeta,
    requirements: checkResult.requirements,
    provenance: checkResult.provenance,
    renderProvenance: hasRenderProvenance(db, runId) ? {
      available: true,
      model: 'raw/initial/settled/effective',
      exportType: 'render-provenance',
      note: 'Page-level field provenance is available here, in the render-provenance CSV and in the full JSON URL inventory.',
      rows: renderProvenanceRows
    } : {
      available: false,
      model: null,
      exportType: null,
      note: 'This historical run has no stored render provenance.'
    },
    checkVersion: checkResult.checkVersion || checkResult.provenance?.checkVersion || null,
    context: buildNarrative(checkResult, detail),
    columns,
    rows: enrichedRows,
    rowCount: enrichedRows.length,
    truncated: (detail.rows || []).length > maxRows,
    storedRows: enrichedRows.length,
    totalAffected: checkResult.affectedCount || (detail.rows || []).length,
    howToIncreaseLimit: (detail.rows || []).length > maxRows
      ? 'Raise maxStoredDetailRowsPerCheck or use debug profile for a targeted small run.'
      : null,
    storageProfile: run.storageProfile || 'standard',
    dataSource: detail.dataSource || 'stored crawl data'
  };
}

function loadCheckResult(db, runId, checkResultId) {
  const row = db.prepare(`
    SELECT
      cr.*,
      fr.id AS reviewId,
      fr.reviewStatus,
      fr.reviewerName,
      fr.note AS reviewNote,
      fr.manualStatus,
      fr.manualPriority,
      fr.manualEffort,
      fr.manualFinding,
      fr.manualRecommendation,
      fr.actionStatus,
      fr.createdAt AS reviewCreatedAt,
      fr.updatedAt AS reviewUpdatedAt
    FROM check_results cr
    LEFT JOIN finding_reviews fr ON fr.runId = cr.runId AND fr.checkResultId = cr.id
    WHERE cr.runId = ? AND cr.id = ?
  `).get(runId, checkResultId);
  if (!row) return null;
  return applyDisplaySemantics(applyEffectiveValues({
    ...row,
    auditType: row.checkId.startsWith('geo.') || row.checkId.startsWith('trust.') || row.checkId.startsWith('llm.') ? 'geo' : 'tech',
    sampleUrls: safeJson(row.sampleUrlsJson, []),
    evidence: safeJson(row.evidenceJson, {}),
    facts: safeJson(row.factsJson, {}),
    assessment: safeJson(row.assessmentJson, {}),
    recommendationMeta: safeJson(row.recommendationMetaJson, {}),
    requirements: safeJson(row.requirementsJson, {}),
    provenance: safeJson(row.provenanceJson, {}),
    relatedCheckIds: safeJson(row.relatedCheckIdsJson, []),
    rootCauseMemberships: safeJson(row.rootCauseMembershipsJson, [])
  }));
}

function handlerFor(checkResult) {
  const id = checkResult.checkId;
  if (/title_(missing|too_short|too_long)$/.test(id)) return titleDetails;
  if (/meta_description_(missing|too_short|too_long)$/.test(id)) return metaDescriptionDetails;
  if (/canonical_(missing|non_self|to_other_domain|target_non_200)$/.test(id)) return canonicalDetails;
  if (/images_without_alt|empty_alt_texts|images_without_width_height|images_without_lazy_loading/.test(id)) return imageMarkupDetails;
  if (/large_image_resources/.test(id)) return largeImageDetails;
  if (/4xx_pages|5xx_pages|redirect_pages|sitemap_urls_non_200/.test(id)) return statusPageDetails;
  if (/internal_links_to_3xx|internal_links_to_4xx_5xx/.test(id)) return internalLinkDetails;
  if (/h1_missing|multiple_h1/.test(id)) return h1Details;
  if (/duplicate_titles|duplicate_meta_descriptions/.test(id)) return duplicateMetaDetails;
  if (/open_graph_basics_missing/.test(id)) return openGraphDetails;
  if (/charset_utf8_present/.test(id)) return charsetDetails;
  if (/hsts_header|content_security_policy|x_frame_options|x_content_type_options|referrer_policy|permissions_policy|compression_header|cache_control_header/.test(id)) return headerPresenceDetails;
  if (/high_ttfb/.test(id)) return ttfbDetails;
  if (/^template\./.test(id)) return templatePerformanceDetails;
  if (/llms/.test(id) || /markdown_twin/.test(id)) return llmsDetails;
  if (/ai_bots_policy|robots_mentions_/.test(id)) return aiBotPolicyDetails;
  if (/structured data|schema|article|product|breadcrumb|faq|speakable|localbusiness|organization/i.test(`${id} ${checkResult.category}`)) return structuredDataDetails;
  return genericDetails;
}

function titleDetails({ db, runId, checkResult, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  return pageRows({
    db,
    runId,
    where: pageCondition(checkResult.checkId, {
      'tech.title_missing': `${indexableContentHtmlWhere()} AND ${current ? 'COALESCE(metadataProvenanceComplete, 0) = 1 AND (effectiveTitle IS NULL OR effectiveTitle = \'\')' : "(title IS NULL OR title = '')"}`,
      'tech.title_too_short': `${indexableContentHtmlWhere()} AND ${current ? `COALESCE(metadataProvenanceComplete, 0) = 1 AND LENGTH(effectiveTitle) < ${thresholds.titleTooShort} AND COALESCE(effectiveTitle, '') <> ''` : `titleLength < ${thresholds.titleTooShort} AND COALESCE(title, '') <> ''`}`,
      'tech.title_too_long': `${indexableContentHtmlWhere()} AND ${current ? `COALESCE(metadataProvenanceComplete, 0) = 1 AND LENGTH(effectiveTitle) > ${thresholds.titleTooLong}` : `titleLength > ${thresholds.titleTooLong}`}`
    }),
    columns: [
      ['url', 'URL'],
      ['title', 'Title'],
      ['titleLength', 'Title Length'],
      ['statusCode', 'Status Code'],
      ['pageType', 'Page Type'],
      ['indexable', 'Indexable'],
      ['recommendation', 'Recommendation']
    ],
    select: current
      ? 'url, title AS rawTitle, effectiveTitle AS title, effectiveTitle, LENGTH(effectiveTitle) AS titleLength, statusCode, pageType, indexable, renderStatus, settlingStatus'
      : 'url, title, title AS rawTitle, title AS effectiveTitle, titleLength, statusCode, pageType, indexable, renderStatus, settlingStatus',
    recommendation,
    dataSource: 'pages'
  });
}

function metaDescriptionDetails({ db, runId, checkResult, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  return pageRows({
    db,
    runId,
    where: pageCondition(checkResult.checkId, {
      'tech.meta_description_missing': `${indexableContentHtmlWhere()} AND ${current ? 'COALESCE(metadataProvenanceComplete, 0) = 1 AND (effectiveMetaDescription IS NULL OR effectiveMetaDescription = \'\')' : "(metaDescription IS NULL OR metaDescription = '')"}`,
      'tech.meta_description_too_short': `${indexableContentHtmlWhere()} AND ${current ? `COALESCE(metadataProvenanceComplete, 0) = 1 AND LENGTH(effectiveMetaDescription) < ${thresholds.descriptionTooShort} AND COALESCE(effectiveMetaDescription, '') <> ''` : `metaDescriptionLength < ${thresholds.descriptionTooShort} AND COALESCE(metaDescription, '') <> ''`}`,
      'tech.meta_description_too_long': `${indexableContentHtmlWhere()} AND ${current ? `COALESCE(metadataProvenanceComplete, 0) = 1 AND LENGTH(effectiveMetaDescription) > ${thresholds.descriptionTooLong}` : `metaDescriptionLength > ${thresholds.descriptionTooLong}`}`
    }),
    columns: [
      ['url', 'URL'],
      ['metaDescription', 'Meta Description'],
      ['metaDescriptionLength', 'Meta Description Length'],
      ['statusCode', 'Status Code'],
      ['pageType', 'Page Type'],
      ['indexable', 'Indexable'],
      ['recommendation', 'Recommendation']
    ],
    select: current
      ? 'url, metaDescription AS rawMetaDescription, effectiveMetaDescription AS metaDescription, effectiveMetaDescription, LENGTH(effectiveMetaDescription) AS metaDescriptionLength, statusCode, pageType, indexable, renderStatus, settlingStatus'
      : 'url, metaDescription, metaDescription AS rawMetaDescription, metaDescription AS effectiveMetaDescription, metaDescriptionLength, statusCode, pageType, indexable, renderStatus, settlingStatus',
    recommendation,
    dataSource: 'pages'
  });
}

function canonicalDetails({ db, runId, checkResult, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  const canonical = current ? 'effectiveCanonical' : 'canonical';
  const acceptedHost = checkResult.evidence?.acceptedHost || null;
  const otherDomainCondition = acceptedHost
    ? `source.${canonical} IS NOT NULL AND source.${canonical} <> '' AND
      source.${canonical} NOT LIKE 'https://${escapeSqlLike(acceptedHost)}%' AND source.${canonical} NOT LIKE 'http://${escapeSqlLike(acceptedHost)}%' AND
      source.${canonical} NOT LIKE 'https://www.${escapeSqlLike(acceptedHost)}%' AND source.${canonical} NOT LIKE 'http://www.${escapeSqlLike(acceptedHost)}%'`
    : `source.${canonical} IS NOT NULL AND source.${canonical} <> source.normalizedUrl`;
  const where = pageCondition(checkResult.checkId, {
    'tech.canonical_missing': `${htmlWhere('source')} ${current ? 'AND COALESCE(source.metadataProvenanceComplete, 0) = 1' : ''} AND (source.${canonical} IS NULL OR source.${canonical} = '')`,
    'tech.canonical_non_self': `source.${canonical} IS NOT NULL AND source.${canonical} <> source.normalizedUrl`,
    'tech.canonical_to_other_domain': otherDomainCondition,
    'tech.canonical_target_non_200': `source.${canonical} IS NOT NULL`
  });
  const rows = db.prepare(`
    SELECT
      source.url,
      source.canonical AS rawCanonical,
      source.${canonical} AS canonical,
      source.effectiveCanonical,
      source.renderStatus,
      source.settlingStatus,
      source.finalUrl,
      source.statusCode,
      target.statusCode AS canonicalTargetStatus,
      CASE
        WHEN source.${canonical} IS NULL OR source.${canonical} = '' THEN 'missing'
        WHEN source.${canonical} <> source.normalizedUrl AND target.statusCode IS NOT NULL AND target.statusCode <> 200 THEN 'target_non_200'
        WHEN source.${canonical} <> source.normalizedUrl THEN 'non_self_or_external'
        ELSE 'canonical_present'
      END AS issueType
    FROM pages source
    LEFT JOIN pages target ON target.runId = source.runId AND target.normalizedUrl = source.${canonical}
    WHERE source.runId = ? ${current ? 'AND COALESCE(source.metadataProvenanceComplete, 0) = 1' : ''} AND (${where})
    ORDER BY source.id ASC
  `).all(runId).filter((row) => {
    if (checkResult.checkId === 'tech.canonical_target_non_200') return row.canonicalTargetStatus !== null && row.canonicalTargetStatus !== 200;
    return true;
  }).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['url', 'URL'],
      ['canonical', 'Canonical'],
      ['finalUrl', 'Final URL'],
      ['statusCode', 'Status Code'],
      ['canonicalTargetStatus', 'Canonical Target Status'],
      ['issueType', 'Issue Type'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: current ? 'pages/effective document state' : 'pages (legacy)'
  };
}

function imageMarkupDetails({ db, runId, checkResult, recommendation }) {
  const where = pageCondition(checkResult.checkId, {
    'tech.images_without_alt': `
      altAttributePresent = 0
      AND ${NON_DECORATIVE_IMAGE_DETAIL_WHERE}
    `,
    'tech.empty_alt_texts': `
      altAttributePresent = 1 AND altValueTrimmed = ''
      AND ${NON_DECORATIVE_IMAGE_DETAIL_WHERE}
    `,
    'tech.images_without_width_height': `(width IS NULL OR width = '' OR height IS NULL OR height = '') AND ${NON_DECORATIVE_IMAGE_DETAIL_WHERE}`,
    'tech.images_without_lazy_loading': `(loading IS NULL OR LOWER(loading) <> 'lazy') AND ${NON_DECORATIVE_IMAGE_DETAIL_WHERE} AND ${NOT_SMALL_IMAGE_DETAIL_WHERE} AND ${NOT_LIKELY_HERO_IMAGE_DETAIL_WHERE}`
  });
  const reason = imageIssueReason(checkResult.checkId);
  const rows = db.prepare(`
    SELECT
      pageUrl,
      imageUrl,
      alt,
      altAttributePresent,
      altValue,
      altValueTrimmed,
      imageRole,
      width,
      height,
      loading,
      likelyDecorativeImage AS isDecorative,
      likelyBadgeImage AS isBadge,
      likelyTrackingPixel AS isTrackingPixel,
      likelyIcon AS isIcon,
      ${sqlString(reason)} AS reason
    FROM page_images
    WHERE runId = ? AND (${where})
    ORDER BY id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['pageUrl', 'Page URL'],
      ['imageUrl', 'Image URL'],
      ['alt', 'Alt'],
      ['altAttributePresent', 'Alt Attribute Present'],
      ['altValueTrimmed', 'Trimmed Alt Value'],
      ['imageRole', 'Image Role'],
      ['width', 'Width Attribute'],
      ['height', 'Height Attribute'],
      ['loading', 'Loading Attribute'],
      ['isDecorative', 'Is Decorative'],
      ['reason', 'Reason'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'page_images'
  };
}

function largeImageDetails({ db, runId, recommendation }) {
  const rows = db.prepare(`
    SELECT pageUrl, resourceUrl AS imageUrl, sizeBytes, contentType, statusCode
    FROM resources
    WHERE runId = ? AND resourceType = 'image' AND sizeBytes > ${thresholds.largeImageBytes}
    ORDER BY sizeBytes DESC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['pageUrl', 'Page URL'],
      ['imageUrl', 'Image URL'],
      ['sizeBytes', 'Size Bytes'],
      ['contentType', 'Content Type'],
      ['statusCode', 'Status Code'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'resources'
  };
}

function imageIssueReason(checkId) {
  if (checkId === 'tech.images_without_lazy_loading') return 'non-critical image missing loading=lazy';
  if (checkId === 'tech.images_without_width_height') return 'content image missing width or height attribute';
  if (checkId === 'tech.images_without_alt') return 'content image missing alt text';
  if (checkId === 'tech.empty_alt_texts') return 'content image has empty alt attribute';
  return 'image markup issue';
}

function sqlString(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

function statusPageDetails({ db, runId, checkResult, recommendation }) {
  const where = pageCondition(checkResult.checkId, {
    'tech.4xx_pages': 'statusCode >= 400 AND statusCode < 500',
    'tech.5xx_pages': 'statusCode >= 500',
    'tech.redirect_pages': '(initialStatusCode >= 300 AND initialStatusCode < 400) OR (initialStatusCode IS NULL AND finalUrl <> url)',
    'tech.sitemap_urls_non_200': 'COALESCE(statusCode, 0) <> 200'
  });
  const rows = db.prepare(`
    SELECT
      p.url,
      p.statusCode,
      p.initialStatusCode,
      p.redirectChainJson,
      p.finalUrl,
      (SELECT COUNT(*) FROM page_links l WHERE l.runId = p.runId AND l.normalizedTargetUrl = p.normalizedUrl) AS inlinksCount,
      (SELECT GROUP_CONCAT(sourceUrl, ' | ') FROM (
        SELECT sourceUrl
        FROM page_links l
        WHERE l.runId = p.runId AND l.normalizedTargetUrl = p.normalizedUrl
        ORDER BY l.id ASC
        LIMIT 5
      )) AS sampleInlinks
    FROM pages p
    WHERE p.runId = ? AND (${where})
    ORDER BY p.id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['url', 'URL'],
      ['statusCode', 'Status Code'],
      ['initialStatusCode', 'Initial Status Code'],
      ['redirectChainJson', 'Redirect Chain'],
      ['finalUrl', 'Final URL'],
      ['inlinksCount', 'Inlinks Count'],
      ['sampleInlinks', 'Sample Inlinks'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'pages/page_links'
  };
}

function internalLinkDetails({ db, runId, checkResult, recommendation }) {
  const targetWhere = checkResult.checkId === 'tech.internal_links_to_3xx'
    ? 'l.initialStatusCode >= 300 AND l.initialStatusCode < 400'
    : 'COALESCE(l.finalStatusCode, p.statusCode) >= 400';
  const rows = db.prepare(`
    SELECT
      l.sourceUrl,
      COALESCE(l.linkedUrl, l.targetUrl) AS targetUrl,
      l.anchorText,
      l.initialStatusCode,
      l.redirectChainJson,
      COALESCE(l.finalStatusCode, p.statusCode) AS finalStatusCode,
      COALESCE(l.finalUrl, p.finalUrl) AS finalTargetUrl
    FROM page_links l
    JOIN pages p ON p.runId = l.runId AND p.normalizedUrl = l.normalizedTargetUrl
    WHERE l.runId = ? AND l.linkType = 'internal' AND ${targetWhere}
    ORDER BY l.id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['sourceUrl', 'Source URL'],
      ['targetUrl', 'Target URL'],
      ['anchorText', 'Anchor Text'],
      ['initialStatusCode', 'Initial Status'],
      ['redirectChainJson', 'Redirect Chain'],
      ['finalStatusCode', 'Final Status'],
      ['finalTargetUrl', 'Final Target URL'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'page_links/pages'
  };
}

function h1Details({ db, runId, checkResult, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  const where = checkResult.checkId === 'tech.h1_missing'
    ? current ? 'COALESCE(metadataProvenanceComplete, 0) = 1 AND COALESCE(effectiveH1Count, 0) = 0' : "h1Count = 0 AND NOT (renderStatus = 'success' AND renderedH1Count > 0)"
    : current ? 'COALESCE(metadataProvenanceComplete, 0) = 1 AND COALESCE(effectiveH1Count, 0) > 1' : 'h1Count > 1';
  const rows = db.prepare(`
    SELECT url,
      ${current ? 'h1Count AS rawH1Count, h1Json AS rawH1Json, effectiveH1Count AS h1Count, effectiveH1Json AS h1Json' : 'h1Count, h1Json, h1Count AS rawH1Count, h1Json AS rawH1Json'},
      effectiveH1Count, effectiveH1Json, renderStatus, settlingStatus, pageType, indexable
    FROM pages
    WHERE runId = ? AND (${htmlWhere()}) AND statusCode >= 200 AND statusCode < 300 AND COALESCE(indexable, 1) = 1 AND (${where})
    ORDER BY id ASC
  `).all(runId).map((row) => ({
    ...row,
    h1Texts: safeJson(row.h1Json, []).join(' | '),
    effectiveH1Texts: safeJson(row.effectiveH1Json, []).join(' | '),
    recommendation
  }));
  return {
    columns: [
      ['url', 'URL'],
      ['h1Count', 'H1 Count'],
      ['h1Texts', 'H1 Texts'],
      ['pageType', 'Page Type'],
      ['indexable', 'Indexable'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: current ? 'pages/effective document state' : 'pages (legacy)'
  };
}

function duplicateMetaDetails({ db, runId, checkResult, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  const field = checkResult.checkId === 'tech.duplicate_titles'
    ? current ? 'effectiveTitle' : 'title'
    : current ? 'effectiveMetaDescription' : 'metaDescription';
  const groups = db.prepare(`
    SELECT LOWER(${field}) AS groupKey, ${field} AS duplicateValue, COUNT(*) AS groupSize
    FROM pages
    WHERE runId = ? AND ${indexableContentHtmlWhere()} ${current ? 'AND COALESCE(metadataProvenanceComplete, 0) = 1' : ''} AND ${field} IS NOT NULL AND ${field} <> ''
    GROUP BY LOWER(${field})
    HAVING COUNT(*) > 1
  `).all(runId);
  const rows = [];
  for (const group of groups) {
    const pages = db.prepare(`
      SELECT url, pageType, indexable
      FROM pages
      WHERE runId = ? AND ${indexableContentHtmlWhere()} ${current ? 'AND COALESCE(metadataProvenanceComplete, 0) = 1' : ''} AND LOWER(${field}) = ?
      ORDER BY id ASC
    `).all(runId, group.groupKey);
    for (const page of pages) {
      rows.push({
        duplicateValue: group.duplicateValue,
        url: page.url,
        pageType: page.pageType,
        indexable: page.indexable,
        groupSize: group.groupSize,
        recommendation
      });
    }
  }
  return {
    columns: [
      ['duplicateValue', 'Duplicate Value'],
      ['url', 'URL'],
      ['pageType', 'Page Type'],
      ['indexable', 'Indexable'],
      ['groupSize', 'Group Size'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'pages'
  };
}

function openGraphDetails({ db, runId, recommendation }) {
  const current = hasRenderProvenance(db, runId);
  const field = current ? 'effectiveOgJson' : 'ogJson';
  const rows = db.prepare(`
    SELECT url, pageType, ogJson, effectiveOgJson, renderStatus, settlingStatus, statusCode, indexable
    FROM pages
    WHERE runId = ?
      AND ${htmlWhere()}
      AND (
        ${field} IS NULL OR
        ${field} NOT LIKE '%"og:title":"%' OR
        ${field} NOT LIKE '%"og:description":"%' OR
        ${field} NOT LIKE '%"og:image":"%' OR
        ${field} NOT LIKE '%"og:url":"%'
      )
      ${current ? 'AND COALESCE(metadataProvenanceComplete, 0) = 1' : ''}
    ORDER BY id ASC
  `).all(runId).map((row) => {
    const og = safeJson(current ? row.effectiveOgJson : row.ogJson, {});
    const missingFields = ['og:title', 'og:description', 'og:image', 'og:url']
      .filter((field) => !og[field]);
    return {
      url: row.url,
      pageType: row.pageType,
      statusCode: row.statusCode,
      indexable: row.indexable,
      missingOpenGraphFields: missingFields.join(' | '),
      presentOpenGraphFields: Object.keys(og).filter(Boolean).sort().join(' | '),
      renderStatus: row.renderStatus,
      settlingStatus: row.settlingStatus,
      recommendation
    };
  });
  return {
    columns: [
      ['url', 'URL'],
      ['pageType', 'Page Type'],
      ['statusCode', 'Status Code'],
      ['indexable', 'Indexable'],
      ['missingOpenGraphFields', 'Missing Open Graph Fields'],
      ['presentOpenGraphFields', 'Present Open Graph Fields'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: current ? 'pages.effectiveOgJson/render provenance' : 'pages.ogJson (legacy)'
  };
}

function charsetDetails({ db, runId, recommendation }) {
  const rows = db.prepare(`
    SELECT
      url,
      contentType,
      hasHeaderUtf8,
      hasMetaCharsetUtf8,
      metaCharset AS detectedMetaCharset,
      pageType,
      statusCode
    FROM pages
    WHERE runId = ?
      AND ${htmlWhere()}
      AND COALESCE(hasHeaderUtf8, 0) = 0
      AND COALESCE(hasMetaCharsetUtf8, 0) = 0
    ORDER BY id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['url', 'URL'],
      ['contentType', 'Content-Type'],
      ['hasHeaderUtf8', 'Has Header UTF-8'],
      ['hasMetaCharsetUtf8', 'Has Meta Charset UTF-8'],
      ['detectedMetaCharset', 'Detected Meta Charset'],
      ['pageType', 'Page Type'],
      ['statusCode', 'Status Code'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'pages charset signals'
  };
}

function headerPresenceDetails({ db, runId, checkResult, recommendation }) {
  const headerKey = headerKeyForCheck(checkResult.checkId);
  const rows = db.prepare(`
    SELECT url, pageType, statusCode, responseHeadersJson
    FROM pages
    WHERE runId = ?
      AND ${htmlWhere()}
      AND (responseHeadersJson IS NULL OR responseHeadersJson NOT LIKE ?)
    ORDER BY id ASC
  `).all(runId, `%"${headerKey}"%`).map((row) => {
    const headers = safeJson(row.responseHeadersJson, {});
    return {
      url: row.url,
      pageType: row.pageType,
      statusCode: row.statusCode,
      missingHeader: headerKey,
      headerValue: headers[headerKey] || headers[headerKey.toLowerCase()] || '',
      storedHeadersCount: Object.keys(headers).length,
      recommendation
    };
  });
  return {
    columns: [
      ['url', 'URL'],
      ['pageType', 'Page Type'],
      ['statusCode', 'Status Code'],
      ['missingHeader', 'Missing Header'],
      ['headerValue', 'Header Value'],
      ['storedHeadersCount', 'Stored Headers Count'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'pages.responseHeadersJson'
  };
}

function ttfbDetails({ db, runId, recommendation }) {
  const rows = db.prepare(`
    SELECT url, ttfbMs, loadTimeMs, statusCode, pageType, rawHtmlSize
    FROM pages
    WHERE runId = ? AND ttfbMs IS NOT NULL AND ttfbMs > ${thresholds.highTtfbMs}
    ORDER BY ttfbMs DESC
  `).all(runId).map((row) => ({ ...row, timingContext: `load=${row.loadTimeMs ?? ''}ms html=${row.rawHtmlSize ?? ''} bytes`, recommendation }));
  return {
    columns: [
      ['url', 'URL'],
      ['ttfbMs', 'TTFB ms'],
      ['statusCode', 'Status Code'],
      ['pageType', 'Page Type'],
      ['timingContext', 'Resource/Timing Context'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'pages'
  };
}

function templatePerformanceDetails({ db, runId, recommendation }) {
  const rows = db.prepare(`
    SELECT
      s.templateClusterKey,
      s.url AS sampleUrl,
      l.performanceScore,
      l.seoScore,
      l.largestContentfulPaintMs AS lcpMs,
      l.totalBlockingTimeMs AS tbtMs,
      l.cumulativeLayoutShift AS cls,
      COALESCE(l.errorMessage, s.errorMessage) AS error
    FROM template_sample_results s
    LEFT JOIN lighthouse_results l ON l.runId = s.runId AND l.url = s.url
    LEFT JOIN playwright_results p ON p.runId = s.runId AND p.url = s.url
    WHERE s.runId = ?
    ORDER BY s.templateClusterKey ASC, s.id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return {
    columns: [
      ['templateClusterKey', 'Template Cluster'],
      ['sampleUrl', 'Sample URL'],
      ['performanceScore', 'Performance Score'],
      ['seoScore', 'SEO Score'],
      ['lcpMs', 'LCP'],
      ['tbtMs', 'TBT'],
      ['cls', 'CLS'],
      ['error', 'Error'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'template_sample_results/lighthouse_results/playwright_results',
    emptyMessage: 'No template sample details are available for this run.'
  };
}

function structuredDataDetails({ db, runId, checkResult, recommendation }) {
  if (checkResult.checkId === 'tech.json_ld_parse_errors') {
    const rows = db.prepare(`
      SELECT pageUrl AS url, schemaType, parseStatus, parseError
      FROM schemas
      WHERE runId = ? AND parseStatus <> 'ok'
      ORDER BY id ASC
    `).all(runId).map((row) => ({ ...row, recommendation }));
    return structuredRows(rows, 'schemas');
  }
  const where = structuredDataWhere(checkResult.checkId);
  const rows = db.prepare(`
    SELECT
      p.url,
      p.pageType,
      p.schemaTypesJson,
      p.hasFaqPattern,
      p.hasVideoEmbed,
      s.schemaType,
      s.parseStatus,
      s.parseError
    FROM pages p
    LEFT JOIN schemas s ON s.runId = p.runId AND s.pageUrl = p.finalUrl
    WHERE p.runId = ? AND (${where})
    ORDER BY p.id ASC, s.id ASC
  `).all(runId).map((row) => ({
    url: row.url,
    pageType: row.pageType,
    schemaTypes: safeJson(row.schemaTypesJson, []).join('|'),
    missingOrInvalidType: inferredMissingSchemaType(checkResult.checkId),
    parseStatus: row.parseStatus || '',
    parseError: row.parseError || '',
    detectedSignal: signalLabel(row),
    recommendation
  }));
  return structuredRows(rows, 'pages/schemas');
}

function structuredDataWhere(checkId) {
  const html = htmlWhere('p');
  const eligibleBreadcrumb = `
    ${html}
    AND COALESCE(p.pageType, 'other') NOT IN ('homepage', 'blog_index', 'article_index', 'product_index', 'category_index', 'legal', 'contact')
    AND (
      COALESCE(p.pageType, 'other') IN ('article', 'product', 'category', 'location')
      OR LOWER(p.url) LIKE '%/fakta/%'
      OR LOWER(p.url) LIKE '%/fakten/%'
      OR LOWER(p.url) LIKE '%/facts/%'
      OR p.depth > 1
    )
  `;
  if (/article_coverage_on_article_like_pages|article_blog_pages_article_schema/.test(checkId)) {
    return `${html} AND p.pageType = 'article' AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%Article%'`;
  }
  if (/product_coverage_on_product_like_pages/.test(checkId)) {
    return `${html} AND p.pageType = 'product' AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%Product%'`;
  }
  if (/localbusiness_present_missing/.test(checkId)) {
    return `${html} AND p.pageType = 'location' AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%LocalBusiness%'`;
  }
  if (/breadcrumb_missing_low_coverage/.test(checkId)) {
    return `${eligibleBreadcrumb} AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%BreadcrumbList%'`;
  }
  if (/faqpage_missing_low_coverage|faq_html_present_schema_missing/.test(checkId)) {
    return `${html} AND p.hasFaqPattern = 1 AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%FAQPage%'`;
  }
  if (/videoobject_schema_present_missing/.test(checkId)) {
    return `${html} AND p.hasVideoEmbed = 1 AND COALESCE(p.schemaTypesJson, '') NOT LIKE '%VideoObject%'`;
  }
  return '1 = 1';
}

function structuredRows(rows, dataSource) {
  return {
    columns: [
      ['url', 'URL'],
      ['pageType', 'Page Type'],
      ['schemaTypes', 'Schema Types'],
      ['missingOrInvalidType', 'Missing/Invalid Type'],
      ['parseStatus', 'JSON-LD Parse Status'],
      ['parseError', 'Parse Error'],
      ['detectedSignal', 'Detected Signal'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource
  };
}

function aiBotPolicyDetails({ db, runId, checkResult, recommendation }) {
  const robots = db.prepare("SELECT * FROM domain_assets WHERE runId = ? AND type = 'robots' ORDER BY id DESC LIMIT 1").get(runId);
  const summary = checkResult.evidence?.summary || (checkResult.evidence?.botName ? [checkResult.evidence] : []);
  const rows = Array.isArray(summary) && summary.length
    ? summary.map((item) => ({
        botName: item.botName || item.userAgent || item.bot || checkResult.evidence?.botName || '',
        mentioned: item.mentioned ?? checkResult.evidence?.mentioned ?? '',
        robotsStatus: robots?.statusCode ?? checkResult.evidence?.robotsStatusCode ?? '',
        suggestedRobotsRule: `User-agent: ${item.botName || item.userAgent || item.bot || checkResult.evidence?.botName || 'BOT'}\\nAllow: /`,
        recommendation
      }))
    : [{
        botName: checkResult.evidence?.botName || '',
        mentioned: checkResult.evidence?.mentioned ?? '',
        robotsStatus: robots?.statusCode ?? checkResult.evidence?.robotsStatusCode ?? '',
        suggestedRobotsRule: 'Add explicit rules only if policy clarity is required.',
        recommendation
      }];
  return {
    columns: [
      ['botName', 'Bot Name'],
      ['mentioned', 'Mentioned'],
      ['robotsStatus', 'robots.txt Status'],
      ['suggestedRobotsRule', 'Suggested robots.txt Rule'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'domain_assets/evidence'
  };
}

function llmsDetails({ db, runId, recommendation }) {
  const rows = db.prepare(`
    SELECT type, url AS fileUrl, statusCode, LENGTH(COALESCE(content, '')) AS bytes
    FROM domain_assets
    WHERE runId = ? AND (type IN ('llms', 'llms_full') OR LOWER(url) LIKE '%llms%')
    ORDER BY type ASC, url ASC
  `).all(runId).map((row) => ({
    ...row,
    referenced: '',
    recommendation
  }));
  return {
    columns: [
      ['fileUrl', 'File URL'],
      ['statusCode', 'Status Code'],
      ['bytes', 'Bytes'],
      ['referenced', 'Referenced'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'domain_assets',
    emptyMessage: 'No llms.txt or llms-full.txt asset rows were stored.'
  };
}

function genericDetails({ checkResult, recommendation }) {
  const rows = [];
  for (const url of checkResult.sampleUrls || []) {
    rows.push({ sampleUrl: url, evidenceKey: 'sampleUrls', evidenceValue: url, recommendation });
  }
  const evidence = checkResult.evidence && typeof checkResult.evidence === 'object' ? checkResult.evidence : {};
  for (const [key, value] of Object.entries(evidence)) {
    rows.push({
      sampleUrl: '',
      evidenceKey: key,
      evidenceValue: formatValue(value),
      recommendation
    });
  }
  return {
    columns: [
      ['sampleUrl', 'Sample URL'],
      ['evidenceKey', 'Evidence Key'],
      ['evidenceValue', 'Evidence Value'],
      ['recommendation', 'Recommendation']
    ],
    rows,
    dataSource: 'check_results evidence',
    emptyMessage: 'This check has no specific detail handler; stored evidence is shown instead.'
  };
}

function pageRows({ db, runId, where, select, columns, recommendation, dataSource }) {
  const rows = db.prepare(`
    SELECT ${select}
    FROM pages
    WHERE runId = ? AND (${where})
    ORDER BY id ASC
  `).all(runId).map((row) => ({ ...row, recommendation }));
  return { columns, rows, dataSource };
}

function pageCondition(checkId, conditions) {
  return conditions[checkId] || '1 = 1';
}

function htmlWhere(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}contentType LIKE '%text/html%' OR ${prefix}contentType LIKE '%application/xhtml%')`;
}

function indexableContentHtmlWhere(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `${htmlWhere(alias)} AND ${prefix}statusCode >= 200 AND ${prefix}statusCode < 300 AND COALESCE(${prefix}indexable, 1) = 1 AND COALESCE(${prefix}pageType, 'other') <> 'legal'`;
}

function withReviewColumns(columns) {
  const existing = new Set(columns.map((column) => column.key));
  const output = [...columns];
  for (const column of [
    { key: 'displayReviewStatus', label: 'Review Status' },
    { key: 'displayActionStatus', label: 'Action Status' }
  ]) {
    if (!existing.has(column.key)) output.push(column);
  }
  return output;
}

function normalizeColumns(columns) {
  return columns.map((column) => Array.isArray(column)
    ? { key: column[0], label: column[1] || column[0] }
    : { key: column.key, label: column.label || column.key });
}

function columnsFromRows(rows) {
  const keys = rows[0] ? Object.keys(rows[0]) : ['info', 'value', 'recommendation'];
  return keys.map((key) => [key, titleize(key)]);
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const output = {};
    for (const [key, value] of Object.entries(row || {})) output[key] = normalizeValue(value);
    return output;
  });
}

function addReviewFields(row, checkResult) {
  return {
    ...row,
    displayReviewStatus: checkResult.displayReviewStatus || checkResult.reviewStatus || 'unreviewed',
    displayActionStatus: checkResult.displayActionStatus || checkResult.actionStatus || 'open'
  };
}

function buildNarrative(checkResult, detail = {}) {
  return {
    whatChecked: `Prüfpunkt: ${checkResult.checkName}.`,
    howChecked: detail.howChecked || `Ausgewertet wurden gespeicherte Crawl-Daten, Check-Evidence und betroffene Samples für ${checkResult.checkId}.`,
    found: checkResult.effectiveFinding || checkResult.finding || 'No finding text stored.',
    relevance: relevanceFor(checkResult),
    recommendation: checkResult.effectiveRecommendation || checkResult.recommendation || ''
  };
}

function relevanceFor(checkResult) {
  if (checkResult.reportSection === 'geo_opportunities') return 'Relevant als Opportunity für bessere maschinenlesbare Signale und AI-/GEO-Auswertung.';
  if (checkResult.reportSection === 'security_best_practices') return 'Relevant als Best-Practice-Signal; bitte Kontext und Risiko manuell bewerten.';
  if (checkResult.reportSection === 'media_findings') return 'Relevant für Bildverständnis, Barrierefreiheit und stabile Seitendarstellung.';
  if (checkResult.reportSection === 'passed_checks') return 'Dieser Prüfpunkt ist bestanden und erzeugt keine offene Review-Arbeit.';
  if (checkResult.reportSection === 'not_applicable') return 'Dieser Prüfpunkt war für die gespeicherte Datenbasis nicht anwendbar.';
  return 'Relevant, weil der Prüfpunkt echte technische oder inhaltliche Audit-Arbeit auslösen kann.';
}

function inferredMissingSchemaType(checkId) {
  if (/article/i.test(checkId)) return 'Article';
  if (/product/i.test(checkId)) return 'Product';
  if (/breadcrumb/i.test(checkId)) return 'BreadcrumbList';
  if (/faq/i.test(checkId)) return 'FAQPage';
  if (/speakable/i.test(checkId)) return 'SpeakableSpecification';
  if (/organization/i.test(checkId)) return 'Organization';
  if (/website/i.test(checkId)) return 'WebSite';
  if (/localbusiness/i.test(checkId)) return 'LocalBusiness';
  if (/videoobject/i.test(checkId)) return 'VideoObject';
  return '';
}

function signalLabel(row) {
  const signals = [];
  if (row.hasFaqPattern) signals.push('FAQ pattern');
  if (row.hasVideoEmbed) signals.push('Video embed');
  return signals.join(', ');
}

function headerKeyForCheck(checkId) {
  const map = {
    'tech.compression_header': 'content-encoding',
    'tech.cache_control_header': 'cache-control',
    'tech.hsts_header': 'strict-transport-security',
    'tech.content_security_policy': 'content-security-policy',
    'tech.x_frame_options': 'x-frame-options',
    'tech.x_content_type_options': 'x-content-type-options',
    'tech.referrer_policy': 'referrer-policy',
    'tech.permissions_policy': 'permissions-policy'
  };
  return map[checkId] || String(checkId || '').replace(/^tech\./, '').replaceAll('_', '-');
}

function escapeSqlLike(value) {
  return String(value || '').replaceAll("'", "''");
}

function hasRenderProvenance(db, runId) {
  return Boolean(db.prepare('SELECT 1 FROM pages WHERE runId = ? AND rawDocumentStateJson IS NOT NULL LIMIT 1').get(runId));
}

function pageRenderProvenanceForRows(db, runId, rows) {
  const urls = [...new Set((rows || []).flatMap((row) => [row.url, row.pageUrl, row.sourceUrl, row.sampleUrl]).filter(Boolean))].slice(0, 100);
  if (!urls.length) return [];
  const placeholders = urls.map(() => '?').join(',');
  return db.prepare(`
    SELECT p.url, p.renderStatus, p.settlingStatus, p.metadataProvenanceComplete,
      p.title AS rawTitle, p.metaDescription AS rawMetaDescription, p.canonical AS rawCanonical, p.htmlLang AS rawHtmlLang,
      p.initialRenderedStateJson, p.settledRenderedStateJson,
      p.effectiveTitle, p.effectiveMetaDescription, p.effectiveCanonical, p.effectiveHtmlLang,
      p.wordCountRaw, p.effectiveWordCount, p.h1Count AS rawH1Count, p.effectiveH1Count,
      p.renderProvenanceVersion, p.settlingPolicyVersion,
      urm.rawContentClass, urm.renderStrategy, urm.renderNeed, urm.renderDecision, urm.renderConfidence,
      urm.renderDecisionReasonJson, urm.renderSignalsJson, urm.budgetStatusJson,
      urm.resultingBrowserRun, urm.browserNavigationDurationMs, urm.settlingDurationMs AS measuredSettlingDurationMs,
      urm.snapshotCount, urm.totalUrlDurationMs, urm.renderProvenanceBytes, urm.networkRequestCount,
      urm.failedRequestCount, urm.measurementError, urm.metricsVersion
    FROM pages p
    LEFT JOIN url_runtime_metrics urm ON urm.runId=p.runId AND urm.url=p.url
    WHERE p.runId = ? AND p.url IN (${placeholders})
    ORDER BY p.id ASC
  `).all(runId, ...urls).map((row) => {
    const initial = safeJson(row.initialRenderedStateJson, {});
    const settled = safeJson(row.settledRenderedStateJson, {});
    return {
      url: row.url,
      renderStatus: row.renderStatus,
      settlingStatus: row.settlingStatus,
      complete: Boolean(row.metadataProvenanceComplete),
      rawTitle: row.rawTitle,
      initialTitle: initial.title ?? null,
      settledTitle: settled.title ?? null,
      effectiveTitle: row.effectiveTitle,
      rawMetaDescription: row.rawMetaDescription,
      settledMetaDescription: settled.metaDescription ?? null,
      effectiveMetaDescription: row.effectiveMetaDescription,
      rawCanonical: row.rawCanonical,
      settledCanonical: settled.canonical ?? null,
      effectiveCanonical: row.effectiveCanonical,
      rawHtmlLang: row.rawHtmlLang,
      settledHtmlLang: settled.htmlLang ?? null,
      effectiveHtmlLang: row.effectiveHtmlLang,
      rawWordCount: row.wordCountRaw,
      initialWordCount: initial.visibleText?.wordCount ?? null,
      settledWordCount: settled.visibleText?.wordCount ?? null,
      effectiveWordCount: row.effectiveWordCount,
      rawH1Count: row.rawH1Count,
      settledH1Count: settled.h1?.length ?? null,
      effectiveH1Count: row.effectiveH1Count,
      renderProvenanceVersion: row.renderProvenanceVersion,
      settlingPolicyVersion: row.settlingPolicyVersion,
      renderStrategy: row.renderStrategy,
      rawContentClass: row.rawContentClass,
      renderNeed: row.renderNeed,
      renderDecision: row.renderDecision,
      renderConfidence: row.renderConfidence,
      renderDecisionReason: safeJson(row.renderDecisionReasonJson, {}),
      renderSignals: safeJson(row.renderSignalsJson, []),
      budgetStatus: safeJson(row.budgetStatusJson, {}),
      resultingBrowserRun: Boolean(row.resultingBrowserRun),
      browserNavigationDurationMs: row.browserNavigationDurationMs,
      settlingDurationMs: row.measuredSettlingDurationMs,
      snapshotCount: row.snapshotCount,
      totalUrlDurationMs: row.totalUrlDurationMs,
      renderProvenanceBytes: row.renderProvenanceBytes,
      networkRequestCount: row.networkRequestCount,
      failedRequestCount: row.failedRequestCount,
      measurementError: row.measurementError,
      metricsVersion: row.metricsVersion
    };
  });
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(' | ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function titleize(key) {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (char) => char.toUpperCase());
}
