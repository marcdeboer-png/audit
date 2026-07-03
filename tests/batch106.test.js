import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyManualItemCoverage } from '../src/validation/referenceAudit/coverageClassifier.js';
import { mapReferenceItemToChecks } from '../src/validation/referenceAudit/referenceAuditMapper.js';
import { buildPartialCoverageDiagnostics } from '../src/validation/referenceAudit/partialCoverageDiagnostics.js';
import { buildValidationExportPayload } from '../src/validation/referenceAudit/validationExportService.js';

test('Batch 10.6 evidence matching emits match and missing reasons and can upgrade strong direct evidence', () => {
  const item = referenceItem('ALT texts', 'Images are missing useful alt text at scale.', 'Media SEO', 'Low');
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [
    finding('tech.images_without_alt', 'Media & Performance', 'Content images without alt', {
      priority: 'Low',
      affectedCount: 62,
      sampleUrls: ['https://example.com/pdp/a'],
      finding: 'Content images without alt text were found.',
      recommendation: 'Add descriptive alt text for important content images.'
    })
  ], { run: sampleRun() });

  assert.equal(coverage.coverageStatus, 'covered');
  assert.equal(coverage.upgradeEligible, true);
  assert.ok(coverage.matchReasons.includes('direct_check_id_match'));
  assert.ok(coverage.matchReasons.includes('affected_count_available'));
  assert.ok(coverage.matchReasons.includes('sample_urls_available'));
  assert.ok(Array.isArray(coverage.missingReasons));
});

test('Batch 10.6 composite coverage groups broad structured-data manual items across multiple findings', () => {
  const item = referenceItem('Structured Data', 'Structured data schema coverage and JSON-LD quality.', 'Structured Data', 'Medium');
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [
    finding('tech.schema_types_coverage_summary', 'Structured Data', 'Schema types coverage summary', {
      affectedCount: 24,
      sampleUrls: ['https://example.com/product/a'],
      finding: 'Schema type coverage is incomplete.',
      recommendation: 'Add required schema types on important templates.'
    }),
    finding('tech.json_ld_parse_errors', 'Structured Data', 'JSON-LD parse errors', {
      affectedCount: 2,
      sampleUrls: ['https://example.com/product/b'],
      finding: 'JSON-LD parse errors were found.',
      recommendation: 'Fix invalid JSON-LD before extending schema coverage.'
    })
  ], { run: sampleRun() });

  assert.equal(coverage.coverageStatus, 'covered');
  assert.ok(coverage.compositeCoverage?.enabled);
  assert.ok(coverage.matchReasons.includes('composite_check_family_bundle'));
  assert.ok(coverage.matchedCheckIds.includes('tech.schema_types_coverage_summary'));
  assert.ok(coverage.matchedCheckIds.includes('tech.json_ld_parse_errors'));
});

test('Batch 10.6 full-domain manual scope becomes covered_in_sample instead of fake full coverage', () => {
  const item = {
    ...referenceItem('Crawl budget management', '7,000 URLs show a sitewide template and crawl budget issue.', 'Technical SEO', 'High'),
    affectedCount: 7000
  };
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [
    finding('tech.noindex_pages', 'Technical SEO', 'Crawl budget noindex pages present', {
      priority: 'High',
      affectedCount: 80,
      sampleUrls: ['https://example.com/facet/a'],
      finding: 'Noindex template and crawl budget signals are visible in the sample.',
      recommendation: 'Validate noindex and crawl budget patterns with a full crawl.'
    })
  ], { run: sampleRun() });

  assert.equal(coverage.coverageStatus, 'covered_in_sample');
  assert.equal(coverage.sampleBased, true);
  assert.equal(coverage.partialReason, 'sample_too_small');
  assert.equal(coverage.upgradeEligible, false);
  assert.equal(coverage.sampleUpgradeEligible, true);
});

test('Batch 10.6 human-review manual items stay partial even with technical trust signals', () => {
  const item = referenceItem('E-E-A-T', 'Trust, expert sourcing and YMYL signals need qualitative review.', 'Trust', 'High');
  const mapping = mapReferenceItemToChecks(item);
  const coverage = classifyManualItemCoverage(item, mapping, [
    finding('trust.eeat_signal_summary', 'Trust & Entity', 'E-E-A-T signal summary', {
      priority: 'High',
      affectedCount: 9,
      sampleUrls: ['https://example.com/ratgeber/a'],
      finding: 'Some trust signals are missing in the sample.',
      recommendation: 'Review author, source and entity clarity on sampled URLs.'
    })
  ], { run: sampleRun() });

  assert.equal(coverage.coverageStatus, 'partially_covered');
  assert.equal(coverage.partialReason, 'human_review_needed');
  assert.equal(coverage.upgradeEligible, false);
  assert.ok(coverage.missingReasons.includes('human_review_needed'));
});

test('Batch 10.6 partial diagnostics and exports expose reasons, scores and filters', () => {
  const partial = {
    manualItemId: 'manual-resource-hints',
    coverageStatus: 'partially_covered',
    confidence: 'medium',
    rationale: 'Technical signals exist, but resource evidence is weak.',
    matchedCheckId: 'tech.resource_hints_summary',
    matchedCheckIds: ['tech.resource_hints_summary', 'tech.preconnect_missing'],
    matchScore: 68,
    evidenceMatchScore: 68,
    matchReasons: ['direct_check_id_match', 'same_check_family'],
    missingReasons: ['evidence_too_weak', 'missing_url_overlap'],
    partialReason: 'evidence_too_weak',
    upgradeEligible: false,
    requiredData: ['resource_facts'],
    manualItem: {
      title: 'Resource Hints',
      category: 'Media Performance',
      priority: 'Medium',
      affectedCount: null
    },
    toolFinding: {
      id: 1,
      checkId: 'tech.resource_hints_summary',
      checkName: 'Resource hints summary',
      status: 'Warning',
      priority: 'Medium',
      affectedCount: 4,
      sampleUrls: []
    },
    mapping: {
      expectedCheckIds: ['tech.resource_hints_summary'],
      possibleCheckIds: ['tech.preconnect_missing'],
      requiredData: ['resource_facts']
    }
  };
  const diagnostics = buildPartialCoverageDiagnostics([partial]);
  assert.equal(diagnostics.analyzedItems, 1);
  assert.equal(diagnostics.byReason.evidence_too_weak, 1);
  assert.equal(diagnostics.items[0].needsBetterEvidence, true);
  assert.equal(diagnostics.items[0].possibleUpgradePath, 'improve_evidence_capture');

  const files = buildValidationExportPayload({
    runId: 1,
    generatedAt: '2026-07-04T00:00:00.000Z',
    validationSummary: {
      manualItemCount: 1,
      covered: 0,
      coveredInSample: 0,
      partiallyCovered: 1,
      coveragePercent: 50,
      partialDeepening: { analyzedItems: 1 }
    },
    coverageMatrix: [partial],
    partialCoverageDiagnostics: diagnostics,
    unmatchedToolFindings: [],
    nextCheckBacklog: [],
    checkRoadmap: [],
    scoreCalibrationNotes: []
  });
  assert.ok(files['partial-coverage-diagnostics.json']);
  assert.match(files['partial-coverage-diagnostics.md'], /Resource Hints/);
  assert.match(files['coverage-matrix.csv'], /matchReasons/);
  assert.match(files['validation-report.html'], /Partial Reason/);

  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /covered_in_sample/);
  assert.match(app, /partial:sample_too_small/);
  assert.match(app, /partial-coverage-diagnostics\.md/);
});

function referenceItem(title, description, category, priority) {
  return {
    id: title,
    title,
    description,
    category,
    priority,
    status: 'open'
  };
}

function finding(id, category, name, options = {}) {
  return {
    id: Number(options.rowId || Math.abs(hashCode(id))),
    checkId: id,
    category,
    checkName: name,
    status: options.status || 'Warning',
    priority: options.priority || 'Medium',
    confidence: options.confidence || 'high',
    affectedCount: options.affectedCount || 0,
    finding: options.finding || `${name} finding`,
    details: options.details || `${name} details`,
    recommendation: options.recommendation || `${name} recommendation`,
    sampleUrlsJson: JSON.stringify(options.sampleUrls || []),
    evidenceJson: JSON.stringify(options.evidence || { checked: true })
  };
}

function sampleRun() {
  return {
    processedUrls: 120,
    successfulUrls: 120,
    sourceType: 'crawl'
  };
}

function hashCode(value) {
  return String(value).split('').reduce((hash, char) => ((hash << 5) - hash) + char.charCodeAt(0), 0);
}
