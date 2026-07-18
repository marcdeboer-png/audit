export const EVALUATION_STATES = Object.freeze([
  'pass',
  'fail',
  'not_applicable',
  'insufficient_evidence',
  'not_executed',
  'technical_error'
]);

const EVALUATION_STATE_SET = new Set(EVALUATION_STATES);

export function isObservedFact(facts, key) {
  return Boolean(
    facts &&
    typeof facts === 'object' &&
    Object.prototype.hasOwnProperty.call(facts, key) &&
    facts[key] !== undefined &&
    facts[key] !== null
  );
}

export function evaluateDataAvailability({
  facts = {},
  requiredFacts = [],
  optionalFacts = [],
  minimumCoverage = 1,
  applicable = true,
  executed = true,
  technicalError = null,
  canCollectWithTargetedRun = false,
  measurements = null,
  minimumMeasurements = 0,
  measuredAt = null,
  maxAgeMs = null,
  retries = null,
  minimumSuccessfulRetries = 0
} = {}) {
  const required = [...new Set(requiredFacts.map(String))];
  const optional = [...new Set(optionalFacts.map(String))];
  const observedRequired = required.filter((key) => isObservedFact(facts, key));
  const missingFacts = required.filter((key) => !isObservedFact(facts, key));
  const coverage = required.length ? observedRequired.length / required.length : 1;
  const normalizedMinimum = Math.max(0, Math.min(1, Number(minimumCoverage ?? 1)));
  const measurementCount = Array.isArray(measurements)
    ? measurements.filter((value) => value !== undefined && value !== null).length
    : Number.isFinite(Number(measurements)) ? Number(measurements) : null;
  const requiredMeasurementCount = Math.max(0, Number(minimumMeasurements || 0));
  const successfulRetries = Array.isArray(retries)
    ? retries.filter((retry) => retry?.success === true).length
    : Number.isFinite(Number(retries)) ? Number(retries) : null;
  const stale = maxAgeMs !== null && measuredAt
    ? Date.now() - new Date(measuredAt).getTime() > Number(maxAgeMs)
    : false;

  let evaluationState = 'pass';
  let reason = 'Required facts are available.';
  if (technicalError) {
    evaluationState = 'technical_error';
    reason = `Fact collection failed: ${String(technicalError)}`;
  } else if (!executed) {
    evaluationState = 'not_executed';
    reason = 'The required extractor or measurement was not executed.';
  } else if (!applicable) {
    evaluationState = 'not_applicable';
    reason = 'The check is not applicable to the classified page or run scope.';
  } else if (missingFacts.length || coverage < normalizedMinimum ||
    (requiredMeasurementCount > 0 && (measurementCount === null || measurementCount < requiredMeasurementCount)) ||
    (minimumSuccessfulRetries > 0 && (successfulRetries === null || successfulRetries < minimumSuccessfulRetries)) ||
    stale) {
    evaluationState = 'insufficient_evidence';
    reason = stale
      ? 'The available measurement is older than the allowed age.'
      : `Required fact coverage is ${formatCoverage(coverage)}; missing: ${missingFacts.join(', ') || 'coverage or measurement threshold'}.`;
  }

  return {
    evaluationState,
    scoreEligible: evaluationState === 'pass' || evaluationState === 'fail',
    requiredFacts: required,
    optionalFacts: optional,
    observedRequiredFacts: observedRequired,
    missingFacts,
    minimumCoverage: normalizedMinimum,
    coverage,
    measurementCount,
    minimumMeasurements: requiredMeasurementCount,
    measuredAt,
    maxAgeMs,
    stale,
    successfulRetries,
    minimumSuccessfulRetries,
    canCollectWithTargetedRun: Boolean(canCollectWithTargetedRun),
    reason
  };
}

export function normalizeEvaluationState(value, legacyStatus = 'NA') {
  if (EVALUATION_STATE_SET.has(value)) return value;
  if (legacyStatus === 'OK') return 'pass';
  if (legacyStatus === 'Warning' || legacyStatus === 'Error') return 'fail';
  return 'insufficient_evidence';
}

export function statusForEvaluationState(evaluationState, requestedStatus = 'NA') {
  if (evaluationState === 'pass') return 'OK';
  if (evaluationState === 'fail') return requestedStatus === 'Error' ? 'Error' : 'Warning';
  return 'NA';
}

export function isScoreEligibleEvaluation(evaluationState) {
  return evaluationState === 'pass' || evaluationState === 'fail';
}

function formatCoverage(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}
