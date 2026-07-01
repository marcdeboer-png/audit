export const HTML_WHERE = `(contentType LIKE '%text/html%' OR contentType LIKE '%application/xhtml%')`;
export const VALID_STATUSES = new Set(['OK', 'Warning', 'Error', 'NA']);
export const VALID_PRIORITIES = new Set(['High', 'Medium', 'Low']);
export const VALID_FINDING_TYPES = new Set(['core_issue', 'opportunity', 'best_practice', 'info', 'llm_assisted']);
export const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
export const VALID_EVIDENCE_LEVELS = new Set(['none', 'fact', 'sample', 'aggregate', 'pattern', 'external']);
export const VALID_AUTOMATION_COVERAGE = new Set(['full', 'partial', 'sample', 'requires_external_data', 'requires_human_review', 'requires_llm_review']);

export function makeResult(check, status, options = {}) {
  const evidence = normalizeEvidence(options.evidence || {});
  const sampleUrls = dedupeUrlSamples(options.sampleUrls || [], 10);
  const affectedCount = Math.max(0, Number(options.affectedCount || 0));
  const normalizedStatus = normalizeStatus(status);
  const finalStatus = ['Warning', 'Error'].includes(normalizedStatus) && !hasConcreteEvidence(evidence) ? 'NA' : normalizedStatus;
  return {
    id: check.id,
    category: check.category,
    name: check.name,
    auditType: check.auditType,
    status: finalStatus,
    priority: normalizePriority(options.priority || check.priority || 'Medium'),
    effort: options.effort || check.effort || 'M',
    finding: options.finding || defaultFinding(check, finalStatus),
    details: options.details || defaultDetails(finalStatus, evidence),
    recommendation: options.recommendation || check.recommendation || '',
    affectedCount,
    sampleUrls,
    evidence: Object.keys(evidence).length ? evidence : { status: finalStatus, basis: 'No issue evidence required for this status.' },
    reportGroupingKey: options.reportGroupingKey || check.reportGroupingKey || null,
    findingType: normalizeFindingType(options.findingType || check.findingType || defaultFindingType(check, finalStatus)),
    confidence: normalizeConfidence(options.confidence || check.confidence || (finalStatus === 'NA' ? 'low' : 'high')),
    reviewRecommended: Boolean(options.reviewRecommended ?? check.reviewRecommended ?? false),
    maturityImpact: options.maturityImpact || check.maturityImpact || defaultMaturityImpact(finalStatus, options.findingType || check.findingType),
    dataBasis: options.dataBasis || check.dataBasis || defaultDataBasis(evidence),
    evidenceLevel: normalizeEvidenceLevel(options.evidenceLevel || check.evidenceLevel || defaultEvidenceLevel(finalStatus, evidence)),
    reviewReason: options.reviewReason || check.reviewReason || null,
    automationCoverage: normalizeAutomationCoverage(options.automationCoverage || check.automationCoverage || defaultAutomationCoverage(finalStatus, options)),
    interpretation: options.interpretation || check.interpretation || '',
    limitations: options.limitations || check.limitations || '',
    relatedCheckIds: Array.isArray(options.relatedCheckIds || check.relatedCheckIds)
      ? (options.relatedCheckIds || check.relatedCheckIds).slice(0, 20)
      : []
  };
}

export function count(db, sql, params = []) {
  return db.prepare(sql).get(...params).count || 0;
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function sampleUrls(db, runId, where, params = [], limit = 10) {
  return dedupeUrlSamples(db.prepare(`
    SELECT url
    FROM pages
    WHERE runId = ? AND ${where}
    ORDER BY id ASC
    LIMIT ?
  `).all(runId, ...params, limit * 3).map((row) => row.url), limit);
}

export function dedupeUrlSamples(values = [], limit = 10) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const url = typeof value === 'string' ? value : value?.url;
    const key = String(url || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= limit) break;
  }
  return output;
}

export function dedupeLinkSamples(rows = [], limit = 10) {
  const seen = new Set();
  const output = [];
  for (const row of rows || []) {
    const sourceUrl = String(row?.sourceUrl || row?.url || '').trim();
    const targetUrl = String(row?.targetUrl || '').trim();
    const anchorText = String(row?.anchorText || '').trim().replace(/\s+/g, ' ');
    const key = `${sourceUrl}\n${targetUrl}\n${anchorText.toLowerCase()}`;
    if (!sourceUrl && !targetUrl) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...row, anchorText });
    if (output.length >= limit) break;
  }
  return output;
}

export function dedupeImageSamples(rows = [], limit = 10) {
  const seen = new Set();
  const output = [];
  for (const row of rows || []) {
    const pageUrl = String(row?.pageUrl || row?.url || '').trim();
    const imageUrl = String(row?.imageUrl || row?.resourceUrl || '').trim();
    const key = `${pageUrl}\n${imageUrl}`;
    if (!pageUrl && !imageUrl) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...row });
    if (output.length >= limit) break;
  }
  return output;
}

export function pageCount(db, runId) {
  return count(db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ?', [runId]);
}

export function htmlPageCount(db, runId) {
  return count(db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${HTML_WHERE}`, [runId]);
}

export function issueCheck({ id, category, name, auditType = 'tech', priority = 'Medium', effort = 'M', where, status = 'Error', recommendation = '' }) {
  return {
    id,
    category,
    name,
    auditType,
    priority,
    effort,
    recommendation,
    run(ctx) {
      const totalPages = pageCount(ctx.db, ctx.run.id);
      if (!totalPages) {
        return makeResult(this, 'NA', {
          finding: `${name}: no page data available.`,
          details: 'The check needs stored page rows, but the run has no pages.',
          evidence: { totalPages: 0, condition: where }
        });
      }
      const affectedCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${where}`, [ctx.run.id]);
      const samples = affectedCount ? sampleUrls(ctx.db, ctx.run.id, where) : [];
      return makeResult(this, affectedCount ? status : 'OK', {
        affectedCount,
        sampleUrls: samples,
        finding: affectedCount
          ? `${affectedCount} URL(s) match this issue.`
          : okFindingForIssue(id, name),
        details: `Condition: ${where}`,
        evidence: { affectedCount, sampleUrls: samples }
      });
    }
  };
}

export function safeJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function parseProjectJson(project, key, fallback = []) {
  return safeJson(project[key], fallback);
}

export function checkStatusForCoverage(total, affected, badStatus = 'Warning') {
  if (!total) return 'NA';
  return affected > 0 ? badStatus : 'OK';
}

export function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : 'NA';
}

export function normalizePriority(value) {
  return VALID_PRIORITIES.has(value) ? value : 'Medium';
}

export function normalizeFindingType(value) {
  return VALID_FINDING_TYPES.has(value) ? value : 'info';
}

export function normalizeConfidence(value) {
  return VALID_CONFIDENCE.has(value) ? value : 'medium';
}

export function normalizeEvidenceLevel(value) {
  return VALID_EVIDENCE_LEVELS.has(value) ? value : 'fact';
}

export function normalizeAutomationCoverage(value) {
  return VALID_AUTOMATION_COVERAGE.has(value) ? value : 'partial';
}

function defaultFinding(check, status) {
  if (status === 'OK') return `${check.name}: no issue detected.`;
  if (status === 'NA') return `${check.name}: not enough stored data.`;
  return `${check.name}: issue detected.`;
}

function defaultFindingType(check, status) {
  if (status === 'NA' || status === 'OK') return 'info';
  if (/opportunit/i.test(check.category || '') || /opportunit/i.test(check.name || '')) return 'opportunity';
  if (/security|best practice/i.test(check.category || '')) return 'best_practice';
  return 'core_issue';
}

function defaultMaturityImpact(status, findingType) {
  if (status === 'Error') return 'high';
  if (status === 'Warning' && findingType === 'core_issue') return 'medium';
  if (status === 'Warning') return 'low';
  return 'none';
}

function defaultDataBasis(evidence) {
  const keys = Object.keys(evidence || {}).filter((key) => key !== 'status');
  return keys.length ? keys.slice(0, 6).join(', ') : 'stored audit facts';
}

function defaultEvidenceLevel(status, evidence) {
  if (status === 'NA') return 'none';
  const keys = Object.keys(evidence || {});
  if (keys.some((key) => /pattern|template/i.test(key))) return 'pattern';
  if (keys.some((key) => /sample|samples|sampleUrls/i.test(key))) return 'sample';
  if (keys.some((key) => /count|total|coverage|distribution/i.test(key))) return 'aggregate';
  return 'fact';
}

function defaultAutomationCoverage(status, options = {}) {
  if (options.reviewRecommended) return 'requires_human_review';
  if (status === 'NA') return 'requires_external_data';
  if (options.confidence === 'low') return 'sample';
  return 'partial';
}

function okFindingForIssue(id, name) {
  const normalized = String(id || '').replace(/^tech\./, '').replace(/^geo\./, '');
  const messages = {
    '4xx_pages': 'No 4xx pages found in the crawl.',
    '5xx_pages': 'No 5xx pages found in the crawl.',
    canonical_missing: 'All checked HTML pages expose a canonical URL.',
    h1_missing: 'All checked HTML pages have at least one H1.',
    viewport_missing: 'All checked HTML pages include a viewport meta tag.',
    multiple_h1: 'No checked HTML page has multiple H1 elements.',
    redirect_pages: 'No stored page URL resolved through a redirect.',
    title_missing: 'All checked indexable HTML pages have a title.',
    meta_description_missing: 'All checked indexable HTML pages have a meta description.',
    json_ld_parse_errors: 'All detected JSON-LD blocks were parseable.'
  };
  return messages[normalized] || `${name}: no affected URLs found in stored crawl data.`;
}

function defaultDetails(status, evidence) {
  if (status === 'NA') return 'Not enough stored data was available to evaluate this check.';
  if (['Warning', 'Error'].includes(status)) {
    return `Based on stored evidence fields: ${Object.keys(evidence).join(', ')}.`;
  }
  return 'Evaluated against stored crawl data.';
}

function normalizeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return {};
  return evidence;
}

function hasConcreteEvidence(evidence) {
  return Object.keys(evidence).some((key) => key !== 'status');
}
