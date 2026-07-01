import fs from 'node:fs';
import path from 'node:path';
import { csvEscape } from '../../reports/csvExporter.js';
import { renderStorageRealityMarkdown } from '../../analysis/storageRealityCheck.js';

export function buildValidationExportPayload(report) {
  const coverageCsv = coverageMatrixCsv(report.coverageMatrix || []);
  return {
    'executive-validation-summary.md': renderExecutiveSummaryMarkdown(report),
    'chef-demo-summary.md': renderChefDemoSummaryMarkdown(report.chefDemoSummary || {}),
    'validation-report.html': renderValidationHtml(report),
    'validation-report.md': renderValidationMarkdown(report),
    'coverage-matrix.csv': coverageCsv,
    'coverage-matrix.json': `${JSON.stringify(report.coverageMatrix || [], null, 2)}\n`,
    'reference-import-summary.md': renderReferenceImportSummaryMarkdown(report.referenceImportSummary || report.referenceAudit?.importSummary || {}),
    'reference-import-summary.json': `${JSON.stringify(report.referenceImportSummary || report.referenceAudit?.importSummary || {}, null, 2)}\n`,
    'mapping-confidence-summary.json': `${JSON.stringify(report.mappingConfidenceSummary || {}, null, 2)}\n`,
    'false-negatives.md': renderFalseNegativesMarkdown(report.falseNegativeCandidates || []),
    'false-positives.md': renderFalsePositivesMarkdown(report.falsePositiveCandidates || []),
    'tool-extra-findings.md': renderToolExtrasMarkdown(report.unmatchedToolFindings || []),
    'tool-extra-findings.json': `${JSON.stringify(report.unmatchedToolFindings || [], null, 2)}\n`,
    'tool-gap-backlog.md': renderBacklogMarkdown(report.nextCheckBacklog || []),
    'tool-gap-backlog.json': `${JSON.stringify(report.nextCheckBacklog || [], null, 2)}\n`,
    'check-roadmap.md': renderRoadmapMarkdown(report.checkRoadmap || []),
    'check-roadmap.json': `${JSON.stringify(report.checkRoadmap || [], null, 2)}\n`,
    'score-calibration-notes.md': renderScoreCalibrationNotesMarkdown(report.scoreCalibrationNotes || []),
    'validation-summary.json': `${JSON.stringify(report.validationSummary || {}, null, 2)}\n`,
    'benchmark-summary.json': `${JSON.stringify(report.benchmarkSummary || {}, null, 2)}\n`,
    'storage-reality-check.md': renderStorageRealityMarkdown(report.storageRealityCheck || report.benchmarkSummary?.storageRealityCheck || {}),
    'storage-reality-check.json': `${JSON.stringify(report.storageRealityCheck || report.benchmarkSummary?.storageRealityCheck || {}, null, 2)}\n`
  };
}

export function writeValidationExports(report, outDir) {
  const targetDir = outDir || path.join(process.cwd(), 'reports', `validation-run-${report.runId}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const files = buildValidationExportPayload(report);
  const outputs = {};
  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    outputs[filename] = filePath;
  }
  return { outputDir: targetDir, files: outputs };
}

export function coverageMatrixCsv(rows = []) {
  const columns = [
    'manualItemId',
    'title',
    'category',
    'priority',
    'coverageStatus',
    'confidence',
    'matchedCheckId',
    'matchScore',
    'urlOverlap',
    'affectedCount',
    'expectedCheckIds',
    'requiredData',
    'rationale'
  ];
  const lines = [`${columns.map(csvEscape).join(',')}\n`];
  for (const row of rows) {
    const item = row.manualItem || {};
    const output = {
      manualItemId: row.manualItemId,
      title: item.title || '',
      category: item.category || '',
      priority: item.priority || '',
      coverageStatus: row.coverageStatus,
      confidence: row.confidence,
      matchedCheckId: row.matchedCheckId || '',
      matchScore: row.matchScore || 0,
      urlOverlap: row.urlOverlap || 0,
      affectedCount: item.affectedCount ?? '',
      expectedCheckIds: (row.expectedCheckIds || []).join('|'),
      requiredData: (row.requiredData || []).join('|'),
      rationale: row.rationale || ''
    };
    lines.push(`${columns.map((column) => csvEscape(output[column])).join(',')}\n`);
  }
  return lines.join('');
}

export function renderValidationMarkdown(report) {
  const summary = report.validationSummary || {};
  const lines = [
    `# Enterprise Validation Report - Run ${report.runId}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Manual audit points: ${summary.manualItemCount || 0}`,
    `- Covered: ${summary.covered || 0}`,
    `- Partially covered: ${summary.partiallyCovered || 0}`,
    `- Not covered: ${summary.notCovered || 0}`,
    `- Needs external data: ${summary.needsExternalData || 0}`,
    `- Needs larger crawl: ${summary.needsLargerCrawl || 0}`,
    `- Needs human review: ${summary.needsHumanReview || 0}`,
    `- Needs LLM review: ${summary.needsLlmReview || 0}`,
    `- Tool extras: ${summary.toolExtras || 0}`,
    `- Estimated coverage: ${summary.coveragePercent ?? 0}%`,
    `- Data basis: ${summary.dataBasisLabel || report.executiveValidationSummary?.sampleNote || 'n/a'}`,
    '',
    '## Data Basis',
    '',
    report.executiveValidationSummary?.sampleNote || 'No data-basis note available.',
    '',
    '## Top Covered',
    '',
    ...topCoverageLines(report.coverageMatrix, 'covered'),
    '',
    '## Top Partial',
    '',
    ...topCoverageLines(report.coverageMatrix, 'partially_covered'),
    '',
    '## Top Gaps',
    '',
    ...topCoverageLines(report.coverageMatrix, ['not_covered', 'false_negative_candidate', 'needs_external_data', 'needs_larger_crawl', 'needs_human_review', 'needs_llm_review']),
    '',
    '## Needs Bigger Data Basis',
    '',
    ...topCoverageLines(report.coverageMatrix, 'needs_larger_crawl'),
    '',
    '## What The Tool Finds Beyond The Manual Audit',
    '',
    ...topToolExtraLines(report.unmatchedToolFindings),
    '',
    '## Next Automation Steps',
    '',
    ...nextAutomationLines(report.checkRoadmap),
    '',
    '## Coverage Matrix',
    '',
    '| Manual Item | Status | Confidence | Matched Check | Rationale |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const row of (report.coverageMatrix || []).slice(0, 200)) {
    lines.push(`| ${md(row.manualItem?.title || row.manualItemId)} | ${md(row.coverageStatus)} | ${md(row.confidence)} | ${md(row.matchedCheckId || '')} | ${md(row.rationale || '')} |`);
  }
  lines.push('', '## Tool Extras', '');
  for (const extra of report.unmatchedToolFindings || []) {
    lines.push(`- **${md(extra.checkId)}** (${md(extra.extraClassification)}): ${md(extra.finding || extra.title || '')}`);
  }
  lines.push(
    '',
    '## False Negatives / Manual Gaps',
    '',
    renderFalseNegativesMarkdown(report.falseNegativeCandidates || []),
    '',
    '## Gap Backlog',
    '',
    renderBacklogMarkdown(report.nextCheckBacklog || [])
  );
  return `${lines.join('\n')}\n`;
}

function topCoverageLines(rows = [], statuses = [], limit = 8) {
  const statusSet = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  const selected = (rows || [])
    .filter((row) => statusSet.has(row.coverageStatus))
    .slice(0, limit);
  if (!selected.length) return ['- None'];
  return selected.map((row) => `- **${md(row.manualItem?.title || row.manualItemId)}** (${md(row.coverageStatus)}, ${md(row.confidence)}): ${md(row.rationale || '')}`);
}

function topToolExtraLines(rows = [], limit = 8) {
  const selected = (rows || [])
    .filter((row) => ['likely_relevant', 'needs_review', 'low_priority'].includes(row.extraClassification))
    .slice(0, limit);
  if (!selected.length) return ['- No tool-only findings ready for review.'];
  return selected.map((row) => `- **${md(row.checkId)}** (${md(row.extraClassification)}): ${md(row.finding || row.title || '')}`);
}

function nextAutomationLines(rows = [], limit = 8) {
  const selected = (rows || []).slice(0, limit);
  if (!selected.length) return ['- No roadmap items generated.'];
  return selected.map((row) => `- **${md(row.title)}** (${md(row.roadmapCategory || '')}): ${md(row.suggestedImplementation || '')}`);
}

export function renderBacklogMarkdown(backlog = []) {
  if (!backlog.length) return 'No backlog items generated.\n';
  return `${backlog.map((item) => [
    `### ${item.gapId}: ${item.title}`,
    '',
    `- Type: ${item.gapType}`,
    `- Category: ${item.category}`,
    `- Priority: ${item.priority}`,
    `- Possible check: ${item.possibleCheckId || 'TBD'}`,
    `- Effort: ${item.estimatedEffort}`,
    `- Impact: ${item.expectedImpact}`,
    `- Required data: ${(item.requiredData || []).join(', ') || 'none'}`,
    `- Suggested implementation: ${item.suggestedImplementation}`,
    item.notes ? `- Notes: ${item.notes}` : ''
  ].filter(Boolean).join('\n')).join('\n\n')}\n`;
}

export function renderExecutiveSummaryMarkdown(report) {
  const summary = report.executiveValidationSummary || {};
  const validation = report.validationSummary || {};
  const lines = [
    `# Executive Validation Summary - Run ${report.runId}`,
    '',
    summary.answer || 'No validation summary available.',
    '',
    '## Key Numbers',
    '',
    `- Manual audit points: ${validation.manualItemCount || 0}`,
    `- Weighted coverage: ${validation.coveragePercent ?? 0}%`,
    `- Full or partial coverage: ${summary.fullOrPartialCoverage ?? 0}`,
    `- Gaps to close: ${summary.gapsToClose ?? 0}`,
    `- External/review-dependent points: ${summary.externalOrReviewDependent ?? 0}`,
    `- Needs larger crawl: ${validation.needsLargerCrawl || 0}`,
    `- Tool-only findings: ${summary.toolExtras ?? 0}`,
    `- False-positive candidates: ${summary.falsePositiveCandidates ?? 0}`,
    `- Storage risk: ${summary.storageRiskLevel || 'unknown'}`,
    `- Data basis: ${validation.dataBasisLabel || summary.sampleNote || 'n/a'}`,
    '',
    '## Most Important Gaps',
    ''
  ];
  const gaps = summary.mostImportantGaps || [];
  if (!gaps.length) lines.push('- No high-priority gap identified in this report.');
  for (const gap of gaps) {
    lines.push(`- **${md(gap.title)}** (${md(gap.gapType)}): ${md(gap.suggestedImplementation)}`);
  }
  lines.push('', '## Management Message', '', summary.managementMessage || '');
  return `${lines.join('\n')}\n`;
}

export function renderChefDemoSummaryMarkdown(summary = {}) {
  const lines = [
    '# Chef-Demo Summary',
    '',
    summary.headline || 'No chef-demo summary available.',
    '',
    '## Talking Points',
    ''
  ];
  for (const point of summary.talkingPoints || []) lines.push(`- ${point}`);
  lines.push('', '## Top Tool Extras', '');
  const extras = summary.topToolExtras || [];
  if (!extras.length) lines.push('- No high-signal tool extras ready for demo without review.');
  for (const extra of extras) {
    lines.push(`- **${md(extra.checkId)}**: ${md(extra.title)} (${extra.affectedCount || 0} affected, ${md(extra.priority || '')})`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderReferenceImportSummaryMarkdown(summary = {}) {
  const lines = [
    '# Reference Import Summary',
    '',
    `- Files: ${(summary.files || []).length}`,
    `- Rows read: ${summary.totalRowsRead || 0}`,
    `- Imported audit points: ${summary.importedRows || 0}`,
    `- Ignored rows: ${summary.ignoredRows || 0}`,
    `- Source sheets: ${(summary.sourceSheets || []).join(', ') || 'n/a'}`,
    '',
    '## Files',
    '',
    '| File | Format | Rows Read | Imported | Ignored |',
    '| --- | --- | ---: | ---: | ---: |'
  ];
  for (const file of summary.files || []) {
    lines.push(`| ${md(file.filename || '')} | ${md(file.format || '')} | ${file.rowsRead || 0} | ${file.importedRows || 0} | ${file.ignoredRows || 0} |`);
  }
  lines.push('', '## Mapped Fields', '');
  for (const field of summary.mappedFields || []) {
    lines.push(`- ${md(field.field || field)}${field.header ? ` <= ${md(field.header)}` : ''}`);
  }
  lines.push('', '## Ignored Columns', '');
  if (!(summary.ignoredColumns || []).length) lines.push('- None');
  for (const column of summary.ignoredColumns || []) lines.push(`- ${md(column)}`);
  return `${lines.join('\n')}\n`;
}

export function renderFalseNegativesMarkdown(rows = []) {
  if (!rows.length) return 'No false-negative/manual-gap candidates.\n';
  const lines = ['# False Negative Candidates', '', '| Manual Item | Status | Confidence | Expected Checks | Rationale |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| ${md(row.manualItem?.title || row.manualItemId)} | ${md(row.coverageStatus)} | ${md(row.confidence)} | ${md((row.expectedCheckIds || []).join(', '))} | ${md(row.rationale || '')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderFalsePositivesMarkdown(rows = []) {
  if (!rows.length) return 'No false-positive candidates.\n';
  const lines = ['# False Positive Candidates', '', '| Check | Class | Priority | Affected | Reason | Suggested Action |', '| --- | --- | --- | ---: | --- | --- |'];
  for (const row of rows) {
    const check = row.checkId || row.matchedCheckId || row.toolFinding?.checkId || row.manualItem?.title || row.manualItemId;
    const classification = row.extraClassification || row.coverageStatus || 'false_positive_candidate';
    const priority = row.priority || row.manualItem?.priority || row.toolFinding?.priority || '';
    const affected = row.affectedCount || row.toolFinding?.affectedCount || row.manualItem?.affectedCount || 0;
    const reason = row.reason || row.rationale || '';
    const action = row.suggestedAction || 'Review whether the tool warning is stricter than the manual audit or needs threshold calibration.';
    lines.push(`| ${md(check)} | ${md(classification)} | ${md(priority)} | ${affected} | ${md(reason)} | ${md(action)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderToolExtrasMarkdown(rows = []) {
  if (!rows.length) return '# Tool Extra Findings\n\nNo unmatched active tool findings.\n';
  const groups = groupBy(rows, (row) => row.extraClassification || 'unknown');
  const lines = ['# Tool Extra Findings', ''];
  for (const [classification, items] of Object.entries(groups)) {
    lines.push(`## ${classification}`, '');
    for (const row of items) {
      lines.push(`- **${md(row.checkId)}** (${md(row.priority)}; ${row.affectedCount || 0} affected): ${md(row.finding || row.title || '')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderRoadmapMarkdown(rows = []) {
  if (!rows.length) return '# Check Roadmap\n\nNo roadmap entries generated.\n';
  const lines = ['# Check Roadmap', '', '| Roadmap Category | Source | Title | Priority | Effort | Possible Check | Suggested Implementation |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| ${md(row.roadmapCategory || '')} | ${md(row.source)} | ${md(row.title)} | ${md(row.priority)} | ${md(row.effort)} | ${md(row.possibleCheckId || '')} | ${md(row.suggestedImplementation || '')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderScoreCalibrationNotesMarkdown(notes = []) {
  const lines = ['# Score Calibration Notes', ''];
  if (!notes.length) lines.push('- No automatic scoring change recommended from this validation run.');
  for (const note of notes) lines.push(`- ${note}`);
  lines.push('', 'Scoring should not be changed automatically from validation deltas; use these notes as calibration input.');
  return `${lines.join('\n')}\n`;
}

export function renderValidationHtml(report) {
  const summary = report.validationSummary || {};
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Enterprise Validation Run ${escapeHtml(report.runId)}</title>
  <style>
    :root { --red:#e30613; --ink:#171717; --muted:#666; --line:#ddd; --bg:#fafafa; }
    body { font-family: Inter, Arial, sans-serif; margin:0; background:var(--bg); color:var(--ink); }
    header, main { max-width:1200px; margin:0 auto; padding:24px; }
    header { background:#fff; border-bottom:1px solid var(--line); }
    h1 { margin:0 0 8px; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin:20px 0; }
    .card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .metric { font-size:28px; font-weight:800; color:var(--red); }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); }
    th, td { padding:10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { background:#f3f3f3; }
    code, .tag { background:#f2f2f2; padding:2px 5px; border-radius:4px; }
  </style>
</head>
<body>
  <header>
    <h1>Enterprise Validation Report</h1>
    <div class="muted">Run ${escapeHtml(report.runId)} · ${escapeHtml(report.generatedAt || '')}</div>
  </header>
  <main>
    <section class="card">
      <strong>Data basis:</strong> ${escapeHtml(summary.dataBasisLabel || report.executiveValidationSummary?.sampleNote || '')}
    </section>
    <section class="grid">
      ${metricCard('Manual Items', summary.manualItemCount)}
      ${metricCard('Covered', summary.covered)}
      ${metricCard('Partial', summary.partiallyCovered)}
      ${metricCard('Not Covered', summary.notCovered)}
      ${metricCard('External Data', summary.needsExternalData)}
      ${metricCard('Larger Crawl', summary.needsLargerCrawl)}
      ${metricCard('Human Review', summary.needsHumanReview)}
      ${metricCard('LLM Review', summary.needsLlmReview)}
      ${metricCard('Tool Extras', summary.toolExtras)}
      ${metricCard('False Positives', summary.falsePositiveCandidates)}
      ${metricCard('Coverage', `${summary.coveragePercent ?? 0}%`)}
    </section>
    <h2>Executive Summary</h2>
    <p>${escapeHtml(report.executiveValidationSummary?.answer || '')}</p>
    <h2>Top Covered</h2>
    ${htmlList(topCoverageLines(report.coverageMatrix, 'covered'))}
    <h2>Top Partial</h2>
    ${htmlList(topCoverageLines(report.coverageMatrix, 'partially_covered'))}
    <h2>Top Gaps</h2>
    ${htmlList(topCoverageLines(report.coverageMatrix, ['not_covered', 'false_negative_candidate', 'needs_external_data', 'needs_larger_crawl', 'needs_human_review', 'needs_llm_review']))}
    <h2>What The Tool Finds Beyond The Manual Audit</h2>
    ${htmlList(topToolExtraLines(report.unmatchedToolFindings))}
    <h2>Next Automation Steps</h2>
    ${htmlList(nextAutomationLines(report.checkRoadmap))}
    <h2>Coverage Matrix</h2>
    <table>
      <thead><tr><th>Manual Item</th><th>Status</th><th>Confidence</th><th>Matched Check</th><th>Rationale</th></tr></thead>
      <tbody>
        ${(report.coverageMatrix || []).map((row) => `<tr>
          <td>${escapeHtml(row.manualItem?.title || row.manualItemId)}</td>
          <td><span class="tag">${escapeHtml(row.coverageStatus)}</span></td>
          <td>${escapeHtml(row.confidence)}</td>
          <td><code>${escapeHtml(row.matchedCheckId || '')}</code></td>
          <td>${escapeHtml(row.rationale || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <h2>Tool Extras</h2>
    <table>
      <thead><tr><th>Check</th><th>Class</th><th>Priority</th><th>Finding</th></tr></thead>
      <tbody>
        ${(report.unmatchedToolFindings || []).map((row) => `<tr>
          <td><code>${escapeHtml(row.checkId)}</code></td>
          <td>${escapeHtml(row.extraClassification)}</td>
          <td>${escapeHtml(row.priority)}</td>
          <td>${escapeHtml(row.finding || row.title || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <h2>Storage Reality</h2>
    <table>
      <tbody>
        <tr><th>Run-specific estimate</th><td>${escapeHtml(report.storageRealityCheck?.runSpecificEstimatedHuman || '')}</td></tr>
        <tr><th>Bytes per URL</th><td>${escapeHtml(report.storageRealityCheck?.estimatedBytesPerUrlHuman || '')}</td></tr>
        <tr><th>50k projection</th><td>${escapeHtml(report.storageRealityCheck?.projections?.estimated50kHuman || '')}</td></tr>
        <tr><th>Risk</th><td>${escapeHtml(report.storageRealityCheck?.riskLevel || '')}</td></tr>
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

function groupBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row);
    acc[key] = acc[key] || [];
    acc[key].push(row);
    return acc;
  }, {});
}

function metricCard(label, value) {
  return `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value ?? 0)}</div></div>`;
}

function htmlList(lines = []) {
  const items = lines.map((line) => String(line || '').replace(/^- /, ''));
  return `<ul>${items.map((line) => `<li>${escapeHtml(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</li>`).join('')}</ul>`;
}

function md(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
