#!/usr/bin/env node
import { techChecks } from '../src/checks/tech/index.js';
import { geoChecks } from '../src/checks/geo/index.js';
import {
  loadCheckValidationRegistry,
  summarizeCheckValidationRegistry,
  validateCheckValidationRegistry
} from '../src/validation/checkValidationRegistry.js';

const registry = loadCheckValidationRegistry();
const activeChecks = [...techChecks(), ...geoChecks()];
const errors = validateCheckValidationRegistry(registry, activeChecks);
const summary = summarizeCheckValidationRegistry(registry);

if (errors.length) {
  console.error(`Check validation registry is invalid (${errors.length} error(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Check validation registry ${registry.registry_version} is consistent.`);
  console.log(JSON.stringify(summary, null, 2));
}
