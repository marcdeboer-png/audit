import crypto from 'node:crypto';
import { normalizeUrl } from '../../utils/url.js';

export const COVERAGE_STATUSES = Object.freeze([
  'covered',
  'partially_covered',
  'not_covered',
  'not_applicable',
  'needs_external_data',
  'needs_larger_crawl',
  'needs_human_review',
  'needs_llm_review',
  'tool_finds_extra',
  'false_positive_candidate',
  'false_negative_candidate'
]);

export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

export function normalizeReferenceAuditItem(raw = {}, context = {}) {
  const sourceFile = firstText(raw.sourceFile, context.sourceFile, context.filename) || null;
  const sourceSheet = firstText(raw.sourceSheet, context.sourceSheet) || null;
  const originalRow = numberOrNull(raw.originalRow || context.originalRow);
  const title = firstText(raw.title, raw.name, raw.issue, raw.topic) || 'Untitled reference audit item';
  const description = nullableText(firstText(raw.description, raw.details, raw.finding));
  const category = normalizeCategory(firstText(raw.category, raw.area, raw.topicCategory, title));
  const severity = normalizeSeverity(firstText(raw.severity, raw.impact, raw.statusSeverity, raw.priority));
  const priority = normalizePriority(firstText(raw.priority, raw.severity, raw.impact));
  const effort = normalizeEffort(firstText(raw.effort));
  const status = normalizeReferenceStatus(firstText(raw.status, raw.state));
  const affectedUrls = normalizeUrls(firstText(raw.affectedUrls, raw.urls, raw.urlSamples, raw.sampleUrls));
  const textEvidenceSeed = firstText(raw.finding, raw.details, raw.evidence, raw.description, raw.notes);
  const affectedCount = numberOrNull(firstText(raw.affectedCount, raw.affectedUrlsCount, raw.urlCount)) ?? extractAffectedCount(textEvidenceSeed);
  const recommendation = nullableText(firstText(raw.recommendation, raw.action, raw.solution)) || extractRecommendation(textEvidenceSeed);
  const notes = nullableText(firstText(raw.notes, raw.comment, raw.comments));
  const expectedToolCheckIds = normalizeList(raw.expectedToolCheckIds?.length ? raw.expectedToolCheckIds : firstText(raw.toolCheckIds, raw.checkIds));
  const expectedDataSources = normalizeList(raw.expectedDataSources?.length ? raw.expectedDataSources : firstText(raw.dataSources));
  const evidence = normalizeEvidence(firstText(raw.evidence, raw.proof, raw.example));
  const requiresExternalData = boolOrNull(firstText(raw.requiresExternalData, raw.externalData));
  const requiresHumanJudgment = boolOrNull(firstText(raw.requiresHumanJudgment, raw.humanReview));
  const requiresLlmJudgment = boolOrNull(firstText(raw.requiresLlmJudgment, raw.llmReview));
  const stableSeed = [
    sourceFile,
    sourceSheet,
    originalRow,
    title,
    category,
    affectedUrls.slice(0, 5).join('|')
  ].filter((value) => value !== null && value !== undefined && value !== '').join('::');

  return {
    id: stableId(raw.id, stableSeed),
    sourceFile,
    sourceSheet,
    originalRow,
    title,
    description,
    category,
    severity,
    priority,
    effort,
    status,
    affectedUrls,
    affectedCount,
    evidence,
    recommendation,
    notes,
    expectedToolCheckIds,
    expectedDataSources,
    requiresExternalData: requiresExternalData ?? false,
    requiresHumanJudgment: requiresHumanJudgment ?? false,
    requiresLlmJudgment: requiresLlmJudgment ?? false,
    raw: raw.raw || raw
  };
}

export function normalizeCategory(value) {
  const input = text(value).toLowerCase();
  if (!input) return 'uncategorized';
  if (/title|meta|description|h1|head|snippet/.test(input)) return 'html-head';
  if (/canonical|noindex|nofollow|robots|status|redirect|crawl|index|facette|facet|filter|pagination|parameter/.test(input)) return 'technical-seo';
  if (/schema|structured|breadcrumb|article|product|localbusiness|faq|json.?ld/.test(input)) return 'structured-data';
  if (/performance|html.?size|core web vitals|crux|psi|lighthouse|ttfb|js|css|cache|cdn|image|alt|lazy/.test(input)) return 'media-performance';
  if (/security|header|hsts|csp|x-frame|permissions|referrer/.test(input)) return 'security-server';
  if (/llms|ai|geo|crawler|gptbot|claude|perplexity|answer/.test(input)) return 'geo-readiness';
  if (/trust|e-?e-?a-?t|author|entity|brand|about|kontakt|contact|impressum|legal/.test(input)) return 'trust-entity';
  return slug(input) || 'uncategorized';
}

export function normalizeSeverity(value) {
  const input = text(value).toLowerCase();
  if (/critical|kritisch|blocker|sehr hoch|very high/.test(input)) return 'critical';
  if (/high|hoch|error|major/.test(input)) return 'high';
  if (/medium|mittel|warning|moderate/.test(input)) return 'medium';
  if (/low|niedrig|minor|info/.test(input)) return 'low';
  return input ? 'unknown' : null;
}

export function normalizePriority(value) {
  const input = text(value).toLowerCase();
  if (/p0|critical|kritisch|blocker|sehr hoch|very high|high|hoch/.test(input)) return 'High';
  if (/p1|medium|mittel|moderate/.test(input)) return 'Medium';
  if (/p2|p3|low|niedrig|minor|info/.test(input)) return 'Low';
  return input ? 'Medium' : null;
}

export function normalizeEffort(value) {
  const input = text(value).toUpperCase();
  if (!input) return null;
  if (['XS', 'S', 'M', 'L', 'XL'].includes(input)) return input;
  if (/LOW|SMALL|KLEIN|NIEDRIG/.test(input)) return 'S';
  if (/MEDIUM|MITTEL/.test(input)) return 'M';
  if (/HIGH|LARGE|GROSS|HOCH/.test(input)) return 'L';
  return input.slice(0, 16);
}

export function normalizeReferenceStatus(value) {
  const input = text(value).toLowerCase();
  if (!input) return 'unknown';
  if (/done|fixed|resolved|erledigt|behoben/.test(input)) return 'resolved';
  if (/ok|pass|kein problem|not an issue/.test(input)) return 'ok';
  if (/n\/?a|not applicable|nicht anwendbar/.test(input)) return 'not_applicable';
  if (/open|todo|issue|problem|warning|error|fail|offen/.test(input)) return 'open';
  return input;
}

export function normalizeList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return String(value)
    .split(/[\n;,|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeUrls(value) {
  return normalizeList(value)
    .map((url) => normalizeUrl(url) || url)
    .filter(Boolean);
}

export function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  const input = text(value).toLowerCase();
  if (!input) return null;
  if (/^(true|yes|ja|y|1|x)$/i.test(input)) return true;
  if (/^(false|no|nein|n|0)$/i.test(input)) return false;
  return null;
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function normalizeEvidence(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const input = nullableText(value);
  if (!input) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : { text: input };
  } catch {
    return { text: input };
  }
}

export function stableId(id, seed) {
  const explicit = text(id);
  if (explicit) return slug(explicit).slice(0, 96) || explicit.slice(0, 96);
  const hash = crypto.createHash('sha1').update(seed || 'reference-item').digest('hex').slice(0, 12);
  return `ref-${hash}`;
}

export function text(value) {
  return String(value ?? '').trim();
}

export function nullableText(value) {
  const output = text(value);
  return output || null;
}

export function extractAffectedCount(value) {
  const input = text(value);
  if (!input) return null;
  const matches = [...input.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d{3,}|\d{1,3})\s*(?:main\s+pages|lower-priority\s+pages|framework\s+artefacts|pages|page\(s\)|urls|htmls|pdps?|plps?|magazine|filter|seiten|urls?)/gi)];
  const candidates = matches
    .map((match) => Number(String(match[1]).replace(/[.,]/g, '')))
    .filter((number) => Number.isFinite(number) && number > 0);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

export function extractRecommendation(value) {
  const input = text(value);
  if (!input) return null;
  const match = input.match(/(?:recommendation|solution|fix|massnahme|maßnahme):\s*([\s\S]{12,1000})/i);
  if (!match) return null;
  return nullableText(match[1].split(/\n{2,}|(?:\n[A-Z][A-Za-z ]{2,}:)/)[0]);
}

export function firstText(...values) {
  for (const value of values) {
    const output = text(value);
    if (output) return output;
  }
  return '';
}

export function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
