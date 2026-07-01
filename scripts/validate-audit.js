#!/usr/bin/env node
import { Command } from 'commander';
import { getDb, closeDb } from '../src/db/database.js';
import { validateRunAgainstReference } from '../src/validation/referenceAudit/validationService.js';

const program = new Command();

program
  .name('validate-audit')
  .description('Compare a completed audit run against a manual reference audit CSV/JSON file.')
  .requiredOption('--runId <id>', 'Audit run id')
  .requiredOption('--reference <paths...>', 'Reference audit CSV or JSON file(s)')
  .option('--format <format>', 'Reference format: csv or json')
  .option('--sheet <name>', 'Optional source sheet name for CSV exports')
  .option('--out <dir>', 'Output directory for validation files')
  .parse(process.argv);

const options = program.opts();
const db = getDb();
const references = Array.isArray(options.reference) ? options.reference : [options.reference];

try {
  const report = await validateRunAgainstReference(db, {
    runId: Number(options.runId),
    referencePath: references.length === 1 ? references[0] : undefined,
    referencePaths: references.length > 1 ? references : undefined,
    format: options.format,
    sourceSheet: options.sheet,
    outDir: options.out
  });
  const summary = report.validationSummary;
  console.log(`Validation ${report.validationId} completed for run ${report.runId}`);
  console.log(`Manual items: ${summary.manualItemCount}`);
  console.log(`Coverage: ${summary.coveragePercent}%`);
  console.log(`Covered: ${summary.covered}, partial: ${summary.partiallyCovered}, gaps: ${summary.notCovered + summary.falseNegativeCandidates}`);
  console.log(`Tool extras: ${summary.toolExtras}`);
  console.log(`Output: ${report.exports.outputDir}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  closeDb();
}
