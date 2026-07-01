const SCHEDULE_TYPES = new Set(['daily', 'weekly', 'monthly', 'manual']);

export function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function normalizeScheduleTiming(input = {}) {
  const scheduleType = SCHEDULE_TYPES.has(input.scheduleType) ? input.scheduleType : 'manual';
  const intervalValue = Math.max(1, Number(input.intervalValue || 1));
  const timeOfDay = normalizeTimeOfDay(input.timeOfDay || '09:00');
  const timezone = String(input.timezone || defaultTimezone()).trim() || defaultTimezone();
  const isActive = input.isActive === false || input.isActive === 0 || input.isActive === 'false'
    ? false
    : input.enabled === false || input.enabled === 0 || input.enabled === 'false'
      ? false
      : true;

  return {
    scheduleType,
    intervalValue,
    dayOfWeek: clampInteger(input.dayOfWeek, 0, 6, 1),
    dayOfMonth: clampInteger(input.dayOfMonth, 1, 31, 1),
    timeOfDay,
    timezone,
    isActive
  };
}

export function computeNextRunAt(schedule = {}, from = new Date()) {
  const timing = normalizeScheduleTiming(schedule);
  if (!timing.isActive || timing.scheduleType === 'manual') return null;

  const fromDate = from instanceof Date ? from : new Date(from);
  if (!Number.isFinite(fromDate.getTime())) throw new Error('Invalid from date for nextRunAt calculation.');

  if (timing.scheduleType === 'daily') return nextDaily(timing, fromDate).toISOString();
  if (timing.scheduleType === 'weekly') return nextWeekly(timing, fromDate).toISOString();
  if (timing.scheduleType === 'monthly') return nextMonthly(timing, fromDate).toISOString();
  return null;
}

export function isScheduleDue(schedule = {}, now = new Date()) {
  if (!schedule?.isActive && !schedule?.enabled) return false;
  if (!schedule.nextRunAt) return false;
  const dueAt = new Date(schedule.nextRunAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(dueAt) && Number.isFinite(nowMs) && dueAt <= nowMs;
}

function nextDaily(timing, fromDate) {
  const parts = getZonedParts(fromDate, timing.timezone);
  const { hour, minute } = parseTimeOfDay(timing.timeOfDay);
  let candidate = zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, 0, timing.timezone);
  while (candidate <= fromDate) {
    const next = addDays(parts.year, parts.month, parts.day, timing.intervalValue);
    candidate = zonedLocalToUtc(next.year, next.month, next.day, hour, minute, 0, timing.timezone);
    parts.year = next.year;
    parts.month = next.month;
    parts.day = next.day;
  }
  return candidate;
}

function nextWeekly(timing, fromDate) {
  const parts = getZonedParts(fromDate, timing.timezone);
  const { hour, minute } = parseTimeOfDay(timing.timeOfDay);
  const currentDow = dayOfWeek(parts.year, parts.month, parts.day);
  let delta = timing.dayOfWeek - currentDow;
  if (delta < 0) delta += 7;
  let target = addDays(parts.year, parts.month, parts.day, delta);
  let candidate = zonedLocalToUtc(target.year, target.month, target.day, hour, minute, 0, timing.timezone);
  while (candidate <= fromDate) {
    target = addDays(target.year, target.month, target.day, 7 * timing.intervalValue);
    candidate = zonedLocalToUtc(target.year, target.month, target.day, hour, minute, 0, timing.timezone);
  }
  return candidate;
}

function nextMonthly(timing, fromDate) {
  const parts = getZonedParts(fromDate, timing.timezone);
  const { hour, minute } = parseTimeOfDay(timing.timeOfDay);
  let target = clampMonthlyDate(parts.year, parts.month, timing.dayOfMonth);
  let candidate = zonedLocalToUtc(target.year, target.month, target.day, hour, minute, 0, timing.timezone);
  while (candidate <= fromDate) {
    target = addMonths(target.year, target.month, timing.intervalValue, timing.dayOfMonth);
    candidate = zonedLocalToUtc(target.year, target.month, target.day, hour, minute, 0, timing.timezone);
  }
  return candidate;
}

function normalizeTimeOfDay(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '09:00';
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeOfDay(value) {
  const [hour, minute] = normalizeTimeOfDay(value).split(':').map(Number);
  return { hour, minute };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function zonedLocalToUtc(year, month, day, hour, minute, second, timezone) {
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = new Date(desiredUtcMs);
  for (let index = 0; index < 3; index += 1) {
    const actual = getZonedParts(guess, timezone);
    const actualUtcMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diff = desiredUtcMs - actualUtcMs;
    if (diff === 0) return guess;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function addDays(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addMonths(year, month, months, preferredDay) {
  const totalMonths = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = (totalMonths % 12) + 1;
  return clampMonthlyDate(nextYear, nextMonth, preferredDay);
}

function clampMonthlyDate(year, month, preferredDay) {
  const lastDay = new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
  return { year, month, day: Math.min(Math.max(1, preferredDay), lastDay) };
}

function dayOfWeek(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}
