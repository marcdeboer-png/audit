import { crawlerDefaults } from './defaults.js';

const RETRY_STATUS_CODES = new Set(crawlerDefaults.retryStatusCodes);

export function createHttpStatusError(statusCode, url) {
  const error = new Error(`Retryable HTTP status ${statusCode} for ${url}`);
  error.statusCode = statusCode;
  error.errorType = 'http_status';
  error.retryable = RETRY_STATUS_CODES.has(Number(statusCode));
  return error;
}

export function classifyError(error) {
  const statusCode = Number(error?.statusCode || 0) || null;
  if (statusCode) {
    return {
      retryable: RETRY_STATUS_CODES.has(statusCode),
      statusCode,
      errorType: RETRY_STATUS_CODES.has(statusCode) ? 'retryable' : 'permanent',
      failedReason: `HTTP status ${statusCode}`
    };
  }

  const message = String(error?.message || 'Unknown error');
  const networkLike = /fetch failed|network|timeout|abort|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message);
  return {
    retryable: networkLike,
    statusCode: null,
    errorType: networkLike ? 'retryable' : 'permanent',
    failedReason: networkLike ? 'Network error' : 'Non-retryable error'
  };
}

export function shouldRetryError(queueItem, run, error) {
  const classification = classifyError(error);
  return classification.retryable && Number(queueItem.attempts || 0) < Number(run.maxAttempts || crawlerDefaults.maxAttempts);
}

export function nextRetryAt(queueItem, run) {
  const attempt = Math.max(1, Number(queueItem.attempts || 1));
  const base = Number(run.retryBaseDelayMs || crawlerDefaults.retryBaseDelayMs);
  const max = Number(run.retryMaxDelayMs || crawlerDefaults.retryMaxDelayMs);
  const delay = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delay).toISOString();
}
