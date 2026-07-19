import fs from 'node:fs';

export const CHECK_VALIDATION_STATUSES = Object.freeze([
  'unvalidated',
  'fixture_validated',
  'single_domain_validated',
  'cross_domain_validated',
  'validated_with_limits',
  'manual_review_required',
  'invalid',
  'deprecated'
]);

export const TRUSTED_ACTIVE_VALIDATION_STATUSES = Object.freeze([
  'cross_domain_validated',
  'validated_with_limits',
  'manual_review_required'
]);

const REQUIRED_ARRAY_FIELDS = Object.freeze([
  'required_facts',
  'data_sources',
  'inventory_issues',
  'tested_domains',
  'tested_archetypes',
  'fixture_tests',
  'real_world_runs',
  'known_limits',
  'evidence_references'
]);

const EVIDENCE_CLASSES = new Set([
  'primary_required',
  'primary_conditional',
  'secondary_diagnostic',
  'optional_opportunity',
  'inventory'
]);
const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
const SCORE_EFFECT_VALUES = new Set(['score_capable', 'conditional', 'score_free']);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function loadCheckValidationRegistry(fileUrl = new URL('../../docs/check-validation-registry.json', import.meta.url)) {
  return JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
}

export function validateCheckValidationRegistry(registry, activeChecks = []) {
  const errors = [];
  if (!registry || typeof registry !== 'object') return ['Registry must be a JSON object.'];
  if (!/^check-validation-registry-v\d+$/.test(registry.registry_version || '')) errors.push('registry_version must be versioned.');
  if (!COMMIT_PATTERN.test(registry.source_commit || '')) errors.push('source_commit must be a full Git commit hash.');
  if (!registry.generated_at || Number.isNaN(Date.parse(registry.generated_at))) errors.push('generated_at must be an ISO timestamp.');
  if (!registry.check_logic_version) errors.push('check_logic_version is required.');
  if (!Array.isArray(registry.checks)) return [...errors, 'checks must be an array.'];

  const activeById = new Map();
  for (const check of activeChecks) {
    if (activeById.has(check.id)) errors.push(`${check.id}: duplicate active check ID.`);
    activeById.set(check.id, check);
  }
  const seen = new Set();
  for (const entry of registry.checks) {
    const label = entry?.check_id || '<missing-check-id>';
    if (!entry?.check_id) errors.push('Every registry entry needs check_id.');
    if (seen.has(label)) errors.push(`${label}: duplicate registry entry.`);
    seen.add(label);
    if (!CHECK_VALIDATION_STATUSES.includes(entry.validation_status)) errors.push(`${label}: invalid validation_status.`);
    if (entry.current_validation_status !== entry.validation_status) errors.push(`${label}: current_validation_status must match validation_status.`);
    if (!CONFIDENCE_VALUES.has(entry.validation_confidence)) errors.push(`${label}: invalid validation_confidence.`);
    if (!EVIDENCE_CLASSES.has(entry.evidence_class)) errors.push(`${label}: invalid evidence_class.`);
    if (!SCORE_EFFECT_VALUES.has(entry.score_effect)) errors.push(`${label}: invalid score_effect.`);
    if (!entry.name || !entry.category || !entry.finding_type || !entry.default_severity) errors.push(`${label}: inventory metadata is incomplete.`);
    if (!entry.coverage_unit || !entry.scope || !entry.root_cause_family) errors.push(`${label}: coverage, scope, and root-cause metadata are required.`);
    for (const field of REQUIRED_ARRAY_FIELDS) if (!Array.isArray(entry[field])) errors.push(`${label}: ${field} must be an array.`);
    for (const field of ['positive_cases', 'negative_cases', 'false_positives', 'false_negatives', 'severity_errors', 'scope_errors', 'stability_runs', 'historical_observations', 'historical_run_count']) {
      if (!Number.isInteger(entry[field]) || entry[field] < 0) errors.push(`${label}: ${field} must be a non-negative integer.`);
    }

    const registered = activeById.has(label);
    const activeDefinition = activeById.get(label);
    if (registered && !entry.active) errors.push(`${label}: an active check cannot be marked inactive in the registry.`);
    if (registered && entry.name !== activeDefinition.name) errors.push(`${label}: registry name is stale.`);
    if (registered && entry.category !== activeDefinition.category) errors.push(`${label}: registry category is stale.`);
    if (registered && entry.default_severity !== activeDefinition.priority) errors.push(`${label}: registry default severity is stale.`);
    if (!registered && entry.active) errors.push(`${label}: unknown active check ID.`);
    if (!registered && entry.validation_status !== 'deprecated') errors.push(`${label}: removed checks must be deprecated.`);
    if (entry.validation_status === 'deprecated' && entry.active) errors.push(`${label}: deprecated checks cannot be active.`);
    if (entry.validation_status === 'fixture_validated' && entry.fixture_tests.length === 0) errors.push(`${label}: fixture_validated requires a direct fixture test reference.`);
    if (entry.requirement_definition_status === 'declared' && entry.required_facts.length === 0) errors.push(`${label}: declared requirements cannot be empty.`);
    if (entry.requirement_definition_status === 'missing' && !entry.inventory_issues.includes('missing_central_requirement_definition')) errors.push(`${label}: missing requirements must be explicit.`);
    if (entry.validation_status === 'single_domain_validated') {
      if (entry.tested_domains.length < 1 || entry.real_world_runs.length < 1) errors.push(`${label}: single_domain_validated requires real-domain evidence.`);
      if (!entry.last_validated_at || !COMMIT_PATTERN.test(entry.last_validated_commit || '')) errors.push(`${label}: single-domain validation needs date and commit provenance.`);
    }
    if (entry.validation_status === 'cross_domain_validated') validateCrossDomain(entry, errors);
    if (entry.validation_status === 'validated_with_limits') {
      if (entry.tested_domains.length < 2 || entry.tested_archetypes.length < 2) errors.push(`${label}: validated_with_limits requires cross-implementation evidence.`);
      if (entry.known_limits.length === 0) errors.push(`${label}: validated_with_limits requires documented limits.`);
    }
    if (entry.validation_status === 'manual_review_required' && !entry.manual_review_reason) errors.push(`${label}: manual_review_required needs a reason.`);
    if (entry.validation_status === 'invalid') {
      if (entry.score_effect !== 'score_free') errors.push(`${label}: invalid checks must be score_free.`);
      if (entry.recommended_trust_action !== 'disable_scoring') errors.push(`${label}: invalid checks must disable scoring.`);
    }
    if (entry.validation_status === 'unvalidated' && entry.recommended_trust_action !== 'validation_required_score_free') {
      errors.push(`${label}: unvalidated checks must explicitly recommend score-free validation.`);
    }
    if (['unvalidated', 'fixture_validated', 'single_domain_validated'].includes(entry.validation_status) && !entry.validation_gap) {
      errors.push(`${label}: incomplete validation requires a documented gap.`);
    }
  }

  for (const checkId of activeById.keys()) if (!seen.has(checkId)) errors.push(`${checkId}: active check is missing from the validation registry.`);
  validateSummary(registry, errors);
  return errors;
}

export function summarizeCheckValidationRegistry(registry) {
  const active = registry.checks.filter((entry) => entry.active);
  const trusted = new Set(TRUSTED_ACTIVE_VALIDATION_STATUSES);
  const statusCounts = Object.fromEntries(CHECK_VALIDATION_STATUSES.map((status) => [
    status,
    active.filter((entry) => entry.validation_status === status).length
  ]));
  return {
    totalChecks: registry.checks.length,
    activeChecks: active.length,
    historicalChecks: registry.checks.length - active.length,
    validatedActiveChecks: active.filter((entry) => trusted.has(entry.validation_status)).length,
    statusCounts,
    checksWithoutCentralRequirements: active.filter((entry) => entry.requirement_definition_status === 'missing').length
  };
}

function validateCrossDomain(entry, errors) {
  const label = entry.check_id;
  if (entry.tested_domains.length < 2) errors.push(`${label}: cross_domain_validated requires at least two domains.`);
  if (entry.tested_archetypes.length < 2) errors.push(`${label}: cross_domain_validated requires at least two archetypes.`);
  if (entry.positive_cases < 1 || entry.negative_cases < 1) errors.push(`${label}: cross_domain_validated requires positive and negative cases.`);
  if (entry.fixture_tests.length < 1) errors.push(`${label}: cross_domain_validated requires a regression test.`);
  if (entry.real_world_runs.length < 1 || entry.evidence_references.length < 2) errors.push(`${label}: cross_domain_validated requires manual evidence references.`);
  if (entry.stability_runs < 2) errors.push(`${label}: cross_domain_validated requires repeatability evidence.`);
  if (entry.false_positives || entry.false_negatives || entry.severity_errors || entry.scope_errors) errors.push(`${label}: cross_domain_validated cannot have unresolved validation errors.`);
  if (entry.validation_confidence !== 'high') errors.push(`${label}: cross_domain_validated must have high confidence.`);
  if (!entry.last_validated_at || !COMMIT_PATTERN.test(entry.last_validated_commit || '')) errors.push(`${label}: cross-domain validation needs date and commit provenance.`);
}

function validateSummary(registry, errors) {
  const actual = summarizeCheckValidationRegistry(registry);
  const summary = registry.summary || {};
  if (summary.total_checks !== actual.totalChecks) errors.push('summary.total_checks is stale.');
  if (summary.total_active_checks !== actual.activeChecks) errors.push('summary.total_active_checks is stale.');
  if (summary.historical_checks !== actual.historicalChecks) errors.push('summary.historical_checks is stale.');
  if (summary.validated_active_checks !== actual.validatedActiveChecks) errors.push('summary.validated_active_checks is stale.');
  if (summary.checks_without_central_requirement_definition !== actual.checksWithoutCentralRequirements) errors.push('summary requirement-definition count is stale.');
  for (const status of CHECK_VALIDATION_STATUSES) {
    if (summary.status_counts?.[status] !== actual.statusCounts[status]) errors.push(`summary.status_counts.${status} is stale.`);
  }
}
