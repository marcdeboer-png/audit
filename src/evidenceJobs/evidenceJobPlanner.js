import { EVIDENCE_JOB_TYPES, estimateEvidenceJobStorage, getEvidenceJobType } from './evidenceJobTypes.js';

const GAP_TO_JOB_TYPES = Object.freeze({
  needs_title_facts: ['title_facts'],
  needs_meta_description_facts: ['meta_description_facts'],
  needs_h1_facts: ['h1_facts'],
  needs_canonical_facts: ['canonical_robots_facts'],
  needs_xrobots_facts: ['canonical_robots_facts'],
  needs_hreflang_facts: ['hreflang_facts'],
  needs_resource_facts: ['resource_facts'],
  needs_link_aggregates: ['link_aggregate_facts'],
  needs_schema_summary: ['schema_summary_facts'],
  needs_raw_html_signal: ['raw_html_signal_facts'],
  needs_rendered_html_sample: ['rendered_sample_facts'],
  needs_crux_psi: ['resource_facts'],
  needs_human_quality_review: ['human_quality_review'],
  needs_legal_privacy_review: ['legal_privacy_review'],
  needs_entity_trust_review: ['human_quality_review'],
  needs_manual_strategy_context: ['human_quality_review'],
  needs_more_urls: ['title_facts', 'meta_description_facts', 'h1_facts', 'canonical_robots_facts'],
  needs_specific_url_set: ['title_facts', 'meta_description_facts', 'h1_facts', 'canonical_robots_facts'],
  needs_larger_crawl: ['title_facts', 'meta_description_facts', 'h1_facts', 'canonical_robots_facts'],
  needs_external_import: []
});

export function planEvidenceJobsForPoint(point = {}, options = {}) {
  const gapTypes = point.gapTypes || [];
  const specificGapTypes = gapTypes.filter((gapType) => !['needs_more_urls', 'needs_specific_url_set', 'needs_larger_crawl'].includes(gapType));
  const jobTypes = unique((specificGapTypes.length ? specificGapTypes : gapTypes)
    .flatMap((gapType) => GAP_TO_JOB_TYPES[gapType] || []));
  const maxUrls = recommendedMaxUrls(point, options);
  const urlSet = recommendedUrlSet(point, options);
  const plans = jobTypes
    .map((jobType) => buildJobPlan(jobType, { point, maxUrls, urlSet, options }))
    .filter(Boolean)
    .sort((a, b) => jobSortScore(a) - jobSortScore(b));
  return plans.slice(0, 4);
}

export function buildEvidenceJobPlan(points = [], options = {}) {
  const jobsByType = new Map();
  for (const point of points) {
    for (const recommendation of point.recommendedJobs || planEvidenceJobsForPoint(point, options)) {
      const entry = jobsByType.get(recommendation.jobType) || {
        ...recommendation,
        pointCount: 0,
        manualItemIds: [],
        closesGapTypes: new Set(recommendation.closesGapTypes || []),
        relatedCheckIds: new Set(recommendation.relatedCheckIds || [])
      };
      entry.pointCount += 1;
      entry.manualItemIds.push(point.manualItemId);
      for (const gap of point.gapTypes || []) entry.closesGapTypes.add(gap);
      for (const checkId of point.matchedCheckIds || []) entry.relatedCheckIds.add(checkId);
      jobsByType.set(recommendation.jobType, entry);
    }
  }
  const jobs = [...jobsByType.values()].map((job) => ({
    ...job,
    closesGapTypes: [...job.closesGapTypes],
    relatedCheckIds: [...job.relatedCheckIds],
    manualItemIds: unique(job.manualItemIds)
  })).sort((a, b) => b.pointCount - a.pointCount || jobSortScore(a) - jobSortScore(b));
  return {
    generatedAt: new Date().toISOString(),
    unresolvedPointCount: points.length,
    recommendedJobCount: jobs.length,
    jobs,
    storageProjectionSummary: storageProjectionSummary(jobs),
    runnerStatus: {
      implemented: true,
      executableJobTypes: ['title_facts', 'meta_description_facts', 'h1_facts', 'canonical_robots_facts', 'schema_summary_facts', 'hreflang_facts'],
      message: 'Low-risk targeted fact jobs are executable with capped URL sets and no raw/rendered HTML storage.'
    }
  };
}

function buildJobPlan(jobType, context) {
  const definition = getEvidenceJobType(jobType);
  if (!definition) return null;
  const maxUrls = Math.min(context.maxUrls, definition.maxUrls || context.maxUrls);
  const estimate = estimateEvidenceJobStorage(definition, maxUrls);
  const closesGapTypes = (context.point.gapTypes || []).filter((gapType) => (definition.closesGapTypes || []).includes(gapType));
  return {
    jobType,
    label: definition.label,
    description: definition.description,
    requiredUrlSet: context.urlSet,
    supportedUrlSets: definition.requiredUrlSet,
    maxUrls,
    storageProfile: definition.storageProfile,
    factsToExtract: definition.factsToExtract,
    storesRawHtml: definition.storesRawHtml,
    storesRenderedHtml: definition.storesRenderedHtml,
    estimatedBytesPerUrl: definition.estimatedBytesPerUrl,
    estimatedRuntime: definition.estimatedRuntime,
    storageEstimate: estimate,
    closesGapTypes: closesGapTypes.length ? closesGapTypes : definition.closesGapTypes,
    relatedCheckIds: definition.relatedCheckIds,
    expectedImpact: expectedImpact(context.point),
    effort: estimate.riskLevel === 'low' ? 'S' : estimate.riskLevel === 'medium' ? 'M' : 'L',
    safetyNotes: definition.safetyNotes?.length ? definition.safetyNotes : estimate.safetyNotes
  };
}

function recommendedMaxUrls(point = {}, options = {}) {
  const processed = Number(options.run?.processedUrls || options.processedUrls || 0);
  const manualAffected = Number(point.manualAffectedCount || point.affectedCount || 0);
  if ((point.gapTypes || []).includes('needs_rendered_html_sample')) return Math.min(200, Math.max(25, point.sampleUrls?.length || 25));
  if ((point.gapTypes || []).some((gap) => /human|legal|entity|strategy/.test(gap))) return Math.min(50, Math.max(10, point.sampleUrls?.length || 10));
  if (manualAffected >= 1000) return Math.min(50000, manualAffected);
  if (processed && processed < 1000 && (point.gapTypes || []).includes('needs_larger_crawl')) return 10000;
  return Math.max(500, processed || 500);
}

function recommendedUrlSet(point = {}, options = {}) {
  const gapTypes = point.gapTypes || [];
  if (gapTypes.includes('needs_specific_url_set')) return 'uploaded_url_list';
  if (gapTypes.includes('needs_larger_crawl') || gapTypes.includes('needs_more_urls')) return options.hasSitemapUrls ? 'sitemap_urls' : 'known_url_facts';
  if ((point.sampleUrls || []).length) return 'affected_sample_urls';
  return 'current_run_urls';
}

function expectedImpact(point = {}) {
  if (point.priority === 'High') return 'high';
  if (point.currentCoverageStatus === 'covered_in_sample') return 'high';
  if (point.priority === 'Medium') return 'medium';
  return 'low';
}

function jobSortScore(job = {}) {
  const risk = { low: 0, medium: 1, high: 2 };
  const impact = { high: 0, medium: 1, low: 2 };
  return (impact[job.expectedImpact] ?? 9) * 10 + (risk[job.storageEstimate?.riskLevel] ?? 9);
}

function storageProjectionSummary(jobs = []) {
  const byRisk = jobs.reduce((acc, job) => {
    const risk = job.storageEstimate?.riskLevel || 'unknown';
    acc[risk] = (acc[risk] || 0) + 1;
    return acc;
  }, {});
  return {
    byRisk,
    lowestBytesPerUrl: jobs.length ? Math.min(...jobs.map((job) => job.estimatedBytesPerUrl || 0)) : 0,
    highestBytesPerUrl: jobs.length ? Math.max(...jobs.map((job) => job.estimatedBytesPerUrl || 0)) : 0,
    projections: Object.fromEntries(Object.entries(EVIDENCE_JOB_TYPES).map(([jobType, definition]) => [
      jobType,
      estimateEvidenceJobStorage(definition, definition.maxUrls)
    ]))
  };
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}
