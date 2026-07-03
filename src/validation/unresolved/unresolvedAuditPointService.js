import { buildEvidenceJobPlan, planEvidenceJobsForPoint } from '../../evidenceJobs/evidenceJobPlanner.js';
import { classifyEvidenceGaps, primaryGapType } from './evidenceGapClassifier.js';

const UNRESOLVED_STATUSES = new Set([
  'covered_in_sample',
  'partially_covered',
  'needs_external_data',
  'needs_larger_crawl',
  'needs_human_review',
  'needs_llm_review',
  'false_negative_candidate',
  'false_positive_candidate'
]);

export function buildUnresolvedAuditQueue(reportOrContext = {}) {
  const report = reportOrContext.coverageMatrix ? reportOrContext : { ...reportOrContext, coverageMatrix: reportOrContext.rows || [] };
  const run = report.run || {};
  const points = (report.coverageMatrix || [])
    .filter((row) => shouldInclude(row))
    .map((row) => unresolvedPointFromCoverage(row, { run, validationSummary: report.validationSummary || {} }))
    .map((point) => {
      const recommendedJobs = planEvidenceJobsForPoint(point, { run });
      return {
        ...point,
        recommendedJobs,
        recommendedJobTypes: recommendedJobs.map((job) => job.jobType),
        nextBestAction: nextBestAction(point, recommendedJobs)
      };
    })
    .sort(pointSort);
  const summary = buildQueueSummary(points, report.validationSummary || {});
  const evidenceJobPlan = buildEvidenceJobPlan(points, { run });
  const evidencePacks = buildEvidencePacks(points);
  return {
    generatedAt: new Date().toISOString(),
    runId: report.runId || run.id || null,
    summary,
    points,
    evidenceJobPlan,
    evidencePacks
  };
}

export function buildEvidencePacks(points = []) {
  return {
    generatedAt: new Date().toISOString(),
    packCount: points.length,
    packs: points.map((point) => ({
      evidencePackId: `evidence-pack-${point.id}`,
      manualItem: {
        id: point.manualItemId,
        title: point.manualTitle,
        category: point.manualCategory,
        priority: point.priority,
        affectedCount: point.manualAffectedCount || null
      },
      currentCoverage: {
        status: point.currentCoverageStatus,
        weightedContribution: point.weightedContribution,
        partialReason: point.partialReason,
        matchReasons: point.matchReasons,
        missingReasons: point.missingReasons
      },
      toolFindings: point.currentToolFindings,
      evidence: point.currentEvidence,
      requiredEvidence: point.requiredEvidence,
      gapTypes: point.gapTypes,
      recommendedJobs: point.recommendedJobs,
      recommendedReviewType: point.recommendedReviewType,
      currentLimitation: point.currentLimitation,
      suggestedNextStep: point.nextBestAction,
      riskIfIgnored: point.riskIfIgnored
    }))
  };
}

export function renderUnresolvedAuditQueueMarkdown(queue = {}) {
  const lines = [
    '# Unresolved Audit Queue',
    '',
    `- Run: ${queue.runId || 'n/a'}`,
    `- Unresolved points: ${queue.summary?.unresolvedCount || 0}`,
    `- Covered in sample: ${queue.summary?.coveredInSample || 0}`,
    `- Partial: ${queue.summary?.partiallyCovered || 0}`,
    `- Needs targeted crawl: ${queue.summary?.needsTargetedCrawl || 0}`,
    `- Needs external data: ${queue.summary?.needsExternalData || 0}`,
    `- Needs human review: ${queue.summary?.needsHumanReview || 0}`,
    '',
    '## By Gap Type',
    '',
    ...Object.entries(queue.summary?.byGapType || {}).map(([gapType, count]) => `- ${gapType}: ${count}`),
    '',
    '## Points',
    '',
    '| Audit Point | Status | Priority | Primary Gap | Recommended Jobs | Next Best Action |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  for (const point of queue.points || []) {
    lines.push(`| ${md(point.manualTitle)} | ${md(point.currentCoverageStatus)} | ${md(point.priority)} | ${md(point.primaryGapType)} | ${md(point.recommendedJobTypes.join(', '))} | ${md(point.nextBestAction)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderEvidencePacksMarkdown(evidencePacks = {}) {
  const lines = [
    '# Evidence Packs',
    '',
    `- Packs: ${evidencePacks.packCount || 0}`,
    ''
  ];
  for (const pack of evidencePacks.packs || []) {
    lines.push(
      `## ${pack.manualItem.title}`,
      '',
      `- Manual item: ${pack.manualItem.id}`,
      `- Category: ${pack.manualItem.category}`,
      `- Priority: ${pack.manualItem.priority}`,
      `- Coverage: ${pack.currentCoverage.status}`,
      `- Partial reason: ${pack.currentCoverage.partialReason || 'n/a'}`,
      `- Gap types: ${(pack.gapTypes || []).join(', ') || 'none'}`,
      `- Recommended jobs: ${(pack.recommendedJobs || []).map((job) => job.jobType).join(', ') || 'none'}`,
      `- Review type: ${pack.recommendedReviewType || 'none'}`,
      `- Suggested next step: ${pack.suggestedNextStep}`,
      `- Risk if ignored: ${pack.riskIfIgnored}`,
      '',
      '### Current Evidence',
      '',
      `- Affected in sample: ${pack.evidence?.affectedInSample || 0}`,
      `- Sample URLs: ${(pack.evidence?.sampleUrls || []).slice(0, 5).join(', ') || 'none'}`,
      `- Match reasons: ${(pack.currentCoverage.matchReasons || []).join(', ') || 'none'}`,
      `- Missing reasons: ${(pack.currentCoverage.missingReasons || []).join(', ') || 'none'}`,
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderEvidenceJobPlanMarkdown(plan = {}) {
  const lines = [
    '# Evidence Job Plan',
    '',
    `- Unresolved points: ${plan.unresolvedPointCount || 0}`,
    `- Recommended job types: ${plan.recommendedJobCount || 0}`,
    `- Runner implemented: ${plan.runnerStatus?.implemented ? 'yes' : 'no'}`,
    '',
    '## Recommended Jobs',
    '',
    '| Job | Points | URL Set | Max URLs | Bytes/URL | 10k | 50k | 400k | Risk |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const job of plan.jobs || []) {
    lines.push(`| ${md(job.jobType)} | ${job.pointCount || 0} | ${md(job.requiredUrlSet)} | ${job.maxUrls || 0} | ${job.estimatedBytesPerUrl || 0} | ${md(job.storageEstimate?.estimated10kHuman)} | ${md(job.storageEstimate?.estimated50kHuman)} | ${md(job.storageEstimate?.estimated400kHuman)} | ${md(job.storageEstimate?.riskLevel)} |`);
  }
  lines.push('', '## Runner Status', '', plan.runnerStatus?.message || '');
  return `${lines.join('\n')}\n`;
}

function shouldInclude(row = {}) {
  return UNRESOLVED_STATUSES.has(row.coverageStatus)
    || Boolean(row.partialReason)
    || (row.missingReasons || []).length > 0;
}

function unresolvedPointFromCoverage(row = {}, context = {}) {
  const manual = row.manualItem || {};
  const gapTypes = classifyEvidenceGaps(row);
  const primary = primaryGapType(gapTypes);
  const sampleUrls = sampleUrlsFor(row);
  const currentToolFindings = compactToolFindings(row);
  return {
    id: `unresolved-${row.manualItemId}`,
    manualItemId: row.manualItemId,
    manualTitle: manual.title || row.manualItemId,
    manualCategory: manual.category || row.mapping?.category || 'uncategorized',
    manualAffectedCount: manual.affectedCount || null,
    priority: manual.priority || 'unknown',
    currentCoverageStatus: row.coverageStatus,
    weightedContribution: weightedContribution(row.coverageStatus),
    partialReason: row.partialReason || null,
    matchReasons: row.matchReasons || [],
    missingReasons: row.missingReasons || [],
    gapTypes,
    primaryGapType: primary,
    currentEvidence: {
      matchScore: row.matchScore || 0,
      evidenceMatchScore: row.evidenceMatchScore || row.matchScore || 0,
      affectedInSample: row.affectedInSample || row.toolFinding?.affectedCount || 0,
      sampleBased: Boolean(row.sampleBased || row.coverageStatus === 'covered_in_sample'),
      sampleUrls,
      dataBasis: context.validationSummary?.dataBasisLabel || context.run?.sourceType || 'unknown',
      compositeCoverage: row.compositeCoverage || null
    },
    currentToolFindings,
    matchedCheckIds: row.matchedCheckIds?.length ? row.matchedCheckIds : [row.matchedCheckId].filter(Boolean),
    requiredEvidence: requiredEvidenceFor(gapTypes),
    recommendedReviewType: recommendedReviewType(gapTypes),
    canBeClosedByTargetedCrawl: gapTypes.some((gap) => /facts|aggregates|more_urls|specific_url_set|larger_crawl/.test(gap)),
    canBeClosedByHumanReview: gapTypes.some((gap) => /human|legal|entity|strategy/.test(gap)),
    canBeClosedByExternalImport: gapTypes.some((gap) => /external|crux|psi|hreflang/.test(gap)),
    riskIfIgnored: riskIfIgnored(row, gapTypes),
    currentLimitation: currentLimitation(row, gapTypes)
  };
}

function buildQueueSummary(points = [], validationSummary = {}) {
  return {
    manualItemCount: validationSummary.manualItemCount || 0,
    coveragePercent: validationSummary.coveragePercent || 0,
    unresolvedCount: points.length,
    coveredInSample: points.filter((point) => point.currentCoverageStatus === 'covered_in_sample').length,
    partiallyCovered: points.filter((point) => point.currentCoverageStatus === 'partially_covered').length,
    needsTargetedCrawl: points.filter((point) => point.canBeClosedByTargetedCrawl).length,
    needsExternalData: points.filter((point) => point.canBeClosedByExternalImport).length,
    needsHumanReview: points.filter((point) => point.canBeClosedByHumanReview).length,
    highPriority: points.filter((point) => point.priority === 'High').length,
    byGapType: countBy(points.flatMap((point) => point.gapTypes)),
    byNextBestAction: countBy(points.map((point) => point.nextBestAction || 'not_planned'))
  };
}

function nextBestAction(point = {}, recommendedJobs = []) {
  if (point.canBeClosedByHumanReview && !point.canBeClosedByTargetedCrawl) return 'human_review';
  if (point.canBeClosedByExternalImport && recommendedJobs.length === 0) return 'external_import';
  if (recommendedJobs.length) return `plan_${recommendedJobs[0].jobType}`;
  if (point.canBeClosedByExternalImport) return 'external_import';
  if (point.canBeClosedByHumanReview) return 'human_review';
  return 'manual_triage';
}

function requiredEvidenceFor(gapTypes = []) {
  const labels = {
    needs_title_facts: 'Title length, hash and pattern facts for a broader URL set.',
    needs_meta_description_facts: 'Meta description presence, length, hash and pattern facts.',
    needs_h1_facts: 'H1 count/text/hash facts.',
    needs_canonical_facts: 'Canonical target, status and pattern facts.',
    needs_xrobots_facts: 'Meta robots and X-Robots-Tag facts.',
    needs_hreflang_facts: 'Hreflang alternate/x-default facts.',
    needs_resource_facts: 'CSS/JS/resource-hint and third-party origin aggregates.',
    needs_link_aggregates: 'Internal/external link aggregates and coarse graph signals.',
    needs_schema_summary: 'Schema type/count/hash and parse-summary facts.',
    needs_raw_html_signal: 'Raw HTML presence signals for SEO-critical elements.',
    needs_rendered_html_sample: 'Capped rendered-vs-raw sample facts.',
    needs_crux_psi: 'CrUX/PSI/Lighthouse import or resource/performance proxy facts.',
    needs_human_quality_review: 'Human qualitative review evidence.',
    needs_legal_privacy_review: 'Legal/privacy review evidence.',
    needs_entity_trust_review: 'Entity/trust review evidence.',
    needs_more_urls: 'Broader URL set than the current sample.',
    needs_larger_crawl: 'Larger URL basis or targeted fact crawl.',
    needs_external_import: 'External import source or uploaded dataset.'
  };
  return gapTypes.map((gapType) => labels[gapType] || gapType);
}

function recommendedReviewType(gapTypes = []) {
  if (gapTypes.includes('needs_legal_privacy_review')) return 'legal_privacy';
  if (gapTypes.includes('needs_entity_trust_review')) return 'entity_trust';
  if (gapTypes.includes('needs_human_quality_review')) return 'quality_review';
  if (gapTypes.includes('needs_manual_strategy_context')) return 'strategy_context';
  return null;
}

function riskIfIgnored(row = {}, gapTypes = []) {
  if ((row.manualItem?.priority || '') === 'High') return 'high';
  if (gapTypes.includes('needs_larger_crawl') || gapTypes.includes('needs_external_import')) return 'medium';
  if (gapTypes.some((gap) => /human|legal|entity/.test(gap))) return 'medium';
  return 'low';
}

function currentLimitation(row = {}, gapTypes = []) {
  if (row.coverageStatus === 'covered_in_sample') return 'Evidence is strong in the current sample, but full-domain reach is not proven.';
  if (gapTypes.includes('needs_external_import')) return 'The current run has related tool evidence, but required external data is missing.';
  if (gapTypes.some((gap) => /human|legal|entity/.test(gap))) return 'Technical evidence exists, but final interpretation requires review.';
  if (gapTypes.includes('needs_larger_crawl')) return 'The current URL basis is too small for full-domain affected counts.';
  return 'The existing match is useful but not yet strong enough to close the reference point.';
}

function compactToolFindings(row = {}) {
  const findings = row.matchedToolFindings?.length ? row.matchedToolFindings : row.toolFinding ? [row.toolFinding] : [];
  return findings.map((finding) => ({
    id: finding.id,
    checkId: finding.checkId,
    title: finding.checkName || finding.title || finding.checkId,
    status: finding.status,
    priority: finding.priority,
    affectedCount: Number(finding.affectedCount || 0),
    finding: finding.finding || '',
    recommendation: finding.recommendation || '',
    sampleUrls: finding.sampleUrls || []
  }));
}

function sampleUrlsFor(row = {}) {
  return unique((row.matchedToolFindings || [row.toolFinding].filter(Boolean))
    .flatMap((finding) => finding?.sampleUrls || []));
}

function weightedContribution(status) {
  if (status === 'covered') return 1;
  if (status === 'covered_in_sample') return 0.75;
  if (status === 'partially_covered') return 0.5;
  return 0;
}

function pointSort(a, b) {
  const priority = { High: 0, Medium: 1, Low: 2, unknown: 3 };
  const status = { needs_larger_crawl: 0, covered_in_sample: 1, partially_covered: 2, false_positive_candidate: 3 };
  return (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9)
    || (status[a.currentCoverageStatus] ?? 9) - (status[b.currentCoverageStatus] ?? 9)
    || String(a.manualTitle).localeCompare(String(b.manualTitle));
}

function countBy(values = []) {
  return values.reduce((acc, value) => {
    if (!value) return acc;
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
