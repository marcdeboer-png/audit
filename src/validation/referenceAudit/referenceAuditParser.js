import fs from 'node:fs';
import path from 'node:path';
import { normalizeHeader, parseScreamingFrogCsv } from '../../importers/screamingFrog/parseScreamingFrogCsv.js';
import { normalizeReferenceAuditItem, normalizeList, text } from './referenceAuditModel.js';

const FIELD_ALIASES = {
  id: ['id', 'audit id', 'audit_id', 'item id', 'pruefpunkt id', 'prüfpunkt id', 'check id', 'check_id', 'nr', 'nummer'],
  title: ['title', 'titel', 'topic', 'thema', 'issue', 'audit point', 'audit_point', 'pruefpunkt', 'prüfpunkt', 'pruefpunkt thema', 'prüfpunkt thema', 'prüfpunkt / thema', 'check', 'beobachtung', 'problemfeld', 'handlungsfeld'],
  description: ['description', 'beschreibung', 'details', 'finding', 'finding details', 'problem', 'befund', 'issue description', 'beschreibung / evidence', 'beschreibung/evidence', 'analyse', 'feststellung'],
  category: ['category', 'kategorie', 'area', 'bereich', 'pillar', 'kapitel', 'source', 'datenquelle', 'data source', 'audit bereich', 'modul'],
  severity: ['severity', 'schweregrad', 'impact', 'auswirkung', 'risiko', 'risk', 'business impact'],
  priority: ['priority', 'prioritaet', 'priorität', 'prio', 'p', 'relevanz', 'gewichtung'],
  effort: ['effort', 'aufwand', 'implementation effort', 'umsetzungsaufwand'],
  status: ['status', 'state', 'zustand', 'bewertung', 'ampel', 'result'],
  affectedUrls: ['affected urls', 'affectedurls', 'urls', 'url samples', 'sample urls', 'example urls', 'beispiel urls', 'betroffene urls', 'url', 'beispiele', 'beispielseiten', 'sample pages'],
  affectedCount: ['affected count', 'affectedcount', 'url count', 'anzahl urls', 'betroffene anzahl', 'count', 'anzahl', 'umfang', 'reichweite'],
  evidence: ['evidence', 'details', 'finding', 'beleg', 'proof', 'nachweis', 'example', 'beispiel', 'screenshot', 'evidenz', 'quelle', 'source note'],
  recommendation: ['recommendation', 'empfehlung', 'action', 'massnahme', 'maßnahme', 'todo', 'solution', 'empfohlene massnahme', 'empfohlene maßnahme', 'next step'],
  notes: ['notes', 'notizen', 'comment', 'comments', 'kommentar', 'anmerkung', 'hinweis'],
  expectedToolCheckIds: ['expected tool check ids', 'expected check ids', 'tool check ids', 'check ids', 'checkid', 'check ids expected'],
  expectedDataSources: ['expected data sources', 'data sources', 'data source', 'datenquellen', 'datenquelle', 'required data', 'quelle'],
  requiresExternalData: ['requires external data', 'external data', 'braucht externe daten'],
  requiresHumanJudgment: ['requires human judgment', 'human review', 'menschliche bewertung', 'human judgment'],
  requiresLlmJudgment: ['requires llm judgment', 'llm review', 'ki bewertung', 'llm judgment'],
  sourceSheet: ['sheet', 'source sheet', 'arbeitsblatt', 'tab']
};

const NORMALIZED_ALIASES = Object.fromEntries(
  Object.entries(FIELD_ALIASES).map(([field, aliases]) => [field, aliases.map(normalizeHeader)])
);

export function parseReferenceAuditFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, isLikelyBinary(filePath) ? null : 'utf8');
  return parseReferenceAuditInput({
    filename: path.basename(filePath),
    content,
    format: options.format || formatFromFilename(filePath),
    sourceFile: options.sourceFile || filePath,
    sourceSheet: options.sourceSheet
  });
}

export function parseReferenceAuditFiles(filePaths = [], options = {}) {
  const files = Array.isArray(filePaths) ? filePaths : [filePaths];
  return mergeReferenceAudits(files.map((filePath) => parseReferenceAuditFile(filePath, {
    ...options,
    sourceSheet: options.sourceSheet || sheetNameFromFilename(filePath)
  })));
}

export function parseReferenceAuditInputs(inputs = []) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  return mergeReferenceAudits(list.map((input) => parseReferenceAuditInput(input)));
}

export function parseReferenceAuditInput(input = {}) {
  const filename = input.filename || input.sourceFile || 'reference-audit';
  const format = normalizeFormat(input.format || formatFromFilename(filename));
  if (format === 'xlsx') {
    throw new Error('XLSX reference audits are not supported in this build. Export the Excel sheet to CSV or create a JSON reference file.');
  }
  if (format === 'json') return parseJsonReference(input);
  if (format === 'csv' || format === 'txt') return parseCsvReference(input);
  throw new Error(`Unsupported reference audit format "${format}". Supported formats: CSV and JSON.`);
}

function parseJsonReference(input) {
  const parsed = typeof input.content === 'string'
    ? JSON.parse(input.content)
    : JSON.parse(Buffer.from(input.content || '').toString('utf8'));
  const source = Array.isArray(parsed) ? { items: parsed } : parsed;
  const items = (source.items || source.manualItems || source.referenceItems || [])
    .map((row, index) => normalizeReferenceAuditItem(row, {
      sourceFile: input.sourceFile || input.filename,
      sourceSheet: row.sourceSheet || input.sourceSheet || source.sourceSheet || null,
      originalRow: row.originalRow || index + 1
    }));
  return buildReferenceAudit({
    filename: input.filename,
    format: 'json',
    source,
    items,
    ignoredRows: source.ignoredRows || [],
    importSummary: source.importSummary || {
      files: [fileSummary(input.filename, 'json', items.length, 0)],
      totalRowsRead: items.length,
      importedRows: items.length,
      ignoredRows: 0,
      mappedFields: Object.keys(FIELD_ALIASES),
      ignoredColumns: [],
      sourceSheets: [...new Set(items.map((item) => item.sourceSheet).filter(Boolean))]
    },
    warnings: items.length ? [] : ['JSON reference audit contained no items.']
  });
}

function parseCsvReference(input) {
  const parsed = parseScreamingFrogCsv(input.content);
  const warnings = [];
  if (!parsed.headers.length) warnings.push('CSV reference audit had no headers.');
  const mappedFields = mappedFieldsForHeaders(parsed.headers);
  const ignoredColumns = parsed.headers.filter((header) => !mappedFields.some((entry) => entry.header === header));
  const ignoredRows = [];
  const items = [];
  parsed.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const normalizedRow = rowFromCsv(row);
    const ignoredReason = ignoredRowReason(row, normalizedRow);
    if (ignoredReason) {
      ignoredRows.push({
        sourceFile: input.sourceFile || input.filename,
        sourceSheet: input.sourceSheet || valueFor(row, 'sourceSheet') || null,
        originalRow: rowNumber,
        reason: ignoredReason,
        preview: Object.values(row).map(text).filter(Boolean).slice(0, 3).join(' | ')
      });
      return;
    }
    items.push(normalizeReferenceAuditItem(normalizedRow, {
      sourceFile: input.sourceFile || input.filename,
      sourceSheet: input.sourceSheet || valueFor(row, 'sourceSheet') || null,
      originalRow: rowNumber
    }));
  });
  return buildReferenceAudit({
    filename: input.filename,
    format: 'csv',
    source: { headers: parsed.headers, delimiter: parsed.delimiter },
    items,
    ignoredRows,
    importSummary: {
      files: [fileSummary(input.filename, 'csv', items.length, ignoredRows.length, parsed.rows.length)],
      totalRowsRead: parsed.rows.length,
      importedRows: items.length,
      ignoredRows: ignoredRows.length,
      mappedFields,
      ignoredColumns,
      sourceSheets: [...new Set(items.map((item) => item.sourceSheet).filter(Boolean))]
    },
    warnings
  });
}

function rowFromCsv(row) {
  const output = { raw: row };
  for (const field of Object.keys(FIELD_ALIASES)) {
    output[field] = valueFor(row, field);
  }
  if (!output.title) {
    const firstValue = Object.values(row).find((value) => text(value));
    output.title = firstValue || '';
  }
  output.expectedToolCheckIds = normalizeList(output.expectedToolCheckIds);
  output.expectedDataSources = normalizeList(output.expectedDataSources);
  return output;
}

function ignoredRowReason(row, normalizedRow) {
  const values = Object.values(row || {}).map(text).filter(Boolean);
  if (!values.length) return 'empty_row';
  const title = text(normalizedRow.title);
  const searchable = values.join(' ').toLowerCase();
  const hasUsefulDetail = [
    normalizedRow.description,
    normalizedRow.evidence,
    normalizedRow.recommendation,
    normalizedRow.affectedUrls,
    normalizedRow.expectedToolCheckIds
  ].some((value) => Array.isArray(value) ? value.length : text(value));
  if (values.length === 1 && (isSectionHeading(values[0]) || /^\d+\.\s+\S/.test(values[0]))) return 'section_heading';
  if (!hasUsefulDetail && isHeaderLikeTitle(title)) return 'header_or_legend_row';
  if (!hasUsefulDetail && /^(legende|legend|summary|zusammenfassung|agenda|inhaltsverzeichnis|table of contents)$/i.test(searchable)) {
    return 'metadata_row';
  }
  return null;
}

function isSectionHeading(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^(technical seo|technik|technisches seo|html head|content|performance|core web vitals|strukturierte daten|structured data|security|geo|ai search|trust|e-e-a-t|eeat|overview|zusammenfassung|fazit|roadmap|priorisierung)$/.test(normalized);
}

function isHeaderLikeTitle(value) {
  const normalized = normalizeHeader(value);
  return [
    'title',
    'titel',
    'topic',
    'thema',
    'issue',
    'finding',
    'check',
    'audit_point',
    'pruefpunkt',
    'pruefpunkt_thema',
    'category',
    'kategorie'
  ].includes(normalized);
}

function valueFor(row, field) {
  const normalizedRow = {};
  for (const [key, value] of Object.entries(row || {})) {
    normalizedRow[normalizeHeader(key)] = value;
  }
  for (const alias of NORMALIZED_ALIASES[field] || [field]) {
    const value = normalizedRow[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function buildReferenceAudit({ filename, format, source, items, ignoredRows = [], importSummary = null, warnings = [] }) {
  const summary = importSummary || {
    files: [fileSummary(filename, format, items.length, ignoredRows.length)],
    totalRowsRead: items.length + ignoredRows.length,
    importedRows: items.length,
    ignoredRows: ignoredRows.length,
    mappedFields: [],
    ignoredColumns: [],
    sourceSheets: [...new Set(items.map((item) => item.sourceSheet).filter(Boolean))]
  };
  return {
    format,
    filename: filename || null,
    source,
    itemCount: items.length,
    items,
    ignoredRows,
    importSummary: summary,
    warnings,
    parser: {
      supportedFormats: ['csv', 'json'],
      xlsxSupport: 'not_available_export_excel_to_csv_or_json'
    }
  };
}

function mergeReferenceAudits(audits = []) {
  const items = audits.flatMap((audit) => audit.items || []);
  const ignoredRows = audits.flatMap((audit) => audit.ignoredRows || []);
  const warnings = audits.flatMap((audit) => audit.warnings || []);
  const files = audits.flatMap((audit) => audit.importSummary?.files || [fileSummary(audit.filename, audit.format, audit.items?.length || 0, audit.ignoredRows?.length || 0)]);
  const mappedFields = mergeMappedFields(audits.flatMap((audit) => audit.importSummary?.mappedFields || []));
  const ignoredColumns = [...new Set(audits.flatMap((audit) => audit.importSummary?.ignoredColumns || []))];
  const sourceSheets = [...new Set(audits.flatMap((audit) => audit.importSummary?.sourceSheets || []).filter(Boolean))];
  const formats = [...new Set(audits.map((audit) => audit.format).filter(Boolean))];
  return buildReferenceAudit({
    filename: files.map((file) => file.filename).filter(Boolean).join(', ') || 'reference-audit',
    format: formats.length === 1 ? formats[0] : 'mixed',
    source: { files },
    items,
    ignoredRows,
    importSummary: {
      files,
      totalRowsRead: files.reduce((sum, file) => sum + Number(file.rowsRead || 0), 0),
      importedRows: items.length,
      ignoredRows: ignoredRows.length,
      mappedFields,
      ignoredColumns,
      sourceSheets
    },
    warnings
  });
}

function mappedFieldsForHeaders(headers = []) {
  const rows = [];
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const field = Object.entries(NORMALIZED_ALIASES)
      .find(([, aliases]) => aliases.includes(normalized))?.[0];
    if (field) rows.push({ field, header });
  }
  return rows;
}

function mergeMappedFields(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.field}:${row.header}`;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function fileSummary(filename, format, importedRows, ignoredRows, rowsRead = null) {
  return {
    filename: filename || null,
    format,
    rowsRead: rowsRead ?? (Number(importedRows || 0) + Number(ignoredRows || 0)),
    importedRows: Number(importedRows || 0),
    ignoredRows: Number(ignoredRows || 0)
  };
}

function sheetNameFromFilename(filePath = '') {
  const basename = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  return basename || null;
}

function normalizeFormat(format) {
  const value = String(format || '').toLowerCase().replace(/^\./, '');
  if (['csv', 'json', 'xlsx', 'xls', 'txt'].includes(value)) return value === 'xls' ? 'xlsx' : value;
  return value || 'csv';
}

function formatFromFilename(filename = '') {
  const ext = path.extname(String(filename || '')).toLowerCase().replace(/^\./, '');
  return ext || 'csv';
}

function isLikelyBinary(filePath) {
  return ['.xlsx', '.xls'].includes(path.extname(String(filePath || '')).toLowerCase());
}
