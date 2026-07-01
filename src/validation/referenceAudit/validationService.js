import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadResultsWithScores } from '../../checks/checkEngine.js';
import { getRunWithProject } from '../../db/repositories.js';
import { buildBenchmarkSummary, storeBenchmarkSummary } from '../../analysis/benchmarkSummary.js';
import { buildStorageRealityCheck } from '../../analysis/storageRealityCheck.js';
import { parseReferenceAuditFile, parseReferenceAuditFiles, parseReferenceAuditInput, parseReferenceAuditInputs } from './referenceAuditParser.js';
import { mapReferenceItemToChecks } from './referenceAuditMapper.js';
import { classifyManualItemCoverage, classifyToolExtraFindings } from './coverageClassifier.js';
import { buildGapBacklog, gapAnalysisFromCoverage } from './gapClassifier.js';
import { writeValidationExports } from './validationExportService.js';

export async function validateRunAgainstReference(db, input = {}) {
  const runId = Number(input.runId);
  if (!Number.isFinite(runId)) throw new Error('runId is required.');
  const run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);

  const referenceAudit = loadReferenceAudit(input);
  const { results: toolFindings } = loadResultsWithScores(db, runId);
  const coverageMatrix = [];
  const matchedToolFindingIds = new Set();
  const matchedItems = [];

  for (const item of referenceAudit.items) {
    const mapping = mapReferenceItemToChecks(item, input.mappingOptions || {});
    const coverage = classifyManualItemCoverage(item, mapping, toolFindings, { run });
    coverageMatrix.push(compactCoverageRow(coverage));
    if (coverage.matchedToolFindingId) {
      matchedToolFindingIds.add(Number(coverage.matchedToolFindingId));
      matchedItems.push(compactCoverageRow(coverage));
    }
  }

  const toolExtras = classifyToolExtraFindings(toolFindings, matchedToolFindingIds, coverageMatrix);
  const nextCheckBacklog = buildGapBacklog(coverageMatrix);
  const gapAnalysis = gapAnalysisFromCoverage(coverageMatrix, toolExtras);
  const benchmarkSummary = storeBenchmarkSummary(db, runId) || buildBenchmarkSummary(db, runId);
  const storageRealityCheck = benchmarkSummary?.storageRealityCheck || buildStorageRealityCheck(db, runId);
  const falseNegativeCandidates = coverageMatrix.filter((row) => ['false_negative_candidate', 'not_covered'].includes(row.coverageStatus));
  const falsePositiveCandidates = [
    ...coverageMatrix.filter((row) => row.coverageStatus === 'false_positive_candidate'),
    ...toolExtras.filter((row) => ['false_positive_candidate', 'needs_review'].includes(row.extraClassification))
  ];
  const mappingConfidenceSummary = buildMappingConfidenceSummary(coverageMatrix);
  const scoreCalibrationNotes = buildScoreCalibrationNotes(coverageMatrix, toolExtras, gapAnalysis);
  const checkRoadmap = buildCheckRoadmap(nextCheckBacklog, toolExtras);
  const validationSummary = buildValidationSummary({
    run,
    referenceAudit,
    coverageMatrix,
    toolExtras,
    gapAnalysis,
    falsePositiveCandidates
  });
  const executiveValidationSummary = buildExecutiveValidationSummary(validationSummary, {
    falseNegativeCandidates,
    falsePositiveCandidates,
    nextCheckBacklog,
    storageRealityCheck
  });
  const report = {
    validationVersion: 2,
    generatedAt: new Date().toISOString(),
    runId,
    run: summarizeRun(run),
    referenceAudit: {
      filename: referenceAudit.filename,
      format: referenceAudit.format,
      itemCount: referenceAudit.itemCount,
      warnings: referenceAudit.warnings,
      parser: referenceAudit.parser,
      importSummary: referenceAudit.importSummary,
      ignoredRows: referenceAudit.ignoredRows
    },
    validationSummary,
    referenceImportSummary: referenceAudit.importSummary,
    mappingConfidenceSummary,
    coverageMatrix,
    manualItems: referenceAudit.items,
    toolFindings: toolFindings.map(compactToolFinding),
    matchedItems,
    unmatchedManualItems: coverageMatrix.filter((row) => !['covered', 'partially_covered'].includes(row.coverageStatus)),
    unmatchedToolFindings: toolExtras,
    falseNegativeCandidates,
    falsePositiveCandidates,
    gapAnalysis,
    recommendationsForTool: recommendationsForTool(gapAnalysis, nextCheckBacklog, toolExtras),
    nextCheckBacklog,
    checkRoadmap,
    scoreCalibrationNotes,
    executiveValidationSummary,
    chefDemoSummary: buildChefDemoSummary(validationSummary, toolExtras, falseNegativeCandidates),
    benchmarkSummary,
    storageRealityCheck
  };
  const outputDir = input.outDir || path.join(process.cwd(), 'reports', `validation-run-${runId}`);
  const exports = writeValidationExports(report, outputDir);
  const validationId = saveValidationReport(db, report, exports);
  return { validationId, ...report, exports };
}

export function getLatestValidationReport(db, runId) {
  const row = db.prepare(`
    SELECT *
    FROM validation_reports
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(runId);
  return row ? hydrateValidationRow(row) : null;
}

export function getValidationReport(db, validationId) {
  const row = db.prepare('SELECT * FROM validation_reports WHERE id = ?').get(validationId);
  return row ? hydrateValidationRow(row) : null;
}

export function saveValidationReport(db, report, exports) {
  const reference = report.referenceAudit || {};
  const result = db.prepare(`
    INSERT INTO validation_reports (
      runId, referenceFilename, referenceFormat, sourceHash, outputDir,
      summaryJson, reportJson, benchmarkSummaryJson
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.runId,
    reference.filename || null,
    reference.format || null,
    hashReportSource(report),
    exports.outputDir || null,
    JSON.stringify(report.validationSummary || {}),
    JSON.stringify(report),
    JSON.stringify(report.benchmarkSummary || {})
  );
  return result.lastInsertRowid;
}

function loadReferenceAudit(input) {
  if (input.referencePaths?.length) {
    return parseReferenceAuditFiles(input.referencePaths, {
      format: input.format,
      sourceSheet: input.sourceSheet
    });
  }
  if (Array.isArray(input.referenceFiles) && input.referenceFiles.length) {
    return parseReferenceAuditInputs(input.referenceFiles.map((file) => ({
      filename: file.filename || file.name || 'reference-audit.csv',
      content: file.content,
      format: file.format || input.format,
      sourceFile: file.filename || file.name || null,
      sourceSheet: file.sourceSheet || input.sourceSheet
    })));
  }
  if (input.referencePath) {
    return parseReferenceAuditFile(input.referencePath, {
      format: input.format,
      sourceSheet: input.sourceSheet
    });
  }
  if (input.referenceFile?.content !== undefined) {
    return parseReferenceAuditInput({
      filename: input.referenceFile.filename || input.referenceFile.name || 'reference-audit.csv',
      content: input.referenceFile.content,
      format: input.referenceFile.format || input.format,
      sourceFile: input.referenceFile.filename || input.referenceFile.name || null,
      sourceSheet: input.sourceSheet
    });
  }
  if (input.content !== undefined) {
    return parseReferenceAuditInput({
      filename: input.filename || 'reference-audit.csv',
      content: input.content,
      format: input.format,
      sourceFile: input.filename || null,
      sourceSheet: input.sourceSheet
    });
  }
  throw new Error('referencePath or referenceFile.content is required.');
}

function compactCoverageRow(row) {
  return {
    manualItemId: row.manualItemId,
    coverageStatus: row.coverageStatus,
    confidence: row.confidence,
    rationale: row.rationale,
    matchedToolFindingId: row.matchedToolFindingId,
    matchedCheckId: row.matchedCheckId,
    matchScore: row.matchScore,
    urlOverlap: row.urlOverlap,
    expectedCheckIds: row.expectedCheckIds,
    requiredData: row.requiredData,
    requiresExternalData: row.requiresExternalData,
    requiresHumanJudgment: row.requiresHumanJudgment,
    requiresLlmJudgment: row.requiresLlmJudgment,
    manualItem: row.manualItem,
    toolFinding: row.toolFinding ? compactToolFinding(row.toolFinding) : null,
    mapping: row.mapping
  };
}

function compactToolFinding(row) {
  return {
    id: row.id,
    checkId: row.checkId,
    category: row.category,
    checkName: row.checkName,
    status: row.effectiveStatus || row.status,
    priority: row.effectivePriority || row.priority,
    findingType: row.normalizedFindingType || row.findingType,
    confidence: row.confidence,
    affectedCount: row.affectedCount || 0,
    finding: row.effectiveFinding || row.finding,
    recommendation: row.effectiveRecommendation || row.recommendation,
    sampleUrls: safeJson(row.sampleUrlsJson, row.sampleUrls || []),
    reportSection: row.reportSection || null
  };
}

function buildValidationSummary({ run, referenceAudit, coverageMatrix, toolExtras, gapAnalysis, falsePositiveCandidates = [] }) {
  const counts = countCoverage(coverageMatrix);
  const manualItemCount = referenceAudit.items.length;
  const weightedCoverage = ((counts.covered || 0) + (counts.partially_covered || 0) * 0.5) / Math.max(1, manualItemCount);
  return {
    runId: run.id,
    domain: run.finalDomain || run.inputDomain,
    sourceType: run.sourceType || 'crawl',
    processedUrls: run.processedUrls || 0,
    dataBasisLabel: dataBasisLabel(run),
    referenceFilename: referenceAudit.filename || null,
    manualItemCount,
    covered: counts.covered || 0,
    partiallyCovered: counts.partially_covered || 0,
    notCovered: counts.not_covered || 0,
    falseNegativeCandidates: counts.false_negative_candidate || 0,
    needsExternalData: counts.needs_external_data || 0,
    needsLargerCrawl: counts.needs_larger_crawl || 0,
    needsHumanReview: counts.needs_human_review || 0,
    needsLlmReview: counts.needs_llm_review || 0,
    toolExtras: toolExtras.length,
    falsePositiveCandidates: falsePositiveCandidates.length,
    coveragePercent: Number((weightedCoverage * 100).toFixed(1)),
    coverageByCategory: coverageBreakdown(coverageMatrix, (row) => row.manualItem?.category || 'uncategorized'),
    coverageByPriority: coverageBreakdown(coverageMatrix, (row) => row.manualItem?.priority || 'unknown'),
    coverageByDataSource: coverageBreakdownByDataSource(coverageMatrix),
    gapAnalysis
  };
}

function buildMappingConfidenceSummary(coverageMatrix = []) {
  const byConfidence = {};
  const byRule = {};
  const lowConfidenceItems = [];
  for (const row of coverageMatrix) {
    const confidence = row.mapping?.mappingConfidence || 'unknown';
    byConfidence[confidence] = (byConfidence[confidence] || 0) + 1;
    for (const rule of row.mapping?.matchedRules || []) {
      byRule[rule] = (byRule[rule] || 0) + 1;
    }
    if (confidence === 'low') {
      lowConfidenceItems.push({
        manualItemId: row.manualItemId,
        title: row.manualItem?.title || row.manualItemId,
        category: row.manualItem?.category || row.mapping?.category || 'uncategorized',
        coverageStatus: row.coverageStatus
      });
    }
  }
  return {
    byConfidence,
    byRule,
    lowConfidenceItems,
    notes: lowConfidenceItems.length
      ? ['Low-confidence mappings should be reviewed before changing scoring.']
      : ['Mapping confidence is sufficient for this comparison pass.']
  };
}

function buildScoreCalibrationNotes(coverageMatrix = [], toolExtras = [], gapAnalysis = {}) {
  const notes = [...(gapAnalysis.scoreCalibrationNotes || [])];
  const highManualGaps = coverageMatrix.filter((row) =>
    ['false_negative_candidate', 'not_covered'].includes(row.coverageStatus) && row.manualItem?.priority === 'High'
  );
  if (highManualGaps.length) {
    notes.push(`${highManualGaps.length} high-priority manual gap(s) must be addressed before raising maturity score confidence.`);
  }
  const noisyExtras = toolExtras.filter((row) => ['false_positive_candidate', 'needs_review'].includes(row.extraClassification));
  if (noisyExtras.length) {
    notes.push(`${noisyExtras.length} tool extra finding(s) need review before they should influence management scoring.`);
  }
  return [...new Set(notes)];
}

function buildCheckRoadmap(backlog = [], toolExtras = []) {
  const backlogRoadmap = backlog.map((item) => ({
    roadmapId: item.gapId,
    title: item.title,
    category: item.category,
    roadmapCategory: roadmapCategoryForBacklog(item),
    source: 'manual_gap',
    priority: item.priority,
    effort: item.estimatedEffort,
    expectedImpact: item.expectedImpact,
    requiredData: item.requiredData || [],
    suggestedImplementation: item.suggestedImplementation,
    possibleCheckId: item.possibleCheckId || null
  }));
  const reviewExtras = toolExtras
    .filter((row) => ['likely_relevant', 'needs_review', 'false_positive_candidate'].includes(row.extraClassification))
    .slice(0, 25)
    .map((row) => ({
      roadmapId: `extra-${row.toolFindingId}`,
      title: row.title || row.checkId,
      category: row.category || 'uncategorized',
      roadmapCategory: row.extraClassification === 'likely_relevant' ? 'Report/Demo Verbesserungen' : 'Quick Wins',
      source: 'tool_extra_review',
      priority: row.priority || 'Medium',
      effort: 'S',
      expectedImpact: row.extraClassification === 'likely_relevant' ? 'medium' : 'low',
      requiredData: [],
      suggestedImplementation: row.extraClassification === 'false_positive_candidate'
        ? 'Review finding threshold/evidence and mark as false positive if unsupported.'
        : 'Review extra finding as potential differentiator versus the manual audit.',
      possibleCheckId: row.checkId
    }));
  return [...backlogRoadmap, ...reviewExtras].sort(roadmapSort);
}

function roadmapCategoryForBacklog(item = {}) {
  if (item.gapType === 'needs_larger_crawl') return 'Storage/Scale Optimierungen';
  if (item.gapType === 'needs_external_data') return 'Data Source Erweiterungen';
  if (['needs_llm_review', 'needs_human_review'].includes(item.gapType)) return 'LLM/Human Review Checks';
  if (item.estimatedEffort === 'S' && item.expectedImpact !== 'low') return 'Quick Wins';
  if (item.expectedImpact === 'high') return 'High Impact Engineering';
  return 'Report/Demo Verbesserungen';
}

function roadmapSort(a, b) {
  const priority = { High: 0, Medium: 1, Low: 2 };
  const impact = { high: 0, medium: 1, low: 2 };
  const effort = { S: 0, M: 1, L: 2, XL: 3 };
  return (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9)
    || (impact[a.expectedImpact] ?? 9) - (impact[b.expectedImpact] ?? 9)
    || (effort[a.effort] ?? 9) - (effort[b.effort] ?? 9)
    || String(a.title).localeCompare(String(b.title));
}

function buildExecutiveValidationSummary(summary, context = {}) {
  const processedUrls = Number(context.storageRealityCheck?.processedUrls || 0);
  const sampleNote = processedUrls && processedUrls <= 1000
    ? `This is sample coverage based on ${processedUrls} processed URLs, not final full-domain enterprise coverage.`
    : 'This validation is based on the selected audit run scope.';
  const mostImportantGaps = context.nextCheckBacklog
    ?.filter((item) => item.priority === 'High')
    .slice(0, 8)
    .map((item) => ({
      title: item.title,
      gapType: item.gapType,
      category: item.category,
      suggestedImplementation: item.suggestedImplementation
    })) || [];
  return {
    answer: summary.manualItemCount
      ? `The tool currently covers ${summary.coveragePercent}% weighted reference coverage for this validation run. ${sampleNote}`
      : 'No reference audit items were imported; real original-audit coverage is not measurable yet.',
    sampleNote,
    coveragePercent: summary.coveragePercent,
    manualItemCount: summary.manualItemCount,
    fullOrPartialCoverage: (summary.covered || 0) + (summary.partiallyCovered || 0),
    gapsToClose: (summary.notCovered || 0) + (summary.falseNegativeCandidates || 0),
    externalOrReviewDependent: (summary.needsExternalData || 0) + (summary.needsLargerCrawl || 0) + (summary.needsHumanReview || 0) + (summary.needsLlmReview || 0),
    toolExtras: summary.toolExtras || 0,
    falsePositiveCandidates: context.falsePositiveCandidates?.length || 0,
    storageRiskLevel: context.storageRealityCheck?.riskLevel || null,
    mostImportantGaps,
    managementMessage: summary.manualItemCount
      ? 'Use this report to separate already automated audit coverage from implementation gaps, external-data gaps and review-only topics.'
      : 'Place the original manual audit export in the reference-audits folder and rerun validation before using coverage figures in a management demo.'
  };
}

function dataBasisLabel(run = {}) {
  const sourceType = run.sourceType || 'crawl';
  const processedUrls = Number(run.processedUrls || run.successfulUrls || 0);
  if (sourceType === 'screaming_frog_import') return `Screaming Frog import (${processedUrls} URL facts)`;
  if (processedUrls && processedUrls <= 1000) return `Sample crawl (${processedUrls} processed URLs)`;
  if (processedUrls) return `Crawl/import run (${processedUrls} processed URLs)`;
  return sourceType;
}

function buildChefDemoSummary(summary, toolExtras = [], falseNegativeCandidates = []) {
  const topExtras = toolExtras
    .filter((row) => row.extraClassification === 'likely_relevant')
    .slice(0, 10)
    .map((row) => ({
      checkId: row.checkId,
      title: row.title,
      affectedCount: row.affectedCount,
      priority: row.priority
    }));
  return {
    headline: summary.manualItemCount
      ? `Automated audit coverage: ${summary.coveragePercent}% weighted, plus ${summary.toolExtras || 0} tool-only findings.`
      : 'Original manual audit missing: validation pipeline is ready, but real Fressnapf coverage cannot be claimed yet.',
    talkingPoints: [
      `${summary.covered || 0} manual point(s) fully covered, ${summary.partiallyCovered || 0} partially covered.`,
      `${summary.needsExternalData || 0} point(s) need external data; ${summary.needsLargerCrawl || 0} need a larger crawl; ${summary.needsHumanReview || 0} need human review; ${summary.needsLlmReview || 0} need optional LLM review.`,
      `${falseNegativeCandidates.length} likely false-negative/manual-gap candidate(s) should drive the next implementation batch.`,
      `${topExtras.length} high-signal tool extra(s) can demonstrate value beyond the manual audit after review.`
    ],
    topToolExtras: topExtras
  };
}

function countCoverage(rows) {
  return rows.reduce((acc, row) => {
    acc[row.coverageStatus] = (acc[row.coverageStatus] || 0) + 1;
    return acc;
  }, {});
}

function coverageBreakdown(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row);
    groups[key] = groups[key] || { total: 0, covered: 0, partiallyCovered: 0, notCovered: 0 };
    groups[key].total += 1;
    if (row.coverageStatus === 'covered') groups[key].covered += 1;
    else if (row.coverageStatus === 'partially_covered') groups[key].partiallyCovered += 1;
    else if (!['needs_external_data', 'needs_larger_crawl', 'needs_human_review', 'needs_llm_review', 'not_applicable'].includes(row.coverageStatus)) groups[key].notCovered += 1;
  }
  return groups;
}

function coverageBreakdownByDataSource(rows) {
  const groups = {};
  for (const row of rows) {
    const dataSources = row.requiredData?.length ? row.requiredData : ['url_facts'];
    for (const source of dataSources) {
      groups[source] = groups[source] || { total: 0, covered: 0, partiallyCovered: 0, gaps: 0 };
      groups[source].total += 1;
      if (row.coverageStatus === 'covered') groups[source].covered += 1;
      else if (row.coverageStatus === 'partially_covered') groups[source].partiallyCovered += 1;
      else groups[source].gaps += 1;
    }
  }
  return groups;
}

function recommendationsForTool(gapAnalysis, backlog, toolExtras) {
  const recommendations = [];
  if (gapAnalysis.needsExternalData) recommendations.push('Prioritize import/mapping of external data sources before changing scoring.');
  if (gapAnalysis.falseNegativeCandidates) recommendations.push('Review false-negative candidates and add targeted checks or improve evidence matching.');
  if (gapAnalysis.needsLlmReview) recommendations.push('Use optional LLM sampling only for qualitative checks; keep reviewRecommended enabled.');
  if (toolExtras.length) recommendations.push('Review tool extra findings separately to prove additional value over the manual audit.');
  if (backlog.length) recommendations.push(`Convert ${backlog.length} validation gap(s) into the next implementation backlog.`);
  if (!recommendations.length) recommendations.push('Validation did not surface major tool gaps; keep collecting reference audits for calibration.');
  return recommendations;
}

function summarizeRun(run) {
  return {
    id: run.id,
    domain: run.finalDomain || run.inputDomain,
    sourceType: run.sourceType || 'crawl',
    storageProfile: run.storageProfile || 'standard',
    crawlScaleMode: run.crawlScaleMode || null,
    processedUrls: run.processedUrls || 0,
    successfulUrls: run.successfulUrls || 0,
    status: run.status
  };
}

function hashReportSource(report) {
  const seed = JSON.stringify({
    runId: report.runId,
    reference: report.referenceAudit,
    manualItems: report.manualItems?.map((item) => item.id)
  });
  return crypto.createHash('sha1').update(seed).digest('hex');
}

function hydrateValidationRow(row) {
  return {
    ...row,
    summary: safeJson(row.summaryJson, {}),
    report: safeJson(row.reportJson, {}),
    benchmarkSummary: safeJson(row.benchmarkSummaryJson, {})
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
