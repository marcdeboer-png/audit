import { normalizeUrl } from '../utils/url.js';
import {
  listEvidenceJobs,
  listTargetedEvidenceFactsForRun
} from './evidenceJobRepository.js';

const TARGETED_JOB_TYPES = Object.freeze([
  'title_facts',
  'meta_description_facts',
  'h1_facts',
  'canonical_robots_facts'
]);

const STATUS_WEIGHT = Object.freeze({
  covered: 1,
  covered_in_sample: 0.75,
  partially_covered: 0.5,
  tool_finds_extra: 0.5,
  false_positive_candidate: 0.25,
  needs_larger_crawl: 0.25,
  needs_human_review: 0.25,
  needs_llm_review: 0.25,
  needs_external_data: 0,
  not_covered: 0,
  not_applicable: 0
});

const CONFIDENCE_SCORE = Object.freeze({
  none: 0,
  low: 25,
  medium: 55,
  high: 82
});

export function buildEvidenceImpactForRun(db, runId, options = {}) {
  const validation = options.validationReport
    ? { report: options.validationReport, id: options.validationId || options.validationReport.validationId || null }
    : latestValidationReport(db, runId);
  const report = validation?.report || null;
  const jobs = listEvidenceJobs(db, runId, { limit: 500 }).filter((job) => TARGETED_JOB_TYPES.includes(job.jobType));
  const facts = listTargetedEvidenceFactsForRun(db, runId, {
    limit: options.factLimit || 50000,
    jobTypes: TARGETED_JOB_TYPES
  });
  const factIndex = buildTargetedFactIndex(facts, jobs);
  const jobSummaries = buildTargetedFactSummaries(facts, jobs);
  const baselineReport = report || { runId, coverageMatrix: [], validationSummary: {} };
  const impact = buildEvidenceImpactFromReport(baselineReport, {
    runId,
    validationId: validation?.id || baselineReport.validationId || null,
    jobs,
    facts,
    factIndex,
    jobSummaries,
    simulatedBaseline: !options.baselineReport
  });
  return impact;
}

export function buildEvidenceImpactFromReport(report = {}, context = {}) {
  const runId = context.runId || report.runId || null;
  const jobs = context.jobs || [];
  const facts = context.facts || [];
  const factIndex = context.factIndex || buildTargetedFactIndex(facts, jobs);
  const jobSummaries = context.jobSummaries || buildTargetedFactSummaries(facts, jobs);
  const rows = Array.isArray(report.coverageMatrix) ? report.coverageMatrix : [];
  const beforeById = new Map(rows.map((row) => [row.manualItemId, row.coverageStatus]));
  const itemImpacts = rows.map((row) => assessManualItemImpact(row, factIndex, jobSummaries, jobs));
  const changedItems = itemImpacts.filter((item) => item.impactType !== 'no_change');
  const upgradedItems = itemImpacts.filter((item) => item.previousStatus !== item.newStatus);
  const downgradedItems = itemImpacts.filter((item) => weightForStatus(item.newStatus) < weightForStatus(item.previousStatus));
  const unchangedItems = itemImpacts.filter((item) => item.impactType === 'no_change');
  const recalculatedBefore = coverageSnapshot(report, rows.map((row) => ({
    status: beforeById.get(row.manualItemId),
    originalRow: row
  })));
  const coverageBefore = coverageSnapshotFromSummary(report, recalculatedBefore);
  const recalculatedAfter = coverageSnapshot(report, itemImpacts.map((item) => ({
    status: item.newStatus,
    originalRow: item.originalRow
  })));
  const coverageAfter = coverageSnapshotAfterDelta(report, coverageBefore, recalculatedBefore, recalculatedAfter);
  const remainingGaps = buildRemainingGaps(itemImpacts);
  const nextRecommendedJobs = recommendNextJobs(itemImpacts, jobs, factIndex);

  return {
    runId,
    validationId: context.validationId || report.validationId || null,
    generatedAt: new Date().toISOString(),
    simulatedBaseline: Boolean(context.simulatedBaseline),
    jobsConsidered: jobs.map(formatJobSummary),
    factsConsidered: facts.length,
    factSummaries: jobSummaries,
    manualItemsImpacted: changedItems.length,
    coverageBefore,
    coverageAfter,
    changedItems: changedItems.map(stripInternalImpactFields),
    unchangedItems: unchangedItems.map(stripInternalImpactFields),
    upgradedItems: upgradedItems.map(stripInternalImpactFields),
    downgradedItems: downgradedItems.map(stripInternalImpactFields),
    remainingGaps,
    nextRecommendedJobs
  };
}

export function renderEvidenceImpactMarkdown(impact = {}) {
  const before = impact.coverageBefore || {};
  const after = impact.coverageAfter || {};
  const lines = [
    `# Evidence Job Impact - Run ${impact.runId || 'n/a'}`,
    '',
    `Generated: ${impact.generatedAt || ''}`,
    '',
    '## Summary',
    '',
    `- Jobs considered: ${(impact.jobsConsidered || []).length}`,
    `- Facts considered: ${impact.factsConsidered || 0}`,
    `- Impacted manual items: ${impact.manualItemsImpacted || 0}`,
    `- Coverage before: ${before.coveragePercent ?? 0}%`,
    `- Coverage after: ${after.coveragePercent ?? 0}%`,
    `- Changed items: ${(impact.changedItems || []).length}`,
    `- Upgrades: ${(impact.upgradedItems || []).length}`,
    `- Simulated baseline: ${impact.simulatedBaseline ? 'yes' : 'no'}`,
    '',
    '## Job Summaries',
    ''
  ];
  for (const summary of Object.values(impact.factSummaries || {})) {
    lines.push(
      `- **${md(summary.jobType)}**: ${summary.checkedUrls || 0} checked, ${summary.issueCount || 0} issue signals, ${summary.duplicateGroupCount || 0} duplicate group(s).`
    );
  }
  if (!Object.keys(impact.factSummaries || {}).length) lines.push('- No targeted fact summaries available.');
  lines.push('', '## Changed Manual Items', '', '| Manual Item | Before | After | Confidence | Impact | Evidence Jobs | Removed Missing Reasons | Remaining Missing Reasons |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of (impact.changedItems || []).slice(0, 200)) {
    lines.push(`| ${md(item.title)} | ${md(item.previousStatus)} | ${md(item.newStatus)} | ${md(`${item.previousConfidence || 'none'} -> ${item.newConfidence || 'none'}`)} | ${md(item.impactType)} | ${md((item.evidenceJobsUsed || []).join(', '))} | ${md((item.removedMissingReasons || []).join(', '))} | ${md((item.remainingMissingReasons || []).join(', '))} |`);
  }
  if (!(impact.changedItems || []).length) lines.push('| No changed items |  |  |  |  |  |  |  |');
  lines.push('', '## Remaining Gaps', '');
  for (const gap of impact.remainingGaps || []) {
    lines.push(`- **${md(gap.reason)}**: ${gap.count || 0} item(s), next jobs: ${md((gap.nextRecommendedJobs || []).join(', ') || 'none')}`);
  }
  if (!(impact.remainingGaps || []).length) lines.push('- No remaining gaps derived from the current targeted evidence impact.');
  lines.push('', '## Next Recommended Jobs', '');
  for (const job of impact.nextRecommendedJobs || []) {
    lines.push(`- **${md(job.jobType)}** (${job.priority || 'medium'}): ${md(job.reason || '')}`);
  }
  if (!(impact.nextRecommendedJobs || []).length) lines.push('- No additional low-risk targeted job recommended from this impact run.');
  return `${lines.join('\n')}\n`;
}

export function buildTargetedFactIndex(facts = [], jobs = []) {
  const byJobType = new Map();
  const byUrl = new Map();
  const byJobId = new Map();
  const jobsById = new Map(jobs.map((job) => [String(job.jobId), job]));
  for (const fact of facts) {
    const normalizedUrl = normalizeUrl(fact.normalizedUrl || fact.url || fact.finalUrl) || fact.normalizedUrl || fact.url;
    const finalUrl = normalizeUrl(fact.finalUrl) || fact.finalUrl;
    appendMapArray(byJobType, fact.jobType, fact);
    appendMapArray(byJobId, String(fact.jobId), fact);
    for (const key of [fact.url, fact.normalizedUrl, finalUrl, normalizedUrl].filter(Boolean)) {
      appendMapArray(byUrl, normalizeUrl(key) || key, fact);
    }
  }
  return {
    byJobType,
    byUrl,
    byJobId,
    jobsById,
    facts,
    jobs
  };
}

export function buildTargetedFactSummaries(facts = [], jobs = []) {
  const jobsByType = groupBy(jobs, (job) => job.jobType);
  const factsByType = groupBy(facts, (fact) => fact.jobType);
  const summaries = {};
  for (const jobType of TARGETED_JOB_TYPES) {
    const typeFacts = factsByType[jobType] || [];
    if (!typeFacts.length && !(jobsByType[jobType] || []).length) continue;
    summaries[jobType] = summarizeFactsForType(jobType, typeFacts, jobsByType[jobType] || []);
  }
  return summaries;
}

function assessManualItemImpact(row = {}, factIndex, jobSummaries, jobs = []) {
  const relevantJobTypes = relevantJobTypesForRow(row);
  const relevantFacts = relevantJobTypes.flatMap((jobType) => factIndex.byJobType.get(jobType) || []);
  const jobsUsed = unique(relevantFacts.map((fact) => fact.jobType));
  const previousStatus = row.coverageStatus || 'not_applicable';
  const previousConfidence = row.confidence || 'low';
  const previousScore = Number(row.evidenceMatchScore || row.matchScore || CONFIDENCE_SCORE[previousConfidence] || 0);
  const previousMissingReasons = unique(row.missingReasons || []);
  const existingMatchReasons = unique(row.matchReasons || []);
  const targetSignals = relevantJobTypes.map((jobType) => jobSummaries[jobType]).filter(Boolean);
  const hasRelevantFacts = Boolean(relevantFacts.length);
  const sampleStats = sampleStatsForJobs(relevantJobTypes, jobs, relevantFacts);
  const newMatchReasons = hasRelevantFacts ? buildNewMatchReasons(row, relevantJobTypes, targetSignals, factIndex) : [];
  const removedMissingReasons = hasRelevantFacts
    ? removableMissingReasons(row, previousMissingReasons, relevantJobTypes, targetSignals, sampleStats)
    : [];
  const remainingMissingReasons = previousMissingReasons.filter((reason) => !removedMissingReasons.includes(reason));
  const limitations = limitationFlags(row, remainingMissingReasons, sampleStats);
  const boost = hasRelevantFacts ? evidenceBoost(newMatchReasons, removedMissingReasons, targetSignals) : 0;
  const newScore = Math.min(100, previousScore + boost);
  const newConfidence = hasRelevantFacts ? confidenceFromScore(newScore) : previousConfidence;
  const newStatus = statusAfterEvidence(row, {
    hasRelevantFacts,
    previousStatus,
    previousScore,
    newScore,
    targetSignals,
    sampleStats,
    limitations,
    removedMissingReasons,
    remainingMissingReasons
  });
  const impactType = impactTypeFor({
    previousStatus,
    newStatus,
    previousConfidence,
    newConfidence,
    hasRelevantFacts,
    removedMissingReasons,
    limitations
  });
  return {
    manualItemId: row.manualItemId,
    title: row.manualItem?.title || row.title || row.manualItemId,
    previousStatus,
    newStatus,
    previousConfidence,
    newConfidence,
    previousMatchScore: previousScore,
    newMatchScore: newScore,
    evidenceJobsUsed: jobsUsed,
    newMatchReasons,
    allMatchReasons: unique([...existingMatchReasons, ...newMatchReasons]),
    removedMissingReasons,
    remainingMissingReasons,
    impactType,
    impactExplanation: impactExplanation(row, {
      previousStatus,
      newStatus,
      jobsUsed,
      sampleStats,
      limitations,
      removedMissingReasons
    }),
    canUpgrade: previousStatus !== newStatus,
    upgradeLimitations: upgradeLimitations(limitations, sampleStats, remainingMissingReasons),
    relevantJobTypes,
    factCount: relevantFacts.length,
    sampleSize: sampleStats.checkedUrls,
    sampleBased: sampleStats.sampleBased,
    jobLimited: sampleStats.jobLimited,
    originalRow: row
  };
}

function relevantJobTypesForRow(row = {}) {
  const tokens = [
    row.manualItem?.title,
    row.manualItem?.description,
    row.manualItem?.category,
    row.category,
    row.partialReason,
    row.matchedCheckId,
    ...(row.matchedCheckIds || []),
    ...(row.expectedCheckIds || []),
    ...(row.relatedCheckIds || []),
    ...(row.missingReasons || []),
    ...(row.matchReasons || [])
  ].join(' ').toLowerCase();
  const types = [];
  if (/\btitle\b|seo_title|page_title|serp title|titel/.test(tokens)) types.push('title_facts');
  if (/meta[\s_-]?description|description_missing|description_too|meta beschreibung/.test(tokens)) types.push('meta_description_facts');
  if (/\bh1\b|headline|heading|ueberschrift|überschrift/.test(tokens)) types.push('h1_facts');
  if (/canonical|robots|noindex|nofollow|indexability|x-robots|indexier/.test(tokens)) types.push('canonical_robots_facts');
  return unique(types);
}

function buildNewMatchReasons(row, jobTypes, summaries, factIndex) {
  const reasons = [];
  for (const jobType of jobTypes) {
    if ((factIndex.byJobType.get(jobType) || []).length) reasons.push(`targeted_${jobType}_available`);
  }
  if (summaries.some((summary) => summary.checkedUrls > 0)) reasons.push('targeted_fact_url_sample_available');
  if (summaries.some((summary) => summary.issueCount > 0)) reasons.push('targeted_fact_issue_summary_available');
  if (summaries.some((summary) => summary.duplicateGroupCount > 0 || summary.patternGroupCount > 0)) reasons.push('targeted_fact_hash_pattern_available');
  const affectedUrls = (row.manualItem?.affectedUrls || []).map((url) => normalizeUrl(url)).filter(Boolean);
  if (affectedUrls.length && affectedUrls.some((url) => factIndex.byUrl.has(url))) reasons.push('targeted_url_overlap');
  if ((row.expectedCheckIds || []).length && jobTypes.length) reasons.push('targeted_check_family_match');
  return unique(reasons);
}

function removableMissingReasons(row, missingReasons, jobTypes, summaries, sampleStats) {
  const removable = new Set();
  if (!missingReasons.length) return [];
  if (summaries.some((summary) => summary.checkedUrls > 0)) {
    removable.add('evidence_too_weak');
    removable.add('missing_affected_count');
  }
  if (jobTypes.includes('title_facts')) removable.add('weak_title_match');
  if (jobTypes.includes('meta_description_facts')) removable.add('weak_title_match');
  if (jobTypes.includes('h1_facts')) removable.add('weak_title_match');
  if (jobTypes.includes('canonical_robots_facts')) {
    removable.add('weak_title_match');
    removable.add('missing_data_source');
  }
  if (summaries.some((summary) => summary.duplicateGroupCount > 0 || summary.patternGroupCount > 0)) {
    removable.add('missing_template_context');
    removable.add('missing_page_type_context');
  }
  const affectedUrls = (row.manualItem?.affectedUrls || []).map((url) => normalizeUrl(url)).filter(Boolean);
  if (affectedUrls.length && sampleStats.checkedUrls > 0) removable.add('missing_url_overlap');
  return missingReasons.filter((reason) => removable.has(reason));
}

function limitationFlags(row, remainingMissingReasons, sampleStats) {
  const manual = row.manualItem || {};
  const fullScopeNeeded = Boolean(
    row.needsLargerCrawl ||
    row.sampleBased ||
    remainingMissingReasons.includes('sample_too_small') ||
    /domain|sitewide|full crawl|gesamt|alle url|alle seiten|crawler|crawl-bloat/i.test([manual.title, manual.description, row.rationale].join(' '))
  );
  return {
    needsMoreUrls: fullScopeNeeded || sampleStats.jobLimited || sampleStats.checkedUrls > 0 && sampleStats.checkedUrls < 100,
    needsHumanReview: Boolean(manual.requiresHumanJudgment || row.coverageStatus === 'needs_human_review' || remainingMissingReasons.includes('human_review_needed')),
    needsLlmReview: Boolean(manual.requiresLlmJudgment || row.coverageStatus === 'needs_llm_review'),
    needsExternalData: Boolean(manual.requiresExternalData || row.coverageStatus === 'needs_external_data' || remainingMissingReasons.includes('missing_data_source') && !sampleStats.checkedUrls),
    fullScopeNeeded
  };
}

function statusAfterEvidence(row, context) {
  const {
    hasRelevantFacts,
    previousStatus,
    newScore,
    targetSignals,
    sampleStats,
    limitations,
    remainingMissingReasons
  } = context;
  if (!hasRelevantFacts) return previousStatus;
  if (['covered', 'not_applicable', 'false_positive_candidate', 'tool_finds_extra'].includes(previousStatus)) return previousStatus;
  if (limitations.needsExternalData) return previousStatus === 'needs_external_data' ? previousStatus : 'needs_external_data';
  if (limitations.needsHumanReview) return previousStatus === 'needs_human_review' ? previousStatus : 'needs_human_review';
  if (limitations.needsLlmReview) return previousStatus === 'needs_llm_review' ? previousStatus : 'needs_llm_review';
  const strongSignals = targetSignals.some((summary) => summary.checkedUrls > 0 && (summary.issueCount > 0 || summary.checkedUrls >= 5));
  const directEnough = newScore >= 72 && strongSignals;
  if (!directEnough) return previousStatus;
  if (limitations.needsMoreUrls || sampleStats.sampleBased || remainingMissingReasons.includes('sample_too_small')) {
    return 'covered_in_sample';
  }
  return 'covered';
}

function impactTypeFor(context) {
  const {
    previousStatus,
    newStatus,
    previousConfidence,
    newConfidence,
    hasRelevantFacts,
    removedMissingReasons,
    limitations
  } = context;
  if (!hasRelevantFacts) {
    if (limitations.needsHumanReview) return 'needs_human_review';
    if (limitations.needsExternalData) return 'needs_external_data';
    return 'no_change';
  }
  if (newStatus !== previousStatus && newStatus === 'covered') return 'covered_upgrade';
  if (newStatus !== previousStatus && newStatus === 'covered_in_sample') return 'covered_in_sample_upgrade';
  if (removedMissingReasons.length) return 'missing_reason_closed';
  if (confidenceRank(newConfidence) > confidenceRank(previousConfidence)) return 'confidence_improved';
  if (limitations.needsMoreUrls) return 'needs_more_urls';
  if (limitations.needsHumanReview) return 'needs_human_review';
  if (limitations.needsExternalData) return 'needs_external_data';
  return 'no_change';
}

function evidenceBoost(matchReasons, removedMissingReasons, summaries) {
  let boost = 0;
  boost += matchReasons.length * 4;
  boost += removedMissingReasons.length * 5;
  if (summaries.some((summary) => summary.checkedUrls >= 20)) boost += 8;
  else if (summaries.some((summary) => summary.checkedUrls >= 5)) boost += 5;
  if (summaries.some((summary) => summary.issueCount > 0)) boost += 6;
  if (summaries.some((summary) => summary.duplicateGroupCount > 0 || summary.patternGroupCount > 0)) boost += 4;
  return Math.min(28, boost);
}

function sampleStatsForJobs(jobTypes, jobs, facts) {
  const relevantJobs = jobs.filter((job) => jobTypes.includes(job.jobType));
  const checkedUrls = unique(facts.map((fact) => fact.normalizedUrl || fact.url).filter(Boolean)).length;
  const plannedUrls = relevantJobs.reduce((sum, job) => sum + Number(job.urlCountPlanned || 0), 0);
  const processedUrls = relevantJobs.reduce((sum, job) => sum + Number(job.urlCountProcessed || 0), 0);
  const maxUrls = relevantJobs.reduce((sum, job) => sum + Number(job.maxUrls || 0), 0);
  const jobLimited = relevantJobs.some((job) => Number(job.maxUrls || 0) > 0 && Number(job.maxUrls || 0) < Number(job.urlCountPlanned || 0));
  return {
    checkedUrls,
    plannedUrls,
    processedUrls,
    maxUrls,
    jobLimited,
    sampleBased: jobLimited || checkedUrls > 0 && checkedUrls < 100
  };
}

function summarizeFactsForType(jobType, facts, jobs) {
  const base = {
    jobType,
    jobs: jobs.map(formatJobSummary),
    checkedUrls: unique(facts.map((fact) => fact.normalizedUrl || fact.url).filter(Boolean)).length,
    factRows: facts.length,
    failedRows: facts.filter((fact) => fact.error).length,
    issueCount: 0,
    duplicateGroupCount: 0,
    patternGroupCount: 0,
    examples: facts.slice(0, 5).map((fact) => fact.normalizedUrl || fact.url)
  };
  if (jobType === 'title_facts') {
    return {
      ...base,
      missingCount: countFact(facts, 'titleMissing'),
      emptyCount: countFact(facts, 'titleEmpty'),
      tooShortCount: countFact(facts, 'titleTooShort'),
      tooLongCount: countFact(facts, 'titleTooLong'),
      duplicateHashGroups: duplicateGroups(facts, 'titleHash'),
      patternSummary: patternSummary(facts, 'titlePattern'),
      get duplicateGroupCount() { return this.duplicateHashGroups.length; },
      get patternGroupCount() { return this.patternSummary.length; },
      get issueCount() { return this.missingCount + this.emptyCount + this.tooShortCount + this.tooLongCount + this.duplicateHashGroups.length; }
    };
  }
  if (jobType === 'meta_description_facts') {
    return {
      ...base,
      missingCount: countFact(facts, 'metaDescriptionMissing'),
      emptyCount: countFact(facts, 'metaDescriptionEmpty'),
      tooShortCount: countFact(facts, 'metaDescriptionTooShort'),
      tooLongCount: countFact(facts, 'metaDescriptionTooLong'),
      duplicateHashGroups: duplicateGroups(facts, 'metaDescriptionHash'),
      patternSummary: patternSummary(facts, 'metaDescriptionPattern'),
      get duplicateGroupCount() { return this.duplicateHashGroups.length; },
      get patternGroupCount() { return this.patternSummary.length; },
      get issueCount() { return this.missingCount + this.emptyCount + this.tooShortCount + this.tooLongCount + this.duplicateHashGroups.length; }
    };
  }
  if (jobType === 'h1_facts') {
    return {
      ...base,
      missingCount: countFact(facts, 'h1Missing'),
      emptyCount: countFact(facts, 'h1Empty'),
      multipleCount: countFact(facts, 'h1Multiple'),
      duplicateHashGroups: duplicateGroups(facts, 'h1Hash'),
      patternSummary: patternSummary(facts, 'firstH1'),
      get duplicateGroupCount() { return this.duplicateHashGroups.length; },
      get patternGroupCount() { return this.patternSummary.length; },
      get issueCount() { return this.missingCount + this.emptyCount + this.multipleCount + this.duplicateHashGroups.length; }
    };
  }
  if (jobType === 'canonical_robots_facts') {
    return {
      ...base,
      canonicalMissingCount: countFact(facts, 'canonicalMissing'),
      canonicalExternalCount: countFact(facts, 'canonicalExternal'),
      canonicalNonSelfCount: facts.filter((fact) => fact.facts?.canonical && fact.facts?.canonicalSelfReferencing === false).length,
      metaNoindexCount: countFact(facts, 'metaNoindex'),
      metaNofollowCount: countFact(facts, 'metaNofollow'),
      xRobotsNoindexCount: countFact(facts, 'xRobotsNoindex'),
      xRobotsNofollowCount: countFact(facts, 'xRobotsNofollow'),
      robotsConflictCount: countFact(facts, 'robotsConflict'),
      get issueCount() {
        return this.canonicalMissingCount + this.canonicalExternalCount + this.canonicalNonSelfCount +
          this.metaNoindexCount + this.metaNofollowCount + this.xRobotsNoindexCount +
          this.xRobotsNofollowCount + this.robotsConflictCount;
      }
    };
  }
  return base;
}

function coverageSnapshot(report, items) {
  const manualCount = Number(report.validationSummary?.manualItemCount || items.length || 0);
  const counts = {};
  let weighted = 0;
  for (const item of items) {
    const status = item.status || 'not_applicable';
    counts[status] = (counts[status] || 0) + 1;
    weighted += weightForStatus(status);
  }
  const denominator = manualCount || items.length || 1;
  return {
    manualItemCount: manualCount,
    covered: counts.covered || 0,
    coveredInSample: counts.covered_in_sample || 0,
    partiallyCovered: counts.partially_covered || 0,
    notCovered: counts.not_covered || 0,
    needsExternalData: counts.needs_external_data || 0,
    needsLargerCrawl: counts.needs_larger_crawl || 0,
    needsHumanReview: counts.needs_human_review || 0,
    needsLlmReview: counts.needs_llm_review || 0,
    coveragePercent: Number(((weighted / denominator) * 100).toFixed(1)),
    rawStatusCounts: counts
  };
}

function coverageSnapshotFromSummary(report, fallback) {
  const summary = report.validationSummary || {};
  if (summary.coveragePercent === undefined && summary.manualItemCount === undefined) return fallback;
  return {
    ...fallback,
    manualItemCount: Number(summary.manualItemCount || fallback.manualItemCount || 0),
    covered: Number(summary.covered ?? fallback.covered ?? 0),
    coveredInSample: Number(summary.coveredInSample ?? fallback.coveredInSample ?? 0),
    partiallyCovered: Number(summary.partiallyCovered ?? fallback.partiallyCovered ?? 0),
    notCovered: Number(summary.notCovered ?? fallback.notCovered ?? 0),
    needsExternalData: Number(summary.needsExternalData ?? fallback.needsExternalData ?? 0),
    needsLargerCrawl: Number(summary.needsLargerCrawl ?? fallback.needsLargerCrawl ?? 0),
    needsHumanReview: Number(summary.needsHumanReview ?? fallback.needsHumanReview ?? 0),
    needsLlmReview: Number(summary.needsLlmReview ?? fallback.needsLlmReview ?? 0),
    coveragePercent: Number(summary.coveragePercent ?? fallback.coveragePercent ?? 0),
    storedSummaryBasis: true
  };
}

function coverageSnapshotAfterDelta(report, before, recalculatedBefore, recalculatedAfter) {
  const delta = Number((Number(recalculatedAfter.coveragePercent || 0) - Number(recalculatedBefore.coveragePercent || 0)).toFixed(1));
  return {
    ...recalculatedAfter,
    manualItemCount: Number(report.validationSummary?.manualItemCount || recalculatedAfter.manualItemCount || before.manualItemCount || 0),
    coveragePercent: Number((Number(before.coveragePercent || 0) + delta).toFixed(1)),
    baselineCoveragePercent: before.coveragePercent,
    recalculatedCoveragePercent: recalculatedAfter.coveragePercent,
    deltaCoveragePercent: delta
  };
}

function buildRemainingGaps(items) {
  const grouped = {};
  for (const item of items) {
    for (const reason of item.remainingMissingReasons || []) {
      grouped[reason] = grouped[reason] || {
        reason,
        count: 0,
        manualItemIds: [],
        nextRecommendedJobs: new Set()
      };
      grouped[reason].count += 1;
      grouped[reason].manualItemIds.push(item.manualItemId);
      for (const jobType of nextJobsForReason(reason, item.relevantJobTypes)) grouped[reason].nextRecommendedJobs.add(jobType);
    }
  }
  return Object.values(grouped)
    .sort((a, b) => b.count - a.count)
    .map((gap) => ({
      ...gap,
      manualItemIds: gap.manualItemIds.slice(0, 20),
      nextRecommendedJobs: Array.from(gap.nextRecommendedJobs)
    }));
}

function recommendNextJobs(items, jobs, factIndex) {
  const executed = new Set(jobs.map((job) => job.jobType));
  const candidates = new Map();
  for (const item of items) {
    const reasons = item.remainingMissingReasons || [];
    for (const reason of reasons) {
      for (const jobType of nextJobsForReason(reason, item.relevantJobTypes)) {
        if (!TARGETED_JOB_TYPES.includes(jobType)) continue;
        const current = candidates.get(jobType) || {
          jobType,
          pointCount: 0,
          priority: 'medium',
          reason: recommendationReason(jobType, reason),
          alreadyExecuted: executed.has(jobType),
          existingFacts: (factIndex.byJobType.get(jobType) || []).length
        };
        current.pointCount += 1;
        candidates.set(jobType, current);
      }
    }
    if (!item.evidenceJobsUsed.length) {
      for (const jobType of item.relevantJobTypes || []) {
        const current = candidates.get(jobType) || {
          jobType,
          pointCount: 0,
          priority: 'medium',
          reason: recommendationReason(jobType, 'needs_different_job'),
          alreadyExecuted: executed.has(jobType),
          existingFacts: (factIndex.byJobType.get(jobType) || []).length
        };
        current.pointCount += 1;
        candidates.set(jobType, current);
      }
    }
  }
  return Array.from(candidates.values())
    .filter((candidate) => !candidate.alreadyExecuted || candidate.pointCount > 0)
    .sort((a, b) => Number(a.alreadyExecuted) - Number(b.alreadyExecuted) || b.pointCount - a.pointCount)
    .slice(0, 8);
}

function nextJobsForReason(reason, fallbackJobTypes = []) {
  if (reason === 'sample_too_small') return fallbackJobTypes.length ? fallbackJobTypes : TARGETED_JOB_TYPES;
  if (reason === 'missing_affected_count' || reason === 'evidence_too_weak' || reason === 'missing_url_overlap') return fallbackJobTypes.length ? fallbackJobTypes : TARGETED_JOB_TYPES;
  if (reason === 'weak_title_match') return fallbackJobTypes.length ? fallbackJobTypes : ['title_facts', 'meta_description_facts', 'h1_facts'];
  if (reason === 'missing_data_source') return fallbackJobTypes.length ? fallbackJobTypes : ['canonical_robots_facts'];
  if (reason === 'missing_template_context' || reason === 'missing_page_type_context') return fallbackJobTypes.length ? fallbackJobTypes : ['title_facts', 'meta_description_facts', 'h1_facts'];
  return fallbackJobTypes;
}

function recommendationReason(jobType, reason) {
  const labels = {
    title_facts: 'Title-Facts erweitern Match-Evidence, Hashes und Pattern im Sample.',
    meta_description_facts: 'Meta-Description-Facts schließen fehlende Evidence und betroffene Counts im Sample.',
    h1_facts: 'H1-Facts liefern Headline-Signale und Multiple/Missing-Auswertung.',
    canonical_robots_facts: 'Canonical/Robots-Facts klären Indexability-, Canonical- und X-Robots-Signale.'
  };
  return `${labels[jobType] || 'Targeted Facts sammeln.'} Anlass: ${reason}.`;
}

function impactExplanation(row, context) {
  const { previousStatus, newStatus, jobsUsed, sampleStats, limitations, removedMissingReasons } = context;
  if (!jobsUsed.length) return 'Keine passenden Targeted Evidence Facts fuer diesen Auditpunkt vorhanden.';
  const scope = limitations.needsMoreUrls
    ? `Die Facts decken ${sampleStats.checkedUrls} URL(s) ab und bleiben sample-basiert.`
    : `Die Facts decken ${sampleStats.checkedUrls} URL(s) ab.`;
  const status = previousStatus !== newStatus
    ? `Statuswechsel ${previousStatus} -> ${newStatus}.`
    : `Status bleibt ${previousStatus}.`;
  const closed = removedMissingReasons.length
    ? `Geschlossene Missing Reasons: ${removedMissingReasons.join(', ')}.`
    : 'Keine Missing Reasons voll geschlossen.';
  return `${status} ${scope} ${closed}`;
}

function upgradeLimitations(limitations, sampleStats, remainingMissingReasons) {
  const output = [];
  if (limitations.needsMoreUrls) output.push(`limited_url_basis:${sampleStats.checkedUrls}`);
  if (sampleStats.jobLimited) output.push('job_max_urls_applied');
  if (limitations.needsHumanReview) output.push('human_review_required');
  if (limitations.needsLlmReview) output.push('llm_review_required');
  if (limitations.needsExternalData) output.push('external_data_required');
  for (const reason of remainingMissingReasons) {
    if (!output.includes(reason)) output.push(reason);
  }
  return output;
}

function stripInternalImpactFields(item) {
  const { originalRow, ...rest } = item;
  return rest;
}

function formatJobSummary(job = {}) {
  return {
    jobId: job.jobId,
    runId: job.runId,
    jobType: job.jobType,
    status: job.status,
    urlSource: job.urlSource,
    urlCountPlanned: job.urlCountPlanned,
    urlCountProcessed: job.urlCountProcessed,
    urlCountSucceeded: job.urlCountSucceeded,
    urlCountFailed: job.urlCountFailed,
    maxUrls: job.maxUrls,
    actualStoredBytesEstimate: job.actualStoredBytesEstimate,
    warnings: job.warnings || []
  };
}

function countFact(facts, key) {
  return facts.filter((fact) => Boolean(fact.facts?.[key])).length;
}

function duplicateGroups(facts, key) {
  return Object.entries(groupBy(facts.filter((fact) => fact.facts?.[key]), (fact) => fact.facts[key]))
    .filter(([, rows]) => rows.length > 1)
    .map(([hash, rows]) => ({
      hash,
      count: rows.length,
      sampleUrls: rows.slice(0, 5).map((row) => row.normalizedUrl || row.url)
    }));
}

function patternSummary(facts, key) {
  return Object.entries(groupBy(facts.filter((fact) => fact.facts?.[key]), (fact) => fact.facts[key]))
    .filter(([, rows]) => rows.length > 1)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 20)
    .map(([pattern, rows]) => ({
      pattern,
      count: rows.length,
      sampleUrls: rows.slice(0, 5).map((row) => row.normalizedUrl || row.url)
    }));
}

function appendMapArray(map, key, value) {
  if (!key) return;
  const normalizedKey = String(key);
  if (!map.has(normalizedKey)) map.set(normalizedKey, []);
  map.get(normalizedKey).push(value);
}

function groupBy(rows = [], keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || 'unknown';
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});
}

function unique(values = []) {
  return Array.from(new Set(values.filter((value) => value !== null && value !== undefined && value !== '')));
}

function confidenceFromScore(score) {
  if (score >= 75) return 'high';
  if (score >= 45) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function confidenceRank(value) {
  return { none: 0, low: 1, medium: 2, high: 3 }[value] || 0;
}

function weightForStatus(status) {
  return STATUS_WEIGHT[status] ?? 0;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function latestValidationReport(db, runId) {
  const row = db.prepare(`
    SELECT *
    FROM validation_reports
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(runId);
  return row ? {
    ...row,
    summary: safeJson(row.summaryJson, {}),
    report: safeJson(row.reportJson, {}),
    benchmarkSummary: safeJson(row.benchmarkSummaryJson, {})
  } : null;
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
