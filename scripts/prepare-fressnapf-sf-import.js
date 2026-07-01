#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { getDb, closeDb } from '../src/db/database.js';
import { importScreamingFrogAudit } from '../src/importers/screamingFrog/screamingFrogImportService.js';
import { validateRunAgainstReference } from '../src/validation/referenceAudit/validationService.js';

const DEFAULT_INPUTS = [
  'reference-audits/fressnapf/screaming-frog',
  'reference-audits/fressnapf/original/screaming-frog',
  'imports/fressnapf',
  '.'
];

const program = new Command();

program
  .name('prepare-fressnapf-sf-import')
  .description('Import real Fressnapf Screaming Frog exports and validate against the original manual reference audit.')
  .option('--input <path>', 'Folder, ZIP or CSV path containing Screaming Frog exports')
  .option('--reference <path>', 'Reference audit JSON/CSV path', 'reference-audits/fressnapf/fressnapf-reference-audit.json')
  .option('--out <dir>', 'Output directory', 'reports/validation-fressnapf-original-sf-import')
  .option('--domain <url>', 'Domain to use when imports do not infer one', 'https://www.fressnapf.de')
  .option('--compareRunId <id>', 'Existing sample run id for comparison', '76')
  .parse(process.argv);

const options = program.opts();
const outDir = path.resolve(options.out);
fs.mkdirSync(outDir, { recursive: true });

const inputCandidates = options.input ? [options.input] : DEFAULT_INPUTS;
const files = findSfFiles(inputCandidates);

if (!files.length) {
  writeNotFound(outDir, inputCandidates);
  console.log(`No real Screaming Frog exports found. Instructions written to: ${outDir}`);
  process.exit(0);
}

const db = getDb();
try {
  const importResult = await importScreamingFrogAudit(db, {
    domain: options.domain,
    folderPath: commonFolder(files),
    filePaths: files,
    storageProfile: 'standard',
    auditType: 'both'
  });
  const validation = await validateRunAgainstReference(db, {
    runId: importResult.runId,
    referencePath: options.reference,
    outDir
  });
  const comparison = compareValidationSummaries(db, Number(options.compareRunId), validation);
  fs.writeFileSync(path.join(outDir, 'comparison-run76-vs-sf.json'), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'comparison-run76-vs-sf.md'), renderComparisonMarkdown(comparison), 'utf8');
  console.log(`SF import run completed: ${importResult.runId}`);
  console.log(`Coverage: ${validation.validationSummary.coveragePercent}%`);
  console.log(`Output: ${outDir}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  closeDb();
}

function findSfFiles(candidates) {
  const files = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) continue;
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walk(resolved, files);
    } else if (/\.(csv|zip)$/i.test(resolved)) {
      files.push(resolved);
    }
  }
  return [...new Set(files)].filter((file) => !isIgnoredImportPath(file)).sort();
}

function walk(dir, files, depth = 0) {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (isIgnoredImportPath(fullPath)) continue;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walk(fullPath, files, depth + 1);
    } else if (/\.(csv|zip)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
}

function isIgnoredImportPath(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return /\/(\.git|node_modules|data|reports|storage|database|tmp|\.cache)(\/|$)/.test(normalized)
    || /\/reference-audits\/fressnapf\/original(\/|$)/.test(normalized)
    || /\/reference-audits\/fressnapf\/fressnapf-reference-audit\.(csv|json)$/.test(normalized)
    || /\/reference-audits\/fressnapf\/reference-import-summary\./.test(normalized);
}

function commonFolder(files) {
  const first = files[0];
  return first && fs.existsSync(first) && fs.statSync(first).isDirectory() ? first : null;
}

function writeNotFound(targetDir, candidates) {
  const body = `# Screaming Frog Import Not Found

No real Fressnapf Screaming Frog full export was found locally.

Checked locations:

${candidates.map((item) => `- \`${path.resolve(item)}\``).join('\n')}

No import run was created and no coverage comparison was generated.
`;
  fs.writeFileSync(path.join(targetDir, 'sf-import-not-found.md'), body, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'sf-import-instructions.md'), fs.readFileSync(path.resolve('reference-audits/fressnapf/screaming-frog/README.md'), 'utf8'), 'utf8');
}

function compareValidationSummaries(db, baseRunId, validation) {
  const base = db.prepare(`
    SELECT reportJson
    FROM validation_reports
    WHERE runId = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(baseRunId);
  const baseReport = safeJson(base?.reportJson, {});
  const baseSummary = baseReport.validationSummary || {};
  const sfSummary = validation.validationSummary || {};
  const keys = ['covered', 'partiallyCovered', 'notCovered', 'needsExternalData', 'needsLargerCrawl', 'toolExtras', 'falsePositiveCandidates', 'falseNegativeCandidates'];
  const deltas = Object.fromEntries(keys.map((key) => [key, Number(sfSummary[key] || 0) - Number(baseSummary[key] || 0)]));
  return {
    generatedAt: new Date().toISOString(),
    baseRunId,
    sfRunId: validation.runId,
    baseCoveragePercent: baseSummary.coveragePercent ?? null,
    sfCoveragePercent: sfSummary.coveragePercent ?? null,
    coveragePercentDelta: baseSummary.coveragePercent === undefined ? null : Number(((sfSummary.coveragePercent || 0) - (baseSummary.coveragePercent || 0)).toFixed(1)),
    deltas,
    baseSummary,
    sfSummary
  };
}

function renderComparisonMarkdown(comparison) {
  return `# Run 76 vs Screaming Frog Import

- Base run: ${comparison.baseRunId}
- SF import run: ${comparison.sfRunId}
- Base coverage: ${comparison.baseCoveragePercent ?? 'n/a'}%
- SF coverage: ${comparison.sfCoveragePercent ?? 'n/a'}%
- Coverage delta: ${comparison.coveragePercentDelta ?? 'n/a'} percentage points

## Deltas

${Object.entries(comparison.deltas || {}).map(([key, value]) => `- ${key}: ${value >= 0 ? '+' : ''}${value}`).join('\n')}
`;
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
