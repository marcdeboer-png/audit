#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { getDb, closeDb } from '../src/db/database.js';
import { buildStorageRealityCheck, renderStorageRealityMarkdown } from '../src/analysis/storageRealityCheck.js';
import { parseReferenceAuditFiles } from '../src/validation/referenceAudit/referenceAuditParser.js';
import { validateRunAgainstReference } from '../src/validation/referenceAudit/validationService.js';
import { renderReferenceImportSummaryMarkdown } from '../src/validation/referenceAudit/validationExportService.js';
import { extractReferenceXlsx, writeSourceInventory } from '../src/validation/referenceAudit/xlsxReferenceExtractor.js';
import { csvEscape } from '../src/reports/csvExporter.js';

const program = new Command();

program
  .name('prepare-fressnapf-reference')
  .description('Prepare or run the Fressnapf original manual audit validation case.')
  .option('--runId <id>', 'Audit run id to compare against', '76')
  .option('--referenceDir <dir>', 'Directory containing original CSV/JSON exports', 'reference-audits/fressnapf/original')
  .option('--out <dir>', 'Output directory')
  .parse(process.argv);

const options = program.opts();
await main();

async function main() {
  const runId = Number(options.runId);
  const referenceDir = path.resolve(options.referenceDir);
  const outDir = path.resolve(options.out || path.join(process.cwd(), 'reports', `validation-fressnapf-original-run-${runId}`));
  const db = getDb();

  try {
  fs.mkdirSync(outDir, { recursive: true });
  let files = findReferenceFiles(referenceDir);
  const storageReality = buildStorageRealityCheck(db, runId);
  if (storageReality) {
    writeJson(path.join(outDir, 'storage-reality-check.json'), storageReality);
    fs.writeFileSync(path.join(outDir, 'storage-reality-check.md'), renderStorageRealityMarkdown(storageReality), 'utf8');
  }

  if (!files.supported.length && files.xlsx.length) {
    const extraction = extractReferenceXlsx({
      xlsxPath: files.xlsx[0],
      outDir: path.join(referenceDir, 'exported-csv')
    });
    writeSourceInventory(extraction, referenceDir);
    files = {
      ...files,
      supported: extraction.referenceCsvPaths,
      extraction
    };
  }

  if (!files.supported.length) {
    const missing = buildMissingOriginalPayload({ runId, referenceDir, outDir, files, storageReality });
    writeJson(path.join(outDir, 'original-audit-not-found.json'), missing);
    fs.writeFileSync(path.join(outDir, 'original-audit-not-found.md'), renderMissingOriginalMarkdown(missing), 'utf8');
    fs.writeFileSync(path.join(outDir, 'reference-import-instructions.md'), renderImportInstructions(referenceDir, files), 'utf8');
    writeJson(path.join(outDir, 'reference-import-instructions.json'), {
      referenceDir,
      supportedFormats: ['csv', 'json'],
      xlsxSupport: 'not_available_export_excel_to_csv_or_json',
      foundUnsupportedFiles: files.unsupported
    });
    console.log(`Original reference CSV/JSON not found. Guidance written to ${outDir}`);
    process.exitCode = files.xlsx.length ? 2 : 1;
    return;
  }

  const referenceAudit = parseReferenceAuditFiles(files.supported);
  const richImportSummary = buildRichReferenceImportSummary(referenceAudit, files);
  const referenceJsonPath = path.join(process.cwd(), 'reference-audits', 'fressnapf', 'fressnapf-reference-audit.json');
  const referenceCsvPath = path.join(process.cwd(), 'reference-audits', 'fressnapf', 'fressnapf-reference-audit.csv');
  writeJson(referenceJsonPath, {
    source: 'original_fressnapf_manual_omfire_tech_audit',
    itemCount: referenceAudit.itemCount,
    items: referenceAudit.items,
    ignoredRows: referenceAudit.ignoredRows,
    warnings: referenceAudit.warnings,
    importSummary: richImportSummary
  });
  fs.writeFileSync(referenceCsvPath, referenceItemsCsv(referenceAudit.items), 'utf8');
  writeJson(path.join(process.cwd(), 'reference-audits', 'fressnapf', 'reference-import-summary.json'), richImportSummary);
  fs.writeFileSync(path.join(process.cwd(), 'reference-audits', 'fressnapf', 'reference-import-summary.md'), renderRichReferenceImportSummaryMarkdown(richImportSummary), 'utf8');
  writeJson(path.join(outDir, 'reference-import-summary.json'), richImportSummary);
  fs.writeFileSync(path.join(outDir, 'reference-import-summary.md'), renderRichReferenceImportSummaryMarkdown(richImportSummary), 'utf8');
  writeJson(path.join(outDir, 'normalized-reference-audit.json'), {
    itemCount: referenceAudit.itemCount,
    items: referenceAudit.items,
    ignoredRows: referenceAudit.ignoredRows,
    warnings: referenceAudit.warnings,
    importSummary: richImportSummary
  });

  const report = await validateRunAgainstReference(db, {
    runId,
    referencePath: referenceJsonPath,
    outDir
  });
  console.log(`Fressnapf original validation completed: ${report.validationId}`);
  console.log(`Imported manual points: ${report.validationSummary.manualItemCount}`);
  console.log(`Coverage: ${report.validationSummary.coveragePercent}%`);
  console.log(`Output: ${outDir}`);
  } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  } finally {
  closeDb();
  }
}

function findReferenceFiles(referenceDir) {
  const files = fs.existsSync(referenceDir)
    ? fs.readdirSync(referenceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(referenceDir, entry.name))
    : [];
  return {
    supported: files.filter((file) => /\.(csv|json|txt)$/i.test(file) && !isGeneratedReferenceMetadata(file)).sort(),
    xlsx: files.filter((file) => /\.(xlsx|xls)$/i.test(file)).sort(),
    unsupported: files.filter((file) => !/\.(csv|json|txt|xlsx|xls|md)$/i.test(file)).sort()
  };
}

function isGeneratedReferenceMetadata(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return [
    'source-inventory.json',
    'reference-import-summary.json',
    'reference-import-instructions.json',
    'original-audit-not-found.json'
  ].includes(name);
}

function buildRichReferenceImportSummary(referenceAudit, files) {
  const base = referenceAudit.importSummary || {};
  const items = referenceAudit.items || [];
  const categories = countBy(items, (item) => item.category || 'uncategorized');
  const priorities = countBy(items, (item) => item.priority || 'unknown');
  const severities = countBy(items, (item) => item.severity || 'unknown');
  const statuses = countBy(items, (item) => item.status || 'unknown');
  const dataSources = countBy(items.flatMap((item) => item.expectedDataSources?.length ? item.expectedDataSources : ['unknown']), (value) => value);
  const sourceInventory = files.extraction?.inventory || null;
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    originalFiles: {
      xlsx: files.xlsx,
      usedReferenceFiles: files.supported,
      extractionUsed: Boolean(files.extraction)
    },
    importedManualAuditPoints: items.length,
    ignoredRows: referenceAudit.ignoredRows?.length || base.ignoredRows || 0,
    ignoredSheetsOrCsvs: sourceInventory
      ? sourceInventory.sheets.filter((sheet) => !sheet.used).map((sheet) => ({ name: sheet.name, reason: sheet.reason }))
      : [],
    categories,
    priorities,
    severities,
    statuses,
    itemsWithUrlEvidence: items.filter((item) => item.affectedUrls?.length).length,
    itemsWithAffectedCount: items.filter((item) => Number(item.affectedCount || 0) > 0).length,
    itemsWithRecommendation: items.filter((item) => item.recommendation).length,
    itemsWithDataSource: items.filter((item) => item.expectedDataSources?.length).length,
    itemsRequiringExternalDataHint: items.filter((item) => item.requiresExternalData || /sf|requests|crux|psi|lighthouse|browser|devtools|gsc|log/i.test((item.expectedDataSources || []).join(' '))).length,
    itemsRequiringHumanReviewHint: items.filter((item) => item.requiresHumanJudgment).length,
    itemsRequiringLlmReviewHint: items.filter((item) => item.requiresLlmJudgment).length,
    unknownColumns: base.ignoredColumns || [],
    warnings: referenceAudit.warnings || [],
    sourceInventoryPath: sourceInventory ? path.join(path.resolve('reference-audits/fressnapf/original'), 'source-inventory.json') : null
  };
}

function renderRichReferenceImportSummaryMarkdown(summary = {}) {
  return `${renderReferenceImportSummaryMarkdown(summary)}
## Normalized Manual Audit Points

- Imported real audit points: ${summary.importedManualAuditPoints || 0}
- Ignored rows: ${summary.ignoredRows || 0}
- Ignored sheets/CSVs: ${(summary.ignoredSheetsOrCsvs || []).length}
- Items with URL evidence: ${summary.itemsWithUrlEvidence || 0}
- Items with affected count: ${summary.itemsWithAffectedCount || 0}
- Items with recommendation: ${summary.itemsWithRecommendation || 0}
- Items with data source: ${summary.itemsWithDataSource || 0}
- Items with external-data hint: ${summary.itemsRequiringExternalDataHint || 0}
- Items with human-review hint: ${summary.itemsRequiringHumanReviewHint || 0}
- Items with LLM-review hint: ${summary.itemsRequiringLlmReviewHint || 0}

## Categories

${objectList(summary.categories)}

## Priorities

${objectList(summary.priorities)}

## Severities

${objectList(summary.severities)}

## Statuses

${objectList(summary.statuses)}

## Ignored Sheets/CSVs

${(summary.ignoredSheetsOrCsvs || []).length ? summary.ignoredSheetsOrCsvs.map((item) => `- ${item.name}: ${item.reason}`).join('\n') : '- None'}
`;
}

function referenceItemsCsv(items = []) {
  const columns = [
    'id',
    'sourceFile',
    'sourceSheet',
    'originalRow',
    'title',
    'description',
    'category',
    'severity',
    'priority',
    'effort',
    'status',
    'affectedCount',
    'affectedUrls',
    'recommendation',
    'expectedDataSources'
  ];
  const lines = [`${columns.map(csvEscape).join(',')}\n`];
  for (const item of items) {
    const row = {
      ...item,
      affectedUrls: (item.affectedUrls || []).join('\n'),
      expectedDataSources: (item.expectedDataSources || []).join('|')
    };
    lines.push(`${columns.map((column) => csvEscape(row[column] ?? '')).join(',')}\n`);
  }
  return lines.join('');
}

function countBy(values, keyFn) {
  const output = {};
  for (const value of values) {
    const key = keyFn(value) || 'unknown';
    output[key] = (output[key] || 0) + 1;
  }
  return output;
}

function objectList(object = {}) {
  const entries = Object.entries(object).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([key, value]) => `- ${key}: ${value}`).join('\n') : '- None';
}

function buildMissingOriginalPayload({ runId, referenceDir, outDir, files, storageReality }) {
  return {
    runId,
    generatedAt: new Date().toISOString(),
    status: 'blocked_original_reference_audit_missing',
    referenceDir,
    outDir,
    importedManualItems: 0,
    realCoverageMeasured: false,
    supportedReferenceFilesFound: 0,
    unsupportedXlsxFound: files.xlsx,
    unsupportedOtherFilesFound: files.unsupported,
    requiredAction: `Place CSV/JSON exports of the original manual audit in ${referenceDir}. XLSX must be exported to CSV first.`,
    storageRealityAvailable: Boolean(storageReality),
    storageRiskLevel: storageReality?.riskLevel || null
  };
}

function renderMissingOriginalMarkdown(payload) {
  return `# Original Fressnapf Audit Not Found

Run ${payload.runId} could not be validated against the real manual OMfire! Fressnapf Tech Audit because no supported reference CSV/JSON file was found.

This is not a failed validation result. It means no real original-audit coverage can be claimed yet.

## Where To Place The Original Audit

\`${payload.referenceDir}\`

Supported now:

- CSV exports from Excel
- JSON reference audit files

XLSX found:

${payload.unsupportedXlsxFound.length ? payload.unsupportedXlsxFound.map((file) => `- ${file}`).join('\n') : '- none'}

## Required Action

${payload.requiredAction}

After conversion, run:

\`\`\`bash
node scripts/prepare-fressnapf-reference.js --runId ${payload.runId} --out ${payload.outDir}
\`\`\`
`;
}

function renderImportInstructions(referenceDir, files) {
  return `# Reference Import Instructions

Put manual OMfire! audit exports into:

\`${referenceDir}\`

Use one CSV per relevant Excel sheet if the original workbook has multiple sheets. The parser will merge CSV/JSON files and keep source file/sheet information.

Recommended columns:

- \`Audit Point\`, \`Pruefpunkt\` or \`Title\`
- \`Finding\`, \`Beschreibung\` or \`Description\`
- \`Category\` or \`Bereich\`
- \`Priority\`, \`Severity\` or \`Impact\`
- \`Evidence\`
- \`Recommendation\` or \`Massnahme\`
- \`Affected URLs\`
- \`Affected Count\`
- \`Expected Tool Check IDs\`
- \`Expected Data Sources\`

Unsupported XLSX files currently present:

${files.xlsx.length ? files.xlsx.map((file) => `- ${file}`).join('\n') : '- none'}

Convert XLSX manually or run:

\`\`\`bash
node scripts/convert-reference-xlsx.js --input path/to/original.xlsx --out ${referenceDir}
\`\`\`
`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
