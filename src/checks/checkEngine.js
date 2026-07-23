import { clearRunArtifacts, getRunWithProject, hydrateInternalLinkHttpFacts, insertCheckResults, logRun, persistRunScores } from '../db/repositories.js';
import { COVERAGE_MODEL_VERSION, SCORING_VERSION, computeEvidenceGatedLegacyScores, computeLegacyScores, computeScores, scoreForStatus } from '../utils/scoring.js';
import { techChecks } from './tech/index.js';
import { geoChecks } from './geo/index.js';
import { applyEffectiveValues } from '../reviews/reviewWorkflow.js';
import { runLlmChecks } from '../llm/llmCheckRunner.js';
import { makeResult } from './helpers.js';
import { assertCheckResultScope, assertRunStorageScope, createRunScope, requireRunId, scopeSafeCheckResult } from '../scope/runScope.js';
import { buildCheckProvenance } from '../runtime/provenance.js';
import { applyEvidenceAvailability, createEvidenceAvailabilityContext } from '../coverage/evidenceCoverage.js';

export async function runChecks(db, runId) {
  requireRunId(runId, 'run checks');
  const run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const checks = [
    ...(run.auditType === 'tech' || run.auditType === 'both' ? techChecks() : []),
    ...(run.auditType === 'geo' || run.auditType === 'both' ? geoChecks() : [])
  ];

  const context = {
    db,
    run,
    project: {
      id: run.projectId,
      inputDomain: run.inputDomain,
      finalDomain: run.finalDomain,
      brandName: run.brandName,
      protocolBehaviorJson: run.protocolBehaviorJson,
      wwwBehaviorJson: run.wwwBehaviorJson,
      redirectChainJson: run.redirectChainJson
    }
  };
  const scope = createRunScope(run, context.project);
  hydrateInternalLinkHttpFacts(db, runId);
  const scopeEvidence = assertRunStorageScope(db, scope);
  context.scope = scope;
  context.scopeEvidence = scopeEvidence;

  const preservedResults = collectedResultsForNonLiveRerun(db, run, checks);

  clearRunArtifacts(db, runId);

  const results = [];
  for (const check of checks) {
    if (preservedResults.has(check.id)) {
      const preserved = preservedResults.get(check.id);
      assertCheckResultScope(preserved, scope, check);
      results.push(preserved);
      continue;
    }
    try {
      const result = await check.run(context);
      const normalized = importAwareResult(run, {
        ...result,
        score: result.scoreEligible === false ? null : scoreForStatus(result.status)
      });
      normalized.provenance = buildCheckProvenance({ run, project: context.project, check, result: normalized });
      assertCheckResultScope(normalized, scope, check);
      results.push(normalized);
    } catch (error) {
      logRun(db, runId, 'error', 'Check failed', { checkId: check.id, error: error.message });
      const technicalResult = {
        ...makeResult(check, 'NA', {
          evaluationState: 'technical_error',
          scoreEligible: false,
          priority: check.priority || 'Medium',
          effort: check.effort || 'M',
          finding: `${check.name}: check execution failed.`,
          details: error.message,
          recommendation: 'Review the check execution log and repeat this targeted check after fixing the tooling error.',
          affectedCount: 0,
          sampleUrls: [],
          facts: {},
          evidence: { checkId: check.id, technicalError: error.message, technicalErrorSource: error.code || error.name },
          requirements: {
            requiredFacts: [],
            missingFacts: [],
            canCollectWithTargetedRun: true,
            reason: `Check execution failed: ${error.message}`
          }
        }),
        score: null
      };
      technicalResult.provenance = buildCheckProvenance({ run, project: context.project, check, result: technicalResult });
      results.push(technicalResult);
    }
  }

  try {
    const llmResults = await runLlmChecks(context);
    for (const result of llmResults) {
      const normalized = {
        ...result,
        evaluationState: result.evaluationState || (result.status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(result.status) ? 'fail' : 'not_executed'),
        scoreEligible: result.scoreEligible ?? ['OK', 'Warning', 'Error'].includes(result.status),
        score: result.scoreEligible === false ? null : scoreForStatus(result.status)
      };
      const check = { id: normalized.id, version: normalized.promptVersion || '1' };
      normalized.provenance = buildCheckProvenance({ run, project: context.project, check, result: normalized });
      assertCheckResultScope(normalized, scope, check);
      results.push(normalized);
    }
  } catch (error) {
    logRun(db, runId, 'error', 'LLM checks failed without aborting audit', { error: error.message });
  }

  const availabilityContext = createEvidenceAvailabilityContext(db, run);
  const annotatedResults = results.map((result) => applyEvidenceAvailability(result, availabilityContext));
  insertCheckResults(db, runId, annotatedResults);
  const scores = computeScores(annotatedResults);
  persistRunScores(db, runId, scores);
  logRun(db, runId, 'info', 'Checks completed', { checks: annotatedResults.length, scores });
  return { results: annotatedResults, scores };
}

function collectedResultsForNonLiveRerun(db, run, checks) {
  if (run.status === 'running') return new Map();
  const eligibleIds = checks.filter((check) => check.preserveCollectedEvidenceOnRerun).map((check) => check.id);
  if (!eligibleIds.length) return new Map();
  const placeholders = eligibleIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM check_results
    WHERE runId = ?
      AND checkId IN (${placeholders})
      AND evaluationState IN ('pass', 'fail', 'technical_error')
  `).all(run.id, ...eligibleIds);
  return new Map(rows.map((row) => [row.checkId, storedCollectedResult(row)]));
}

function storedCollectedResult(row) {
  return {
    id: row.checkId,
    category: row.category,
    name: row.checkName,
    auditType: row.checkId.startsWith('geo.') || row.checkId.startsWith('trust.') || row.checkId.startsWith('llm.') ? 'geo' : 'tech',
    status: row.status,
    priority: row.priority,
    effort: row.effort,
    score: row.score,
    finding: row.finding,
    details: row.details,
    recommendation: row.recommendation,
    affectedCount: row.affectedCount,
    sampleUrls: safeParse(row.sampleUrlsJson, []),
    evidence: safeParse(row.evidenceJson, {}),
    facts: safeParse(row.factsJson, {}),
    assessment: safeParse(row.assessmentJson, {}),
    recommendationMeta: safeParse(row.recommendationMetaJson, {}),
    requirements: safeParse(row.requirementsJson, {}),
    evaluationState: row.evaluationState,
    scoreEligible: Boolean(row.scoreEligible),
    scoreExclusionReason: row.scoreExclusionReason,
    scoreDeduplicationKey: row.scoreDeduplicationKey,
    reportGroupingKey: row.reportGroupingKey,
    findingType: row.findingType,
    confidence: row.confidence,
    reviewRecommended: Boolean(row.reviewRecommended),
    maturityImpact: row.maturityImpact,
    dataBasis: row.dataBasis,
    evidenceLevel: row.evidenceLevel,
    reviewReason: row.reviewReason,
    automationCoverage: row.automationCoverage,
    interpretation: row.interpretation,
    limitations: row.limitations,
    relatedCheckIds: safeParse(row.relatedCheckIdsJson, []),
    checkVersion: row.checkVersion,
    provenance: safeParse(row.provenanceJson, {}),
    rootCauseKey: row.rootCauseKey || row.scoreDeduplicationKey,
    rootCauseFamily: row.rootCauseFamily,
    scopeType: row.scopeType,
    occurrenceCount: row.occurrenceCount,
    affectedUrlCount: row.affectedUrlCount,
    displayedSampleCount: row.displayedSampleCount,
    deduplicationConfidence: row.deduplicationConfidence,
    deduplicationReason: row.deduplicationReason,
    evidenceClass: row.evidenceClass,
    executionStatus: row.executionStatus,
    evidenceStatus: row.evidenceStatus,
    evaluationStatus: row.evaluationStatus,
    coverageStatus: row.coverageStatus,
    coverageUnitKey: row.coverageUnitKey,
    coverageWeight: row.coverageWeight,
    coverageReason: row.coverageReason,
    availabilitySemanticsVersion: row.availabilitySemanticsVersion
  };
}

const LIVE_DATA_CHECK_IDS = new Set([
  'tech.https_reachable',
  'tech.http_to_https_redirect',
  'tech.www_non_www_consistency',
  'tech.robots_txt_present',
  'tech.sitemap_present',
  'tech.sitemap_in_robots',
  'geo.llms_txt_present',
  'geo.llms_txt_http_status',
  'geo.llms_full_txt_present',
  'geo.robots_blocks_txt_files',
  'geo.ai_bots_policy_summary',
  'geo.robots_mentions_applebot',
  'geo.robots_mentions_bytespider',
  'geo.robots_mentions_ccbot',
  'geo.robots_mentions_chatgpt_user',
  'geo.robots_mentions_claude_web',
  'geo.robots_mentions_claudebot',
  'geo.robots_mentions_google_extended',
  'geo.robots_mentions_gptbot',
  'geo.robots_mentions_oai_searchbot',
  'geo.robots_mentions_perplexitybot',
  'geo.markdown_twin_homepage'
]);

function importAwareResult(run, result) {
  if (run.sourceType !== 'screaming_frog_import') return result;
  if (!LIVE_DATA_CHECK_IDS.has(result.id)) return result;
  return {
    ...result,
    status: 'NA',
    score: null,
    evaluationState: 'not_executed',
    scoreEligible: false,
    scoreExclusionReason: 'Live HTTP facts are unavailable in an import-only run.',
    affectedCount: 0,
    finding: `${result.name}: not evaluated for Screaming Frog import runs.`,
    details: 'This check requires live HTTP/domain asset data that was not part of the imported Screaming Frog CSV facts.',
    recommendation: result.recommendation || 'Run a live crawl or hybrid audit when this signal is required.',
    sampleUrls: [],
    evidence: {
      sourceType: run.sourceType,
      skippedReason: 'requires_live_crawl_data'
    },
    requirements: {
      requiredFacts: ['liveHttpResponse'],
      optionalFacts: [],
      missingFacts: ['liveHttpResponse'],
      minimumCoverage: 1,
      canCollectWithTargetedRun: true,
      reason: 'Run a live or hybrid audit to collect this fact.'
    }
  };
}

export function loadResultsWithScores(db, runId) {
  requireRunId(runId, 'load check results');
  const run = getRunWithProject(db, runId);
  const readScope = run ? createRunScope(run, {
    id: run.projectId,
    inputDomain: run.inputDomain,
    finalDomain: run.finalDomain
  }) : null;
  const rows = db.prepare(`
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
    WHERE cr.runId = ?
    ORDER BY
      CASE cr.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      CASE cr.status WHEN 'Error' THEN 1 WHEN 'Warning' THEN 2 WHEN 'OK' THEN 3 ELSE 4 END,
      cr.checkId ASC
  `).all(runId).map((row) => ({
    ...row,
    auditType: row.checkId.startsWith('geo.') || row.checkId.startsWith('trust.') || row.checkId.startsWith('llm.') ? 'geo' : 'tech',
    sampleUrls: safeParse(row.sampleUrlsJson, []),
    evidence: safeParse(row.evidenceJson, {}),
    facts: safeParse(row.factsJson, {}),
    assessment: safeParse(row.assessmentJson, {}),
    recommendationMeta: safeParse(row.recommendationMetaJson, {}),
    requirements: safeParse(row.requirementsJson, {}),
    provenance: safeParse(row.provenanceJson, {}),
    scoreEligible: Boolean(row.scoreEligible),
    relatedCheckIds: safeParse(row.relatedCheckIdsJson, []),
    rootCauseMemberships: safeParse(row.rootCauseMembershipsJson, [])
  })).map(applyEffectiveValues).map((row) => readScope
    ? scopeSafeCheckResult(row, readScope, { id: row.checkId })
    : row);

  return { scores: scoresForStoredRun(run, rows), results: rows };
}

export function scoresForStoredRun(run, rows) {
  if (!run?.scoringVersion) {
    return rows.some((row) => row.evaluationState)
      ? computeEvidenceGatedLegacyScores(rows)
      : computeLegacyScores(rows);
  }
  const stored = safeParse(run.scoreBreakdownJson, null);
  if (stored && stored.scoringVersion === run.scoringVersion) return stored;
  if (run.scoringVersion === SCORING_VERSION && run.coverageModelVersion === COVERAGE_MODEL_VERSION) return computeScores(rows);
  const fallback = rows.some((row) => row.evaluationState)
    ? computeEvidenceGatedLegacyScores(rows)
    : computeLegacyScores(rows);
  return {
    ...fallback,
    scoreStatus: 'historical_unknown',
    scoringVersion: run.scoringVersion,
    breakdown: {
      ...fallback.breakdown,
      scoringModel: run.scoringVersion,
      unsupportedHistoricalScoringVersion: run.scoringVersion !== SCORING_VERSION,
      unsupportedHistoricalCoverageVersion: run.coverageModelVersion !== COVERAGE_MODEL_VERSION,
      historicalCoverageModelVersion: run.coverageModelVersion || null
    }
  };
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
