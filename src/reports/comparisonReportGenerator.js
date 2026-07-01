export function renderComparisonReport(comparison) {
  const summary = comparison.summary || {};
  const findingsDelta = comparison.findingsDelta || [];
  const urlDelta = comparison.urlDelta || [];
  const templateDelta = comparison.templateDelta || [];
  const performanceDelta = comparison.performanceDelta || [];
  const regressionFindings = comparison.regressionFindings || [];
  const warnings = comparison.warnings || [];
  const newIssues = findingsDelta.filter((row) => row.deltaType === 'new');
  const resolvedIssues = findingsDelta.filter((row) => row.deltaType === 'resolved');
  const worsenedIssues = findingsDelta.filter((row) => row.deltaType === 'worsened');
  const improvedIssues = findingsDelta.filter((row) => row.deltaType === 'improved');
  const unchangedIssues = findingsDelta.filter((row) => row.deltaType === 'unchanged_issue');
  const changedUrls = urlDelta.filter((row) => row.deltaType !== 'unchangedUrl');
  const changedTemplates = templateDelta.filter((row) => row.deltaType !== 'unchangedTemplate');
  const changedPerformance = performanceDelta.filter((row) => row.deltaType !== 'notComparable');
  const scheduleContext = comparison.scheduleContext || null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Run Comparison ${escapeHtml(comparison.baseRunId)} vs ${escapeHtml(comparison.compareRunId)}</title>
  <style>
    :root { color-scheme: light; --border: #d8dee8; --muted: #667085; --ink: #111827; --good: #0f766e; --bad: #b42318; --warn: #b45309; --bg: #f6f7f9; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header, section { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    h1, h2, h3 { margin: 0 0 12px; line-height: 1.2; }
    h1 { font-size: 26px; }
    h2 { font-size: 19px; }
    h3 { font-size: 15px; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #fbfcfe; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 5px; font-size: 18px; }
    .delta-good { color: var(--good); }
    .delta-bad { color: var(--bad); }
    .delta-warn { color: var(--warn); }
    .badge { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-top: 1px solid var(--border); padding: 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; font-size: 12px; }
    details { margin-top: 6px; }
    summary { cursor: pointer; color: var(--muted); }
    .empty { color: var(--muted); padding: 10px 0; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Run Comparison</h1>
    <p class="muted">Base Run ${escapeHtml(comparison.baseRunId)} vs Compare Run ${escapeHtml(comparison.compareRunId)} · ${escapeHtml(comparison.baseDomain || summary.baseDomain || '')}</p>
    ${comparison.status === 'not_comparable' ? `<p><span class="badge">not comparable</span> ${escapeHtml(comparison.comparisonWarning || warnings[0] || '')}</p>` : ''}
  </header>

  ${scheduleContext ? `<section>
    <h2>Schedule Context</h2>
    <div class="grid">
      ${metric('Schedule', scheduleContext.scheduleName || `Schedule ${scheduleContext.scheduledRunId || ''}`)}
      ${metric('Schedule ID', scheduleContext.scheduledRunId || '')}
      ${metric('Trigger', scheduleContext.triggerType || '')}
      ${metric('Baseline Mode', scheduleContext.baselineMode || '')}
    </div>
  </section>` : ''}

  <section>
    <h2>Executive Delta Summary</h2>
    <div class="grid">
      ${metric('Overall Score Delta', formatSigned(summary.overallScoreDelta), deltaClass(summary.overallScoreDelta, true))}
      ${metric('Tech Score Delta', formatSigned(summary.techScoreDelta), deltaClass(summary.techScoreDelta, true))}
      ${metric('GEO Score Delta', formatSigned(summary.geoScoreDelta), deltaClass(summary.geoScoreDelta, true))}
      ${metric('New Issues', newIssues.length, newIssues.length ? 'delta-bad' : '')}
      ${metric('Resolved Issues', resolvedIssues.length, resolvedIssues.length ? 'delta-good' : '')}
      ${metric('Worsened Issues', worsenedIssues.length, worsenedIssues.length ? 'delta-bad' : '')}
      ${metric('Improved Issues', improvedIssues.length, improvedIssues.length ? 'delta-good' : '')}
      ${metric('Regression Findings', regressionFindings.length, regressionFindings.length ? 'delta-warn' : '')}
      ${metric('Processed URLs Delta', formatSigned(summary.processedUrlsDelta), deltaClass(summary.processedUrlsDelta, true))}
      ${metric('Indexable URLs Delta', formatSigned(summary.indexableUrlsDelta), deltaClass(summary.indexableUrlsDelta, true))}
    </div>
  </section>

  ${warnings.length ? `<section><h2>Warnings / Comparability</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : ''}

  <section>
    <h2>Regression Findings</h2>
    ${regressionFindings.length ? simpleTable(regressionFindings, [
      ['id', 'ID'],
      ['severity', 'Severity'],
      ['name', 'Name'],
      ['finding', 'Finding'],
      ['evidence', 'Evidence', renderJsonCell]
    ]) : empty('No regression findings generated.')}
  </section>

  <section>
    <h2>New Issues</h2>
    ${findingTable(newIssues)}
  </section>

  <section>
    <h2>Resolved Issues</h2>
    ${findingTable(resolvedIssues)}
  </section>

  <section>
    <h2>Worsened / Improved Issues</h2>
    ${findingTable([...worsenedIssues, ...improvedIssues])}
  </section>

  <section>
    <h2>Unchanged Active Issues</h2>
    ${findingTable(unchangedIssues.slice(0, 100))}
  </section>

  <section>
    <h2>URL Changes</h2>
    ${simpleTable(changedUrls.slice(0, 100), [
      ['url', 'URL'],
      ['deltaType', 'Delta'],
      ['baseStatusCode', 'Base Status'],
      ['compareStatusCode', 'Compare Status'],
      ['baseIndexable', 'Base Indexable'],
      ['compareIndexable', 'Compare Indexable'],
      ['baseTitle', 'Base Title'],
      ['compareTitle', 'Compare Title'],
      ['basePageType', 'Base Type'],
      ['comparePageType', 'Compare Type']
    ])}
  </section>

  <section>
    <h2>Template Changes</h2>
    ${simpleTable(changedTemplates.slice(0, 100), [
      ['templateClusterKey', 'Template'],
      ['deltaType', 'Delta'],
      ['baseUrlCount', 'Base URLs'],
      ['compareUrlCount', 'Compare URLs'],
      ['urlCountDelta', 'URL Delta'],
      ['baseAvgWordCount', 'Base Avg Words'],
      ['compareAvgWordCount', 'Compare Avg Words'],
      ['avgWordCountDelta', 'Word Delta'],
      ['baseSchemaTypesSummary', 'Base Schema'],
      ['compareSchemaTypesSummary', 'Compare Schema']
    ])}
  </section>

  <section>
    <h2>Performance Changes</h2>
    ${simpleTable(changedPerformance.slice(0, 100), [
      ['templateClusterKey', 'Template'],
      ['deltaType', 'Delta'],
      ['baseAvgPerformanceScore', 'Base Perf'],
      ['compareAvgPerformanceScore', 'Compare Perf'],
      ['performanceScoreDelta', 'Perf Delta'],
      ['baseAvgLcpMs', 'Base LCP'],
      ['compareAvgLcpMs', 'Compare LCP'],
      ['lcpDeltaMs', 'LCP Delta'],
      ['baseConsoleErrorSampleCount', 'Base Console Errors'],
      ['compareConsoleErrorSampleCount', 'Compare Console Errors']
    ])}
  </section>
</main>
</body>
</html>`;
}

function findingTable(rows) {
  return simpleTable(rows.slice(0, 100), [
    ['checkId', 'Check'],
    ['category', 'Category'],
    ['deltaType', 'Delta'],
    ['baseStatus', 'Base Status'],
    ['compareStatus', 'Compare Status'],
    ['basePriority', 'Base Priority'],
    ['comparePriority', 'Compare Priority'],
    ['affectedDelta', 'Affected Delta'],
    ['compareFinding', 'Compare Finding'],
    ['sampleUrlsAdded', 'Samples Added', renderListCell],
    ['sampleUrlsRemoved', 'Samples Removed', renderListCell],
    ['compareEvidenceSummary', 'Evidence', renderJsonCell]
  ]);
}

function simpleTable(rows, columns) {
  if (!rows.length) return empty('No rows.');
  return `<table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => (
    `<tr>${columns.map(([key, , renderer]) => `<td>${renderer ? renderer(row[key]) : escapeHtml(formatValue(row[key]))}</td>`).join('')}</tr>`
  )).join('')}</tbody></table>`;
}

function metric(label, value, className = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong class="${escapeHtml(className)}">${escapeHtml(value)}</strong></div>`;
}

function renderListCell(value) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return '';
  return `<details><summary>${items.length} sample${items.length === 1 ? '' : 's'}</summary><pre>${escapeHtml(items.join('\n'))}</pre></details>`;
}

function renderJsonCell(value) {
  if (!value || (typeof value === 'object' && !Object.keys(value).length)) return '';
  return `<details><summary>Details</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

function empty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function formatSigned(value) {
  if (value === null || value === undefined || value === '') return 'NA';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number > 0 ? `+${number}` : String(number);
}

function deltaClass(value, positiveIsGood = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  if (positiveIsGood) return number > 0 ? 'delta-good' : 'delta-bad';
  return number > 0 ? 'delta-bad' : 'delta-good';
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
