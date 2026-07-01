import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { csvEscape } from '../../reports/csvExporter.js';
import { normalizeHeader } from '../../importers/screamingFrog/parseScreamingFrogCsv.js';

const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEADER_HINTS = new Set([
  'no',
  'no',
  'category',
  'check',
  'status',
  'priority',
  'effort',
  'description',
  'finding',
  'details',
  'example_urls',
  'data_source',
  'url',
  'title',
  'meta_description',
  'page_type',
  'count',
  'share',
  'note',
  'schema_type',
  'page_count',
  'occurrence',
  'language_region',
  'domain',
  'meaning',
  'avg_ttfb',
  'tested_url',
  'x_cache_cache_control_value',
  'file_name'
]);
const STATUS_VALUES = new Set(['error', 'warning', 'ok', 'manual', 'n/a', 'na']);

export function extractReferenceXlsx(input = {}) {
  const xlsxPath = path.resolve(input.xlsxPath);
  const outDir = path.resolve(input.outDir || path.join(path.dirname(xlsxPath), 'exported-csv'));
  if (!fs.existsSync(xlsxPath)) throw new Error(`XLSX not found: ${xlsxPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workbook = readWorkbook(xlsxPath);
  const sheets = workbook.sheets.map((sheet) => {
    const csvFilename = `${safeFileName(sheet.name)}.csv`;
    const csvPath = path.join(outDir, csvFilename);
    fs.writeFileSync(csvPath, rowsToCsv(sheet.rows), 'utf8');
    const analysis = analyzeSheet(sheet);
    let referenceCsvPath = null;
    if (analysis.useAsReferenceAudit && analysis.headerRow) {
      const referenceFilename = `${safeFileName(sheet.name)}.reference.csv`;
      referenceCsvPath = path.join(outDir, referenceFilename);
      fs.writeFileSync(referenceCsvPath, rowsToCsv(sheet.rows.slice(analysis.headerRow - 1)), 'utf8');
    }
    return {
      ...sheet,
      csvFilename,
      csvPath,
      referenceCsvPath,
      ...analysis
    };
  });
  const usedSheets = sheets.filter((sheet) => sheet.useAsReferenceAudit);
  return {
    xlsxPath,
    outDir,
    generatedAt: new Date().toISOString(),
    workbook: {
      filename: path.basename(xlsxPath),
      sizeBytes: fs.statSync(xlsxPath).size,
      sheetCount: sheets.length
    },
    sheets,
    csvFiles: sheets.map((sheet) => sheet.csvPath),
    referenceCsvPaths: usedSheets.map((sheet) => sheet.referenceCsvPath || sheet.csvPath),
    inventory: buildInventory(xlsxPath, sheets)
  };
}

export function writeSourceInventory(extraction, targetDir = path.dirname(extraction.xlsxPath)) {
  const jsonPath = path.join(targetDir, 'source-inventory.json');
  const mdPath = path.join(targetDir, 'source-inventory.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(extraction.inventory, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderSourceInventoryMarkdown(extraction.inventory), 'utf8');
  return { jsonPath, mdPath };
}

export function renderSourceInventoryMarkdown(inventory = {}) {
  const lines = [
    '# Source Inventory',
    '',
    `Original file: ${inventory.originalFile || ''}`,
    `File size: ${inventory.sizeHuman || inventory.sizeBytes || ''}`,
    `Sheets: ${(inventory.sheets || []).length}`,
    '',
    '| Sheet/CSV | Rows | Columns | Classification | Used | Potential Audit Rows | Reason |',
    '| --- | ---: | ---: | --- | --- | ---: | --- |'
  ];
  for (const sheet of inventory.sheets || []) {
    lines.push(`| ${md(sheet.name)} | ${sheet.rowCount || 0} | ${sheet.columnCount || 0} | ${md(sheet.classification)} | ${sheet.used ? 'yes' : 'no'} | ${sheet.potentialAuditRows || 0} | ${md(sheet.reason || '')} |`);
  }
  lines.push('', '## Used Tables', '');
  const used = (inventory.sheets || []).filter((sheet) => sheet.used);
  if (!used.length) lines.push('- None');
  for (const sheet of used) lines.push(`- ${sheet.name}: ${sheet.potentialAuditRows || 0} potential audit rows`);
  lines.push('', '## Ignored Tables', '');
  const ignored = (inventory.sheets || []).filter((sheet) => !sheet.used);
  if (!ignored.length) lines.push('- None');
  for (const sheet of ignored) lines.push(`- ${sheet.name}: ${sheet.reason || sheet.classification}`);
  return `${lines.join('\n')}\n`;
}

function readWorkbook(xlsxPath) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    preserveOrder: false
  });
  const workbookXml = parser.parse(readZipEntry(xlsxPath, 'xl/workbook.xml'));
  const relsXml = parser.parse(readZipEntry(xlsxPath, 'xl/_rels/workbook.xml.rels'));
  const sharedStrings = readSharedStrings(xlsxPath, parser);
  const relationshipMap = Object.fromEntries(asArray(relsXml.Relationships?.Relationship)
    .map((rel) => [rel['@_Id'], rel['@_Target']]));
  const sheets = asArray(workbookXml.workbook?.sheets?.sheet)
    .map((sheet) => {
      const relId = sheet[`@_xmlns:r`] ? sheet['@_r:id'] : sheet[`@_${OFFICE_REL_NS}:id`] || sheet['@_r:id'];
      const target = relationshipMap[relId] || '';
      const sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
      return {
        name: sheet['@_name'],
        sheetId: sheet['@_sheetId'],
        relId,
        target: sheetPath,
        rows: readWorksheetRows(xlsxPath, sheetPath, sharedStrings, parser)
      };
    });
  return { sheets };
}

function readSharedStrings(xlsxPath, parser) {
  let xml = '';
  try {
    xml = readZipEntry(xlsxPath, 'xl/sharedStrings.xml');
  } catch {
    return [];
  }
  const parsed = parser.parse(xml);
  return asArray(parsed.sst?.si).map((item) => collectText(item));
}

function readWorksheetRows(xlsxPath, sheetPath, sharedStrings, parser) {
  const parsed = parser.parse(readZipEntry(xlsxPath, sheetPath));
  const rows = [];
  for (const row of asArray(parsed.worksheet?.sheetData?.row)) {
    const rowIndex = Number(row['@_r'] || rows.length + 1) - 1;
    const values = [];
    for (const cell of asArray(row.c)) {
      const ref = cell['@_r'] || 'A1';
      const columnIndex = columnIndexFromRef(ref);
      values[columnIndex] = cellValue(cell, sharedStrings);
    }
    rows[rowIndex] = values.map((value) => value ?? '');
  }
  const maxColumns = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  return Array.from({ length: rows.length }, (_, index) => {
    const output = rows[index] || [];
    while (output.length < maxColumns) output.push('');
    return output;
  });
}

function analyzeSheet(sheet) {
  const rows = denseRows(sheet.rows);
  const nonEmptyRows = rows.filter((row) => row.some((value) => String(value || '').trim()));
  const headerRowIndex = findHeaderRowIndex(rows);
  const headers = headerRowIndex === null ? [] : rows[headerRowIndex].map((value) => String(value || '').trim()).filter(Boolean);
  const normalizedHeaders = headers.map(normalizeHeader);
  const potentialAuditRows = countPotentialAuditRows(rows, headerRowIndex);
  const name = String(sheet.name || '').toLowerCase();
  let classification = 'data_appendix';
  let reason = 'Data appendix or supporting table, not the manual audit backlog.';
  let useAsReferenceAudit = false;
  if (/summary|overview/.test(name)) {
    classification = 'summary_or_cover';
    reason = 'Summary/cover sheet, not item-level audit backlog.';
  } else if (/backlog|audit|pruefpunkt|prüfpunkt/.test(name) || (
    normalizedHeaders.includes('check') && normalizedHeaders.includes('status') && normalizedHeaders.includes('priority')
  )) {
    classification = 'reference_audit_table';
    reason = 'Contains item-level manual audit checks with status, priority and evidence fields.';
    useAsReferenceAudit = true;
  } else if (normalizedHeaders.includes('url')) {
    classification = 'data_appendix';
    reason = 'URL-level evidence table used as supporting data, not manual audit point list.';
  }
  return {
    rowCount: nonEmptyRows.length,
    columnCount: Math.max(0, ...rows.map((row) => row.length)),
    headerRow: headerRowIndex === null ? null : headerRowIndex + 1,
    headers,
    normalizedHeaders,
    potentialAuditRows,
    classification,
    reason,
    useAsReferenceAudit
  };
}

function findHeaderRowIndex(rows) {
  for (let index = 0; index < Math.min(rows.length, 50); index += 1) {
    const normalized = (rows[index] || []).map(normalizeHeader).filter(Boolean);
    const hits = normalized.filter((header) => HEADER_HINTS.has(header)).length;
    if (hits >= 2) return index;
  }
  return null;
}

function countPotentialAuditRows(rows, headerRowIndex) {
  if (headerRowIndex === null) return 0;
  let count = 0;
  for (const row of rows.slice(headerRowIndex + 1)) {
    const values = row.map((value) => String(value || '').trim());
    const first = values[0] || '';
    const status = values[3] || '';
    if (/^\d+(\.\d+)+$/.test(first) && STATUS_VALUES.has(status.toLowerCase())) count += 1;
  }
  return count;
}

function denseRows(rows = []) {
  const maxColumns = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  return Array.from({ length: rows.length }, (_, index) => {
    const row = rows[index] || [];
    const output = Array.from({ length: maxColumns }, (_, columnIndex) => row[columnIndex] ?? '');
    return output;
  });
}

function buildInventory(xlsxPath, sheets) {
  const stat = fs.statSync(xlsxPath);
  return {
    generatedAt: new Date().toISOString(),
    originalFile: xlsxPath,
    filename: path.basename(xlsxPath),
    type: 'xlsx',
    sizeBytes: stat.size,
    sizeHuman: humanBytes(stat.size),
    sheets: sheets.map((sheet) => ({
      name: sheet.name,
      csvPath: sheet.csvPath,
      referenceCsvPath: sheet.referenceCsvPath,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      headerRow: sheet.headerRow,
      headers: sheet.headers,
      classification: sheet.classification,
      used: sheet.useAsReferenceAudit,
      reason: sheet.reason,
      potentialAuditRows: sheet.potentialAuditRows
    }))
  };
}

function rowsToCsv(rows) {
  return rows
    .filter((row) => row.some((value) => String(value || '').trim()))
    .map((row) => `${row.map(csvEscape).join(',')}\n`)
    .join('');
}

function readZipEntry(xlsxPath, entry) {
  const result = spawnSync('unzip', ['-p', xlsxPath, entry], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`Unable to read ${entry} from XLSX: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function cellValue(cell, sharedStrings) {
  const type = cell['@_t'];
  const value = cell.v;
  if (type === 's') return sharedStrings[Number(value)] || '';
  if (type === 'inlineStr') return collectText(cell.is);
  if (value === undefined || value === null) return '';
  return String(value);
}

function collectText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(collectText).join('');
  if (typeof value !== 'object') return '';
  let output = '';
  if (value.t !== undefined) output += collectText(value.t);
  if (value.r !== undefined) output += collectText(value.r);
  if (value['#text'] !== undefined) output += String(value['#text']);
  for (const [key, nested] of Object.entries(value)) {
    if (['t', 'r', '#text'].includes(key) || key.startsWith('@_')) continue;
    output += collectText(nested);
  }
  return output;
}

function columnIndexFromRef(ref = 'A1') {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeFileName(value) {
  return String(value || 'sheet')
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sheet';
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024 || unit === units[units.length - 1]) return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
    amount /= 1024;
  }
  return `${Math.round(value)} B`;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
