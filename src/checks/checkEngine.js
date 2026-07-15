import { clearRunArtifacts, getRunWithProject, insertCheckResults, logRun } from '../db/repositories.js';
import { computeScores, scoreForStatus } from '../utils/scoring.js';
import { techChecks } from './tech/index.js';
import { geoChecks } from './geo/index.js';
import { applyEffectiveValues } from '../reviews/reviewWorkflow.js';
import { runLlmChecks } from '../llm/llmCheckRunner.js';
import { makeResult } from './helpers.js';

export async function runChecks(db, runId) {
  const run = getRunWithProject(db, runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const checks = [
    ...(run.auditType === 'tech' || run.auditType === 'both' ? techChecks() : []),
    ...(run.auditType === 'geo' || run.auditType === 'both' ? geoChecks() : [])
  ];

  clearRunArtifacts(db, runId);

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

  const results = [];
  for (const check of checks) {
    try {
      const result = await check.run(context);
      results.push(importAwareResult(run, {
        ...result,
        score: result.scoreEligible === false ? null : scoreForStatus(result.status)
      }));
    } catch (error) {
      logRun(db, runId, 'error', 'Check failed', { checkId: check.id, error: error.message });
      results.push({
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
          evidence: { checkId: check.id, technicalError: error.message },
          requirements: {
            requiredFacts: [],
            missingFacts: [],
            canCollectWithTargetedRun: true,
            reason: `Check execution failed: ${error.message}`
          }
        }),
        score: null
      });
    }
  }

  try {
    const llmResults = await runLlmChecks(context);
    results.push(...llmResults.map((result) => ({
      ...result,
      evaluationState: result.evaluationState || (result.status === 'OK' ? 'pass' : ['Warning', 'Error'].includes(result.status) ? 'fail' : 'not_executed'),
      scoreEligible: result.scoreEligible ?? ['OK', 'Warning', 'Error'].includes(result.status),
      score: result.scoreEligible === false ? null : scoreForStatus(result.status)
    })));
  } catch (error) {
    logRun(db, runId, 'error', 'LLM checks failed without aborting audit', { error: error.message });
  }

  insertCheckResults(db, runId, results);
  const scores = computeScores(results);
  logRun(db, runId, 'info', 'Checks completed', { checks: results.length, scores });
  return { results, scores };
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
    LEFT JOIN finding_reviews fr ON fr.checkResultId = cr.id
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
    scoreEligible: Boolean(row.scoreEligible),
    relatedCheckIds: safeParse(row.relatedCheckIdsJson, [])
  })).map(applyEffectiveValues);

  return {
    scores: computeScores(rows),
    results: rows
  };
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
