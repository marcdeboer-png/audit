import { csvEscape } from './csvExporter.js';

export const COMPARISON_EXPORTS = {
  'findings-delta': {
    filename: ({ baseRunId, compareRunId }) => `run-${baseRunId}-vs-${compareRunId}-findings-delta.csv`,
    rows: (comparison) => comparison.findingsDelta || [],
    columns: [
      'checkId',
      'category',
      'checkName',
      'deltaType',
      'baseStatus',
      'compareStatus',
      'basePriority',
      'comparePriority',
      'baseScore',
      'compareScore',
      'baseAffectedCount',
      'compareAffectedCount',
      'affectedDelta',
      'findingType',
      'confidence',
      'reviewRecommended',
      'sampleUrlsAdded',
      'sampleUrlsRemoved',
      'sampleUrlsStillAffected'
    ]
  },
  'url-delta': {
    filename: ({ baseRunId, compareRunId }) => `run-${baseRunId}-vs-${compareRunId}-url-delta.csv`,
    rows: (comparison) => comparison.urlDelta || [],
    columns: [
      'url',
      'deltaType',
      'baseStatusCode',
      'compareStatusCode',
      'baseIndexable',
      'compareIndexable',
      'baseTitle',
      'compareTitle',
      'baseCanonical',
      'compareCanonical',
      'basePageType',
      'comparePageType'
    ]
  },
  'template-delta': {
    filename: ({ baseRunId, compareRunId }) => `run-${baseRunId}-vs-${compareRunId}-template-delta.csv`,
    rows: (comparison) => comparison.templateDelta || [],
    columns: [
      'templateClusterKey',
      'deltaType',
      'baseUrlCount',
      'compareUrlCount',
      'urlCountDelta',
      'baseIndexableCount',
      'compareIndexableCount',
      'baseAvgWordCount',
      'compareAvgWordCount',
      'avgWordCountDelta',
      'baseSchemaTypesSummary',
      'compareSchemaTypesSummary'
    ]
  },
  'performance-delta': {
    filename: ({ baseRunId, compareRunId }) => `run-${baseRunId}-vs-${compareRunId}-performance-delta.csv`,
    rows: (comparison) => comparison.performanceDelta || [],
    columns: [
      'templateClusterKey',
      'deltaType',
      'baseAvgPerformanceScore',
      'compareAvgPerformanceScore',
      'performanceScoreDelta',
      'baseAvgLcpMs',
      'compareAvgLcpMs',
      'lcpDeltaMs',
      'baseAvgTbtMs',
      'compareAvgTbtMs',
      'tbtDeltaMs',
      'baseAvgCls',
      'compareAvgCls',
      'clsDelta',
      'baseConsoleErrorSampleCount',
      'compareConsoleErrorSampleCount'
    ]
  }
};

export function getComparisonCsvSpec(type, comparison) {
  const spec = COMPARISON_EXPORTS[type];
  if (!spec) return null;
  return {
    ...spec,
    filename: spec.filename(comparison)
  };
}

export function collectComparisonCsv(comparison, type) {
  const spec = getComparisonCsvSpec(type, comparison);
  if (!spec) return null;
  const rows = spec.rows(comparison);
  return [
    spec.columns.join(','),
    ...rows.map((row) => spec.columns.map((column) => csvEscape(formatValue(row[column]))).join(','))
  ].join('\n');
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('|');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
