#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const program = new Command();

program
  .name('convert-reference-xlsx')
  .description('Print controlled conversion guidance for manual reference audit XLSX files.')
  .requiredOption('--input <path>', 'Path to the original XLSX/XLS file')
  .option('--out <dir>', 'Directory where CSV/JSON exports should be placed')
  .parse(process.argv);

const options = program.opts();
const inputPath = path.resolve(options.input);
const outDir = path.resolve(options.out || path.join(process.cwd(), 'reference-audits', 'fressnapf', 'original'));

if (!fs.existsSync(inputPath)) {
  console.error(`XLSX file not found: ${inputPath}`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(outDir, { recursive: true });
  const instructions = buildInstructions(inputPath, outDir);
  const target = path.join(outDir, 'xlsx-conversion-instructions.md');
  fs.writeFileSync(target, instructions, 'utf8');
  console.log(`No XLSX parser is bundled in this build.`);
  console.log(`Export the Excel sheets to CSV and place them in: ${outDir}`);
  console.log(`Instructions written: ${target}`);
}

function buildInstructions(inputPath, outDir) {
  return `# XLSX Conversion Instructions

Original file:

\`${inputPath}\`

Batch 10.2 intentionally does not parse XLSX directly because the project has no stable XLSX dependency. Convert each relevant worksheet to CSV and put the files into:

\`${outDir}\`

Recommended naming:

- \`01-overview.csv\`
- \`02-technical-seo.csv\`
- \`03-performance.csv\`
- \`04-structured-data.csv\`
- \`05-geo-ai-search.csv\`
- \`mapping-notes.json\` if manual mapping overrides are needed

Required minimum columns:

- \`Audit Point\` or \`Pruefpunkt\`
- \`Finding\` or \`Beschreibung\`
- \`Category\` or \`Bereich\`
- \`Priority\` or \`Severity\`
- \`Evidence\`
- \`Recommendation\`
- optional: \`Affected URLs\`, \`Affected Count\`, \`Expected Tool Check IDs\`, \`Expected Data Sources\`

After exporting, run:

\`\`\`bash
node scripts/prepare-fressnapf-reference.js --runId 76 --out reports/validation-fressnapf-original-run-76
\`\`\`
`;
}
