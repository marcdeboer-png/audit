import fs from 'node:fs';
import { createProject, createRun, insertImportFileSummary, insertPage, logRun, replacePageArtifacts, updateProject, updateRun } from '../../db/repositories.js';
import { normalizeAuditConfig } from '../../crawler/auditRunner.js';
import { buildTemplateClusters } from '../../analysis/templateClusterer.js';
import { runChecks } from '../../checks/checkEngine.js';
import { generateReport } from '../../reports/reportGenerator.js';
import { nowIso } from '../../utils/time.js';
import { normalizeUrl } from '../../utils/url.js';
import { pageRecordFromFact, mergeFacts } from '../../facts/urlFacts.js';
import { filterArtifactsForStorage } from '../../storage/retention.js';
import { storeBenchmarkSummary } from '../../analysis/benchmarkSummary.js';
import { parseScreamingFrogCsv } from './parseScreamingFrogCsv.js';
import { detectScreamingFrogExport, expectedScreamingFrogExportTypes } from './detectScreamingFrogExport.js';
import { ignoredColumns, mappedFields, mapScreamingFrogRow } from './screamingFrogMappings.js';

export async function importScreamingFrogAudit(db, input = {}) {
  const files = await loadImportFiles(input);
  if (!files.length) throw new Error('At least one Screaming Frog CSV file is required.');

  const factsByUrl = new Map();
  const linksByPage = new Map();
  const imagesByPage = new Map();
  const fileSummaries = [];
  const warnings = [];
  const detectedTypes = new Set();

  for (const file of files) {
    const parsed = parseScreamingFrogCsv(file.content);
    const detection = detectScreamingFrogExport(parsed.headers, file.filename);
    detectedTypes.add(detection.type);
    const ignored = ignoredColumns(parsed.headers);
    const mapped = mappedFields(parsed.headers);
    const fileWarnings = [];
    if (detection.type === 'unknown') fileWarnings.push('Export type could not be detected confidently.');
    if (!parsed.rows.length) fileWarnings.push('CSV contained no data rows.');

    for (const row of parsed.rows) {
      const mappedRow = mapScreamingFrogRow(row, detection.type);
      if (!mappedRow) continue;
      if (mappedRow.fact?.url) {
        factsByUrl.set(mappedRow.fact.url, mergeFacts(factsByUrl.get(mappedRow.fact.url), mappedRow.fact));
      }
      if (mappedRow.artifact === 'link' && mappedRow.sourceUrl && mappedRow.targetUrl) {
        pushMap(linksByPage, mappedRow.sourceUrl, mappedRow);
      }
      if (mappedRow.artifact === 'image' && mappedRow.image?.pageUrl && mappedRow.image?.imageUrl) {
        pushMap(imagesByPage, mappedRow.image.pageUrl, mappedRow.image);
      }
    }

    fileSummaries.push({
      filename: file.filename,
      exportType: detection.type,
      exportLabel: detection.label,
      confidence: detection.confidence,
      rowCount: parsed.rows.length,
      mappedFields: mapped,
      ignoredColumns: ignored,
      warnings: fileWarnings
    });
    warnings.push(...fileWarnings.map((message) => `${file.filename}: ${message}`));
  }

  const firstUrl = [...factsByUrl.keys()][0] || firstUrlFromArtifacts(linksByPage, imagesByPage);
  const domain = String(input.domain || inferDomain(firstUrl) || '').trim();
  if (!domain) throw new Error('domain is required when no URL could be inferred from the import.');

  const config = normalizeAuditConfig({
    ...input,
    domain,
    sourceType: 'screaming_frog_import',
    usePlaywright: false,
    playwrightMode: 'off',
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false,
    maxUrls: Math.max(1, Number(input.maxUrls || factsByUrl.size || 1)),
    storageProfile: input.storageProfile || 'standard'
  });

  const projectId = createProject(db, {
    inputDomain: domain,
    brandName: input.brandName || null
  });
  const runId = createRun(db, projectId, config);
  const finalDomain = inferDomain(firstUrl) || normalizeFinalDomain(domain);
  updateProject(db, projectId, { finalDomain });
  updateRun(db, runId, {
    status: 'running',
    currentPhase: 'importing',
    startedAt: nowIso()
  });
  logRun(db, runId, 'info', 'Screaming Frog import started', { files: files.length });

  for (const fileSummary of fileSummaries) {
    insertImportFileSummary(db, runId, fileSummary);
  }

  const run = { ...config, id: runId };
  for (const [url, fact] of factsByUrl.entries()) {
    const pageRecord = pageRecordFromFact(runId, fact);
    insertPage(db, pageRecord);
    const links = (linksByPage.get(url) || []).map((link) => ({ ...link, runId }));
    const images = imagesByPage.get(url) || [];
    replacePageArtifacts(db, runId, pageRecord.finalUrl || pageRecord.normalizedUrl, filterArtifactsForStorage(run, {
      links,
      images,
      resources: [],
      schemas: []
    }));
  }

  const importedUrls = factsByUrl.size;
  updateRun(db, runId, {
    discoveredUrls: importedUrls,
    processedUrls: importedUrls,
    successfulUrls: importedUrls,
    failedUrls: 0,
    skippedUrls: 0,
    currentPhase: 'clustering'
  });

  const clusterSummary = buildTemplateClusters(db, runId, {
    sampleUrlsPerTemplate: config.sampleUrlsPerTemplate,
    maxTemplateSamplesTotal: config.maxTemplateSamplesTotal
  });
  logRun(db, runId, 'info', 'Template clusters built for import', clusterSummary);

  updateRun(db, runId, { currentPhase: 'checking' });
  await runChecks(db, runId);

  const missingExpectedExports = expectedScreamingFrogExportTypes().filter((type) => !detectedTypes.has(type));
  const summary = {
    importer: 'screaming_frog',
    sourceType: 'screaming_frog_import',
    filesImported: fileSummaries.length,
    detectedExportTypes: [...detectedTypes].sort(),
    urlsTotal: importedUrls,
    mappedFields: [...new Set(fileSummaries.flatMap((file) => file.mappedFields))].sort(),
    ignoredColumns: [...new Set(fileSummaries.flatMap((file) => file.ignoredColumns))].sort(),
    warnings,
    missingExpectedExports,
    files: fileSummaries
  };

  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    importSummaryJson: JSON.stringify(summary),
    finishedAt: nowIso()
  });
  storeBenchmarkSummary(db, runId);
  generateReport(db, runId);
  logRun(db, runId, 'info', 'Screaming Frog import completed', summary);
  return { runId, projectId, summary };
}

async function loadImportFiles(input) {
  const files = [];
  if (Array.isArray(input.files)) {
    for (const file of input.files) {
      if (file?.content !== undefined) {
        files.push({
          filename: file.filename || file.name || `screaming-frog-${files.length + 1}.csv`,
          content: String(file.content || '')
        });
      }
    }
  }
  if (input.filePath) {
    const content = fs.readFileSync(input.filePath, 'utf8');
    files.push({ filename: input.filePath.split(/[\\/]/).pop(), content });
  }
  return files;
}

function pushMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function firstUrlFromArtifacts(...maps) {
  for (const map of maps) {
    for (const key of map.keys()) return key;
  }
  return null;
}

function inferDomain(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function normalizeFinalDomain(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return value;
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return value;
  }
}
