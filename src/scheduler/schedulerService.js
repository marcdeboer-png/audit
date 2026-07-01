import { startAudit as defaultStartAudit } from '../crawler/auditRunner.js';
import { compareRuns } from '../comparison/runComparison.js';
import { generateReport } from '../reports/reportGenerator.js';
import {
  getPreviousSuccessfulScheduledRun,
  getScheduledRun,
  getRunWithProject,
  hasActiveRunForSchedule,
  listDueScheduledRuns,
  logRun,
  markScheduledRunError,
  markScheduledRunStarted,
  saveRunComparison,
  updateRun
} from '../db/repositories.js';
import { computeNextRunAt } from './scheduleTime.js';

export class SchedulerService {
  constructor(db, {
    pollIntervalMs = 60000,
    startAuditFn = defaultStartAudit,
    nowFn = () => new Date()
  } = {}) {
    this.db = db;
    this.pollIntervalMs = pollIntervalMs;
    this.startAuditFn = startAuditFn;
    this.nowFn = nowFn;
    this.timer = null;
    this.runningScheduleIds = new Set();
  }

  start() {
    if (this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    try {
      await this.runDueJobs();
    } catch (error) {
      console.error('Scheduler tick failed:', error.message);
    }
  }

  async runDueJobs() {
    const now = this.nowFn();
    const due = listDueScheduledRuns(this.db, now.toISOString());
    const starts = [];
    for (const schedule of due) {
      starts.push(this.startScheduleRun(schedule, 'scheduled', { now }));
    }
    return Promise.all(starts);
  }

  async runNow(scheduleId) {
    const schedule = getScheduledRun(this.db, Number(scheduleId));
    if (!schedule) throw httpError(404, `Schedule ${scheduleId} not found`);
    return this.startScheduleRun(schedule, 'schedule_run_now', { now: this.nowFn(), preserveNextRunAt: true });
  }

  async startScheduleRun(schedule, triggerType = 'scheduled', { now = this.nowFn(), preserveNextRunAt = false } = {}) {
    const scheduleId = Number(schedule.id);
    if (this.runningScheduleIds.has(scheduleId) || hasActiveRunForSchedule(this.db, scheduleId)) {
      const nextRunAt = preserveNextRunAt ? schedule.nextRunAt : computeNextRunAt(schedule, now);
      if (!preserveNextRunAt) {
        markScheduledRunError(this.db, scheduleId, 'Skipped because this schedule already has an active run.', { nextRunAt });
      }
      return { skipped: true, reason: 'already_running', schedule: getScheduledRun(this.db, scheduleId) || schedule };
    }

    this.runningScheduleIds.add(scheduleId);
    const baselineRunId = this.resolveBaselineRunId(schedule, null);
    const auditConfig = buildAuditConfigFromSchedule(schedule);
    const startOptions = {
      wait: false,
      scheduledRunId: scheduleId,
      triggerType,
      baselineRunId
    };

    try {
      const audit = await this.startAuditFn(auditConfig, startOptions);
      const startedAt = now.toISOString();
      const nextRunAt = preserveNextRunAt ? schedule.nextRunAt : computeNextRunAt(schedule, now);
      const updatedSchedule = markScheduledRunStarted(this.db, scheduleId, audit.runId, { nextRunAt, startedAt });
      this.attachCompletionHandler(scheduleId, audit.runId, baselineRunId, audit.promise);
      return { runId: audit.runId, projectId: audit.projectId, schedule: updatedSchedule };
    } catch (error) {
      const nextRunAt = preserveNextRunAt ? schedule.nextRunAt : computeNextRunAt(schedule, now);
      const updatedSchedule = markScheduledRunError(this.db, scheduleId, error.message, { nextRunAt });
      this.runningScheduleIds.delete(scheduleId);
      return { error: error.message, schedule: updatedSchedule };
    }
  }

  attachCompletionHandler(scheduleId, runId, baselineRunId, promise) {
    const completion = Promise.resolve(promise)
      .then(() => this.handleRunCompleted(scheduleId, runId, baselineRunId))
      .catch((error) => {
        markScheduledRunError(this.db, scheduleId, error.message, { nextRunAt: getScheduledRun(this.db, scheduleId)?.nextRunAt || null });
      })
      .finally(() => {
        this.runningScheduleIds.delete(Number(scheduleId));
      });
    return completion;
  }

  resolveBaselineRunId(schedule, currentRunId = null) {
    if (!schedule?.autoCompare) return null;
    if (schedule.baselineMode === 'fixed_run') return schedule.baselineRunId || null;
    if (schedule.baselineMode === 'previous_successful') {
      return getPreviousSuccessfulScheduledRun(this.db, schedule.id, currentRunId)?.id || null;
    }
    return null;
  }

  handleRunCompleted(scheduleId, runId, initialBaselineRunId = null) {
    const schedule = getScheduledRun(this.db, scheduleId);
    const run = getRunWithProject(this.db, runId);
    if (!schedule || !run || run.status !== 'completed' || !schedule.autoCompare) return null;
    const baselineRunId = initialBaselineRunId || this.resolveBaselineRunId(schedule, runId);
    if (!baselineRunId || Number(baselineRunId) === Number(runId)) return null;

    try {
      const comparison = compareRuns(this.db, { baseRunId: baselineRunId, compareRunId: runId });
      comparison.scheduleContext = comparison.scheduleContext || {
        scheduledRunId: schedule.id,
        scheduleName: schedule.name,
        triggerType: run.triggerType || null,
        baselineMode: schedule.baselineMode
      };
      const saved = saveRunComparison(this.db, comparison);
      updateRun(this.db, runId, {
        baselineRunId,
        comparisonId: saved.id
      });
      logRun(this.db, runId, 'info', 'Scheduled auto comparison saved', {
        comparisonId: saved.id,
        baselineRunId,
        status: saved.status
      });
      generateReport(this.db, runId);
      return saved;
    } catch (error) {
      markScheduledRunError(this.db, scheduleId, `Auto comparison failed: ${error.message}`, { nextRunAt: schedule.nextRunAt });
      logRun(this.db, runId, 'error', 'Scheduled auto comparison failed', { error: error.message });
      return null;
    }
  }
}

export function startSchedulerService(db, options = {}) {
  return new SchedulerService(db, options).start();
}

export function buildAuditConfigFromSchedule(schedule) {
  const config = schedule.config || {};
  return {
    ...config,
    domain: schedule.domain,
    brandName: schedule.brandName || config.brandName || null,
    auditType: schedule.auditType || config.auditType || 'both'
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
