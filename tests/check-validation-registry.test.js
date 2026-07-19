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
  assert.equal(summary.statusCounts.cross_domain_validated, 1);
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
