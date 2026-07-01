import { applyDisplaySemantics } from './displaySemantics.js';

export const REVIEW_STATUSES = [
  'unreviewed',
  'confirmed',
  'false_positive',
  'accepted_risk',
  'needs_fix',
  'fixed',
  'ignored'
];

export const ACTION_STATUSES = [
  'open',
  'planned',
  'in_progress',
  'done',
  'wont_do'
];

export const MANUAL_STATUSES = ['OK', 'Warning', 'Error', 'NA'];
export const MANUAL_PRIORITIES = ['High', 'Medium', 'Low'];
export const MANUAL_EFFORTS = ['S', 'M', 'L'];

const MANUAL_FIELD_DEFAULTS = {
  reviewerName: null,
  note: null,
  manualStatus: null,
  manualPriority: null,
  manualEffort: null,
  manualFinding: null,
  manualRecommendation: null
};

export function normalizeReviewPayload(payload = {}, existing = {}) {
  const merged = {
    reviewStatus: existing.reviewStatus || 'unreviewed',
    actionStatus: existing.actionStatus || 'open',
    ...MANUAL_FIELD_DEFAULTS
  };

  for (const [key, value] of Object.entries(existing)) {
    if (key in merged) merged[key] = value;
  }

  if ('reviewStatus' in payload) {
    merged.reviewStatus = normalizeEnum('reviewStatus', payload.reviewStatus, REVIEW_STATUSES, 'unreviewed');
  }
  if ('actionStatus' in payload) {
    merged.actionStatus = normalizeEnum('actionStatus', payload.actionStatus, ACTION_STATUSES, 'open');
  }
  if ('manualStatus' in payload) {
    merged.manualStatus = normalizeNullableEnum('manualStatus', payload.manualStatus, MANUAL_STATUSES);
  }
  if ('manualPriority' in payload) {
    merged.manualPriority = normalizeNullableEnum('manualPriority', payload.manualPriority, MANUAL_PRIORITIES);
  }
  if ('manualEffort' in payload) {
    merged.manualEffort = normalizeNullableEnum('manualEffort', payload.manualEffort, MANUAL_EFFORTS);
  }

  for (const field of ['reviewerName', 'note', 'manualFinding', 'manualRecommendation']) {
    if (field in payload) merged[field] = normalizeNullableText(payload[field]);
  }

  return merged;
}

export function applyEffectiveValues(row) {
  const reviewStatus = row.reviewStatus || 'unreviewed';
  const actionStatus = row.actionStatus || 'open';
  const effectiveStatus = row.manualStatus || row.status;
  const effectivePriority = row.manualPriority || row.priority;
  const effectiveEffort = row.manualEffort || row.effort;
  const effectiveFinding = row.manualFinding || row.finding;
  const effectiveRecommendation = row.manualRecommendation || row.recommendation;
  const hasManualOverride = Boolean(
    row.manualStatus ||
    row.manualPriority ||
    row.manualEffort ||
    row.manualFinding ||
    row.manualRecommendation
  );

  return applyDisplaySemantics({
    ...row,
    reviewStatus,
    actionStatus,
    effectiveStatus,
    effectivePriority,
    effectiveEffort,
    effectiveFinding,
    effectiveRecommendation,
    hasManualOverride: hasManualOverride ? 1 : 0
  });
}

function normalizeEnum(field, value, allowed, fallback) {
  const normalized = normalizeNullableText(value) || fallback;
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function normalizeNullableEnum(field, value, allowed) {
  const normalized = normalizeNullableText(value);
  if (normalized === null) return null;
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function normalizeNullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}
