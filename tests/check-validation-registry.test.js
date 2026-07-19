import test from 'node:test';
import assert from 'node:assert/strict';
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import {
  loadCheckValidationRegistry,
  summarizeCheckValidationRegistry,
  validateCheckValidationRegistry
} from '../src/validation/checkValidationRegistry.js';

const activeChecks = [...techChecks(), ...geoChecks()];

test('every active audit check has one valid registry entry', () => {
  const registry = loadCheckValidationRegistry();
  assert.deepEqual(validateCheckValidationRegistry(registry, activeChecks), []);
  const summary = summarizeCheckValidationRegistry(registry);
  assert.equal(summary.activeChecks, activeChecks.length);
  assert.equal(summary.totalChecks, registry.checks.length);
  assert.equal(summary.statusCounts.cross_domain_validated, 4);
});

test('registry validation fails closed for a new unregistered check', () => {
  const registry = loadCheckValidationRegistry();
  const errors = validateCheckValidationRegistry(registry, [...activeChecks, { id: 'tech.unregistered_fixture' }]);
  assert.ok(errors.some((error) => error.includes('tech.unregistered_fixture: active check is missing')));
});

test('registry validation detects duplicate active IDs and stale inventory metadata', () => {
  const registry = structuredClone(loadCheckValidationRegistry());
  const first = registry.checks.find((item) => item.active);
  first.name = 'Stale name';
  const duplicate = activeChecks.find((check) => check.id === first.check_id);
  const errors = validateCheckValidationRegistry(registry, [...activeChecks, duplicate]);
  assert.ok(errors.some((error) => error.includes('duplicate active check ID')));
  assert.ok(errors.some((error) => error.includes('registry name is stale')));
});

test('cross-domain status enforces domains, archetypes, case polarity, tests, stability and clean errors', () => {
  const registry = structuredClone(loadCheckValidationRegistry());
  const entry = registry.checks.find((item) => item.check_id === 'tech.synthetic_not_found_handling');
  entry.tested_domains = ['example.test'];
  entry.negative_cases = 0;
  entry.stability_runs = 1;
  entry.false_positives = 1;
  const errors = validateCheckValidationRegistry(registry, activeChecks);
  assert.ok(errors.some((error) => error.includes('at least two domains')));
  assert.ok(errors.some((error) => error.includes('positive and negative cases')));
  assert.ok(errors.some((error) => error.includes('repeatability evidence')));
  assert.ok(errors.some((error) => error.includes('unresolved validation errors')));
});

test('invalid checks cannot remain score-capable and removed checks must be deprecated', () => {
  const registry = structuredClone(loadCheckValidationRegistry());
  const entry = registry.checks.find((item) => item.check_id === 'tech.synthetic_not_found_handling');
  entry.current_validation_status = 'invalid';
  entry.validation_status = 'invalid';
  entry.score_effect = 'score_capable';
  entry.recommended_trust_action = 'active';
  registry.checks.push({ ...entry, check_id: 'tech.removed_historical', active: false, validation_status: 'fixture_validated', current_validation_status: 'fixture_validated' });
  const errors = validateCheckValidationRegistry(registry, activeChecks);
  assert.ok(errors.some((error) => error.includes('invalid checks must be score_free')));
  assert.ok(errors.some((error) => error.includes('invalid checks must disable scoring')));
  assert.ok(errors.some((error) => error.includes('removed checks must be deprecated')));
});

test('canonical family records automation limits without inflating trust', () => {
  const registry = loadCheckValidationRegistry();
  const byId = new Map(registry.checks.map((entry) => [entry.check_id, entry]));
  assert.equal(byId.get('tech.canonical_missing').validation_status, 'cross_domain_validated');
  assert.equal(byId.get('tech.canonical_target_non_200').validation_status, 'fixture_validated');
  assert.match(byId.get('tech.canonical_target_non_200').validation_gap.missing_evidence.join(' '), /real positive case/);
  for (const id of ['tech.canonical_non_self', 'tech.canonical_to_other_domain', 'template.canonical_pattern_issue']) {
    assert.equal(byId.get(id).validation_status, 'manual_review_required', id);
    assert.equal(byId.get(id).score_effect, 'score_free', id);
    assert.ok(byId.get(id).manual_review_reason.length > 20, id);
  }
});

test('HTTP family records retry, host and inventory trust limits conservatively', () => {
  const registry = loadCheckValidationRegistry();
  const byId = new Map(registry.checks.map((entry) => [entry.check_id, entry]));
  const allowedTrustActions = new Set([
    'fully_automated', 'automated_with_limits', 'manual_review_required',
    'diagnostic_only', 'temporarily_score_free', 'invalid_disabled'
  ]);
  const httpIds = [
    'tech.https_reachable', 'tech.http_to_https_redirect', 'tech.www_non_www_consistency',
    'tech.synthetic_not_found_handling', 'tech.status_code_distribution', 'tech.4xx_pages',
    'tech.5xx_pages', 'tech.redirect_pages', 'tech.sitemap_urls_non_200',
    'tech.internal_links_to_3xx', 'tech.internal_links_to_4xx_5xx'
  ];
  for (const id of httpIds) assert.ok(allowedTrustActions.has(byId.get(id).recommended_trust_action), id);
  assert.equal(byId.get('tech.4xx_pages').validation_status, 'cross_domain_validated');
  assert.equal(byId.get('tech.5xx_pages').validation_status, 'fixture_validated');
  assert.match(byId.get('tech.5xx_pages').validation_gap.missing_evidence.join(' '), /real positive case/);
  assert.equal(byId.get('tech.https_reachable').validation_status, 'validated_with_limits');
  assert.equal(byId.get('tech.http_to_https_redirect').validation_status, 'validated_with_limits');
  assert.equal(byId.get('tech.www_non_www_consistency').validation_status, 'validated_with_limits');
  assert.equal(byId.get('tech.redirect_pages').validation_status, 'cross_domain_validated');
  assert.equal(byId.get('tech.redirect_pages').score_effect, 'score_free');
  assert.equal(byId.get('tech.internal_links_to_4xx_5xx').validation_status, 'single_domain_validated');
});
