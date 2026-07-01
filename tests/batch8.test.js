import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import {
  createProject,
  createRun,
  createScheduledRun,
  deleteRun,
  getRunComparison,
  getRunWithProject,
  getScheduledRun,
  listScheduledRuns,
  saveRunComparison,
  updateProject,
  updateRun
} from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { compareRuns } from '../src/comparison/runComparison.js';
import { generateReport } from '../src/reports/reportGenerator.js';
import { renderComparisonReport } from '../src/reports/comparisonReportGenerator.js';
import { computeNextRunAt } from '../src/scheduler/scheduleTime.js';
import { SchedulerService } from '../src/scheduler/schedulerService.js';
import { useTempAuditDb } from './helpers/testDb.js';

test('migration creates scheduler metadata columns', () => {
  const db = setupDb();
  const scheduleColumns = columnNames(db, 'scheduled_runs');
  for (const column of [
    'name',
    'intervalValue',
    'dayOfWeek',
    'dayOfMonth',
    'timeOfDay',
    'timezone',
    'isActive',
    'lastRunId',
    'lastRunAt',
    'baselineMode',
    'baselineRunId',
    'autoCompare',
    'lastError'
  ]) {
    assert.ok(scheduleColumns.includes(column), `${column} should exist on scheduled_runs`);
  }

  const runColumns = columnNames(db, 'runs');
  for (const column of ['scheduledRunId', 'triggerType', 'baselineRunId', 'comparisonId']) {
    assert.ok(runColumns.includes(column), `${column} should exist on runs`);
  }

  assert.ok(columnNames(db, 'run_comparisons').includes('scheduleContextJson'));
  db.close();
});

test('nextRunAt calculation supports daily weekly monthly and manual schedules', () => {
  assert.equal(
    computeNextRunAt({ scheduleType: 'daily', timeOfDay: '09:30', timezone: 'UTC', isActive: true }, new Date('2026-06-28T08:00:00Z')),
    '2026-06-28T09:30:00.000Z'
  );
  assert.equal(
    computeNextRunAt({ scheduleType: 'weekly', dayOfWeek: 1, timeOfDay: '10:00', timezone: 'UTC', isActive: true }, new Date('2026-06-28T12:00:00Z')),
    '2026-06-29T10:00:00.000Z'
  );
  assert.equal(
    computeNextRunAt({ scheduleType: 'monthly', dayOfMonth: 31, timeOfDay: '12:00', timezone: 'UTC', isActive: true }, new Date('2026-02-01T00:00:00Z')),
    '2026-02-28T12:00:00.000Z'
  );
  assert.equal(
    computeNextRunAt({ scheduleType: 'manual', timeOfDay: '12:00', timezone: 'UTC', isActive: true }, new Date('2026-02-01T00:00:00Z')),
    null
  );
});

test('scheduled run repository creates and updates active schedules with config', () => {
  const db = setupDb();
  const id = createScheduledRun(db, {
    name: 'Weekly Monitor',
    domain: 'https://example.com',
    auditType: 'both',
    scheduleType: 'weekly',
    dayOfWeek: 1,
    timeOfDay: '08:15',
    timezone: 'UTC',
    config: { maxUrls: 20, maxDepth: 2 },
    baselineMode: 'previous_successful',
    autoCompare: true
  });
  const schedule = getScheduledRun(db, id);
  assert.equal(schedule.name, 'Weekly Monitor');
  assert.equal(schedule.config.maxUrls, 20);
  assert.equal(schedule.baselineMode, 'previous_successful');
  assert.equal(schedule.autoCompare, true);
  assert.equal(listScheduledRuns(db).length, 1);
  db.close();
});

test('scheduler starts due jobs once and skips duplicate active starts', async () => {
  const db = setupDb();
  const scheduleId = createScheduledRun(db, {
    domain: 'https://example.com',
    scheduleType: 'daily',
    timeOfDay: '09:00',
    timezone: 'UTC',
    nextRunAt: '2026-06-28T08:59:00.000Z',
    isActive: true,
    config: { maxUrls: 1 }
  });
  let starts = 0;
  let resolveRun;
  const runPromise = new Promise((resolve) => { resolveRun = resolve; });
  const service = new SchedulerService(db, {
    nowFn: () => new Date('2026-06-28T09:00:00.000Z'),
    startAuditFn: async () => {
      starts += 1;
      return { runId: starts, projectId: starts, promise: runPromise };
    }
  });

  await service.runDueJobs();
  const duplicate = await service.runNow(scheduleId);
  assert.equal(starts, 1);
  assert.equal(duplicate.skipped, true);
  assert.equal(duplicate.reason, 'already_running');
  resolveRun();
  await settle();
  db.close();
});

test('scheduler auto-compares against previous successful scheduled run', async () => {
  const db = setupDb();
  const scheduleId = createScheduledRun(db, {
    domain: 'https://example.com',
    scheduleType: 'manual',
    baselineMode: 'previous_successful',
    autoCompare: true,
    config: { maxUrls: 1, enableTemplateSampling: false }
  });
  const baselineRunId = insertCompletedRun(db, {
    domain: 'https://example.com',
    scheduledRunId: scheduleId,
    triggerType: 'scheduled'
  });
  const service = new SchedulerService(db, {
    startAuditFn: fakeCompletedStartAudit(db)
  });

  const started = await service.runNow(scheduleId);
  await settle();

  const run = getRunWithProject(db, started.runId);
  assert.equal(run.baselineRunId, baselineRunId);
  assert.ok(run.comparisonId);
  const comparison = getRunComparison(db, run.comparisonId);
  assert.equal(comparison.baseRunId, baselineRunId);
  assert.equal(comparison.compareRunId, started.runId);
  assert.equal(comparison.scheduleContext.scheduledRunId, scheduleId);
  db.close();
});

test('scheduler saves not_comparable comparison for fixed baseline on another domain', async () => {
  const db = setupDb();
  const baselineRunId = insertCompletedRun(db, {
    domain: 'https://other.example',
    scheduledRunId: null,
    triggerType: 'manual'
  });
  const scheduleId = createScheduledRun(db, {
    domain: 'https://example.com',
    scheduleType: 'manual',
    baselineMode: 'fixed_run',
    baselineRunId,
    autoCompare: true,
    config: { maxUrls: 1, enableTemplateSampling: false }
  });
  const service = new SchedulerService(db, {
    startAuditFn: fakeCompletedStartAudit(db)
  });

  const started = await service.runNow(scheduleId);
  await settle();

  const run = getRunWithProject(db, started.runId);
  const comparison = getRunComparison(db, run.comparisonId);
  assert.equal(comparison.status, 'not_comparable');
  assert.equal(comparison.summary.notComparableReason, 'different_domain');
  db.close();
});

test('reports expose schedule context and deleteRun keeps schedules', () => {
  const db = setupDb();
  const scheduleId = createScheduledRun(db, {
    name: 'Report Schedule',
    domain: 'https://example.com',
    scheduleType: 'manual',
    baselineMode: 'previous_successful',
    autoCompare: true,
    config: { maxUrls: 1, enableTemplateSampling: false }
  });
  const baselineRunId = insertCompletedRun(db, {
    domain: 'https://example.com',
    scheduledRunId: scheduleId,
    triggerType: 'scheduled'
  });
  const compareRunId = insertCompletedRun(db, {
    domain: 'https://example.com',
    scheduledRunId: scheduleId,
    triggerType: 'schedule_run_now'
  });
  const comparison = compareRuns(db, { baseRunId: baselineRunId, compareRunId });
  const saved = saveRunComparison(db, comparison);
  updateRun(db, compareRunId, { baselineRunId, comparisonId: saved.id });

  const html = fs.readFileSync(generateReport(db, compareRunId), 'utf8');
  assert.match(html, /Schedule \/ Baseline/);
  assert.match(html, /Report Schedule/);
  assert.match(html, /Open comparison report/);

  const comparisonHtml = renderComparisonReport(saved);
  assert.match(comparisonHtml, /Schedule Context/);
  assert.match(comparisonHtml, /Report Schedule/);

  assert.equal(deleteRun(db, compareRunId), true);
  assert.ok(getScheduledRun(db, scheduleId), 'schedule should survive deleting an old audit run');
  db.close();
});

test('schedule API supports CRUD enable disable and run-now against a local site', async () => {
  const temp = useTempAuditDb('batch8-api');
  const site = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Batch 8</title><h1>Batch 8</h1><p>Local scheduler API test page.</p>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const sitePort = site.address().port;
  const apiPort = 32000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUDIT_DB_PATH: temp.dbPath,
      PORT: String(apiPort),
      SCHEDULER_DISABLED: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApi(apiPort);
    const created = await apiFetch(apiPort, '/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'API Schedule',
        domain: `localhost:${sitePort}`,
        auditType: 'tech',
        scheduleType: 'manual',
        maxUrls: 1,
        maxDepth: 0,
        concurrency: 1,
        enableTemplateSampling: false,
        autoCompare: false
      })
    });
    assert.equal(created.schedule.name, 'API Schedule');

    const listed = await apiFetch(apiPort, '/api/schedules');
    assert.equal(listed.schedules.length, 1);

    const disabled = await apiFetch(apiPort, `/api/schedules/${created.schedule.id}/disable`, { method: 'POST' });
    assert.equal(disabled.schedule.isActive, false);

    const enabled = await apiFetch(apiPort, `/api/schedules/${created.schedule.id}/enable`, { method: 'POST' });
    assert.equal(enabled.schedule.isActive, true);

    const started = await apiFetch(apiPort, `/api/schedules/${created.schedule.id}/run-now`, { method: 'POST' });
    assert.ok(started.runId);
    const run = await waitForRun(apiPort, started.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.triggerType, 'schedule_run_now');
    assert.equal(run.scheduledRunId, created.schedule.id);
  } finally {
    child.kill('SIGTERM');
    site.close();
    temp.cleanup();
  }
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function insertCompletedRun(db, { domain, scheduledRunId = null, triggerType = 'manual' }) {
  const projectId = createProject(db, { inputDomain: domain, brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: domain });
  const config = {
    ...normalizeAuditConfig({
    domain,
    auditType: 'tech',
    maxUrls: 1,
    maxDepth: 0,
    concurrency: 1,
    enableTemplateSampling: false
    }),
    scheduledRunId,
    triggerType
  };
  const runId = createRun(db, projectId, config);
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: 1,
    successfulUrls: 1,
    startedAt: '2026-06-28T08:00:00.000Z',
    finishedAt: '2026-06-28T08:01:00.000Z'
  });
  return runId;
}

function fakeCompletedStartAudit(db) {
  return async (config, options = {}) => {
    const runId = insertCompletedRun(db, {
      domain: config.domain,
      scheduledRunId: options.scheduledRunId,
      triggerType: options.triggerType
    });
    updateRun(db, runId, { baselineRunId: options.baselineRunId || null });
    return { runId, projectId: getRunWithProject(db, runId).projectId, promise: Promise.resolve() };
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForApi(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await apiFetch(port, '/api/schedules');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('API server did not start');
}

async function waitForRun(port, runId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const run = await apiFetch(port, `/api/audits/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} did not finish`);
}

async function apiFetch(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}
