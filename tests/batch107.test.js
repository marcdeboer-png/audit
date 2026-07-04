import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { estimateEvidenceJobStorage } from '../src/evidenceJobs/evidenceJobTypes.js';
import { planEvidenceJobsForPoint } from '../src/evidenceJobs/evidenceJobPlanner.js';
import { classifyEvidenceGaps } from '../src/validation/unresolved/evidenceGapClassifier.js';
import {
  buildUnresolvedAuditQueue,
  renderEvidenceJobPlanMarkdown,
  renderEvidencePacksMarkdown,
  renderUnresolvedAuditQueueMarkdown
} from '../src/validation/unresolved/unresolvedAuditPointService.js';
import { buildValidationExportPayload } from '../src/validation/referenceAudit/validationExportService.js';

test('Batch 10.7 evidence gap classifier maps partial and sample points to concrete gap types', () => {
  const titleSample = coverageRow({
    title: 'Title tag',
    status: 'covered_in_sample',
    partialReason: 'sample_too_small',
    missingReasons: ['sample_too_small'],
    expectedCheckIds: ['tech.title_too_long', 'template.title_pattern_issue']
  });
  const gaps = classifyEvidenceGaps(titleSample);
  assert.ok(gaps.includes('needs_title_facts'));
  assert.ok(gaps.includes('needs_more_urls'));
  assert.ok(gaps.includes('needs_larger_crawl'));

  const lcp = coverageRow({
    title: 'LCP - Largest Contentful Paint',
    status: 'partially_covered',
    partialReason: 'missing_data_source',
    missingReasons: ['missing_data_source'],
    requiredData: ['crux', 'psi', 'lighthouse'],
    expectedCheckIds: ['template.high_lcp']
  });
  const lcpGaps = classifyEvidenceGaps(lcp);
  assert.ok(lcpGaps.includes('needs_resource_facts'));
  assert.ok(lcpGaps.includes('needs_crux_psi'));
  assert.ok(lcpGaps.includes('needs_external_import'));
});

test('Batch 10.7 evidence job planner recommends fact jobs and storage projections', () => {
  const titlePoint = {
    manualItemId: 'manual-title',
    manualTitle: 'Title tag',
    priority: 'High',
    currentCoverageStatus: 'covered_in_sample',
    gapTypes: ['needs_title_facts', 'needs_larger_crawl'],
    sampleUrls: ['https://example.com/a']
  };
  const jobs = planEvidenceJobsForPoint(titlePoint, { run: { processedUrls: 120 } });
  assert.equal(jobs[0].jobType, 'title_facts');
  assert.equal(jobs[0].storesRawHtml, false);
  assert.equal(jobs[0].storesRenderedHtml, false);
  assert.equal(jobs[0].storageEstimate.riskLevel, 'low');
  assert.match(jobs[0].storageEstimate.estimated50kHuman, /MB/);

  const resourceEstimate = estimateEvidenceJobStorage('resource_facts', 50000);
  assert.equal(resourceEstimate.estimated10kBytes, 12000 * 10000);
  assert.equal(resourceEstimate.estimated50kBytes, 12000 * 50000);
  assert.equal(resourceEstimate.estimated400kBytes, 12000 * 400000);
});

test('Batch 10.7 unresolved queue excludes covered rows and creates evidence packs', () => {
  const report = {
    runId: 77,
    run: { id: 77, processedUrls: 120, sourceType: 'crawl' },
    validationSummary: { manualItemCount: 3, coveragePercent: 82.1, dataBasisLabel: 'Sample crawl' },
    coverageMatrix: [
      coverageRow({ title: 'ALT texts', status: 'covered', expectedCheckIds: ['tech.images_without_alt'] }),
      coverageRow({
        id: 'manual-title',
        title: 'Title tag',
        priority: 'High',
        status: 'covered_in_sample',
        partialReason: 'sample_too_small',
        missingReasons: ['sample_too_small'],
        expectedCheckIds: ['tech.title_too_long', 'template.title_pattern_issue']
      }),
      coverageRow({
        id: 'manual-eeat',
        title: 'E-E-A-T',
        priority: 'High',
        status: 'partially_covered',
        partialReason: 'human_review_needed',
        missingReasons: ['human_review_needed'],
        expectedCheckIds: ['trust.eeat_signal_summary']
      })
    ]
  };
  const queue = buildUnresolvedAuditQueue(report);
  assert.equal(queue.summary.unresolvedCount, 2);
  assert.equal(queue.summary.coveredInSample, 1);
  assert.equal(queue.summary.needsTargetedCrawl >= 1, true);
  assert.equal(queue.summary.needsHumanReview >= 1, true);
  assert.ok(queue.points.find((point) => point.manualTitle === 'Title tag').recommendedJobTypes.includes('title_facts'));
  assert.ok(queue.evidencePacks.packs.find((pack) => pack.manualItem.title === 'E-E-A-T'));
  assert.match(renderUnresolvedAuditQueueMarkdown(queue), /Title tag/);
  assert.match(renderEvidencePacksMarkdown(queue.evidencePacks), /Suggested next step/);
  assert.match(renderEvidenceJobPlanMarkdown(queue.evidenceJobPlan), /Runner implemented: yes/);
  assert.match(renderEvidenceJobPlanMarkdown(queue.evidenceJobPlan), /Low-risk targeted fact jobs are executable/);
});

test('Batch 10.7 validation exports include unresolved queue, evidence packs and job plan', () => {
  const queue = buildUnresolvedAuditQueue({
    runId: 78,
    run: { id: 78, processedUrls: 120 },
    validationSummary: { manualItemCount: 1, coveragePercent: 75 },
    coverageMatrix: [coverageRow({
      title: 'Meta description',
      status: 'covered_in_sample',
      partialReason: 'sample_too_small',
      missingReasons: ['sample_too_small'],
      expectedCheckIds: ['tech.meta_description_too_long', 'template.meta_pattern_issue']
    })]
  });
  const files = buildValidationExportPayload({
    runId: 78,
    generatedAt: '2026-07-04T00:00:00.000Z',
    validationSummary: { manualItemCount: 1, coveredInSample: 1, coveragePercent: 75 },
    coverageMatrix: queue.points,
    unresolvedAuditQueue: queue,
    evidencePacks: queue.evidencePacks,
    evidenceJobPlan: queue.evidenceJobPlan,
    unmatchedToolFindings: [],
    nextCheckBacklog: [],
    checkRoadmap: [],
    scoreCalibrationNotes: []
  });
  assert.ok(files['unresolved-audit-points.json']);
  assert.ok(files['evidence-packs.md']);
  assert.ok(files['evidence-job-plan.json']);
  assert.match(files['chef-demo-summary.md'], /Chef-Demo Summary/);
});

test('Batch 10.7 UI and API source expose review queue and evidence endpoints', () => {
  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /review-queue/);
  assert.match(app, /Evidence Queue/);
  assert.match(app, /data-review-filter/);
  assert.match(app, /evidence-job-plan\.md/);

  const server = fs.readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(server, /\/api\/audits\/:runId\/unresolved/);
  assert.match(server, /\/api\/audits\/:runId\/evidence-packs/);
  assert.match(server, /\/api\/audits\/:runId\/evidence-job-plan/);
});

function coverageRow(options = {}) {
  const id = options.id || `manual-${String(options.title || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const toolFinding = {
    id: 1,
    checkId: options.expectedCheckIds?.[0] || 'tech.example',
    checkName: options.title || 'Example finding',
    status: 'Warning',
    priority: options.priority || 'Medium',
    affectedCount: 10,
    finding: `${options.title || 'Example'} finding`,
    recommendation: `${options.title || 'Example'} recommendation`,
    sampleUrls: ['https://example.com/a']
  };
  return {
    manualItemId: id,
    coverageStatus: options.status || 'partially_covered',
    confidence: 'high',
    rationale: 'Test rationale',
    matchedToolFindingId: toolFinding.id,
    matchedCheckId: toolFinding.checkId,
    matchedToolFindingIds: [toolFinding.id],
    matchedCheckIds: [toolFinding.checkId],
    matchScore: 80,
    evidenceMatchScore: 80,
    urlOverlap: 0,
    matchReasons: ['direct_check_id_match', 'sample_urls_available'],
    missingReasons: options.missingReasons || [],
    partialReason: options.partialReason || null,
    sampleBased: options.status === 'covered_in_sample',
    affectedInSample: 10,
    expectedCheckIds: options.expectedCheckIds || [toolFinding.checkId],
    requiredData: options.requiredData || [],
    requiresExternalData: Boolean(options.requiresExternalData),
    requiresHumanJudgment: Boolean(options.requiresHumanJudgment),
    requiresLlmJudgment: Boolean(options.requiresLlmJudgment),
    manualItem: {
      id,
      title: options.title || 'Example',
      category: options.category || 'Technical SEO',
      priority: options.priority || 'Medium',
      affectedCount: options.affectedCount || null
    },
    toolFinding,
    matchedToolFindings: [toolFinding],
    mapping: { expectedCheckIds: options.expectedCheckIds || [toolFinding.checkId], possibleCheckIds: [], requiredData: options.requiredData || [] }
  };
}
