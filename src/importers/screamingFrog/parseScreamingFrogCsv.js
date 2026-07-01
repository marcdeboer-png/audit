export function parseScreamingFrogCsv(content, options = {}) {
  const text = stripBom(String(content || ''));
  const delimiter = options.delimiter || detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { headers: [], rows: [], delimiter };
  const headers = rows[0].map((header) => String(header || '').trim());
  const dataRows = rows.slice(1)
    .filter((row) => row.some((value) => String(value || '').trim() !== ''))
    .map((row) => {
      const output = {};
      headers.forEach((header, index) => {
        output[header] = row[index] ?? '';
      });
      return output;
    });
  return { headers, rows: dataRows, delimiter };
}

export function normalizeHeader(header) {
  return String(header || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[’']/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ',';
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(trimCarriage(field));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  row.push(trimCarriage(field));
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function trimCarriage(value) {
  return String(value || '').replace(/\r$/, '');
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '');
}
