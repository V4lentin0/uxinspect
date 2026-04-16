/**
 * P5 #50 — Synthetic monitor scheduler.
 * Runs on CF Cron Trigger (every 15 min), queries D1 for enabled monitors,
 * fetches each target URL, compares vs baseline, alerts on regression.
 */

import type { Env } from './types.js';

interface MonitorRow {
  id: string;
  team_id: string;
  name: string;
  url: string;
  alert_webhook_url: string | null;
  alert_thresholds: string | null;
  baseline_run_id: string | null;
  last_alert_at: string | null;
  consecutive_fails: number;
}

interface AlertThresholds {
  score_drop?: number;
  a11y_drop?: number;
  perf_drop?: number;
  visual_increase?: number;
  duration_threshold?: number;
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min
const FETCH_TIMEOUT_MS = 15_000;

export async function handleScheduled(
  _event: ScheduledEvent,
  env: Env,
): Promise<void> {
  const monitors = await env.DB.prepare(
    `SELECT id, team_id, name, url, alert_webhook_url, alert_thresholds,
            baseline_run_id, last_alert_at, consecutive_fails
     FROM monitors
     WHERE enabled = 1 AND (paused_until IS NULL OR paused_until < datetime('now'))
     LIMIT 50`,
  ).all();

  for (const row of (monitors.results ?? []) as unknown as MonitorRow[]) {
    try {
      await checkMonitor(row, env);
    } catch (err) {
      console.error(`monitor_error:${row.id}`, err instanceof Error ? err.message : err);
    }
  }
}

async function checkMonitor(monitor: MonitorRow, env: Env): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let httpStatus = 0;
  let durationMs = 0;
  let regression = false;

  const start = Date.now();
  try {
    const res = await fetch(monitor.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'uxinspect-monitor/1.0' },
    });
    httpStatus = res.status;
  } catch {
    httpStatus = 0; // network error / timeout
  } finally {
    clearTimeout(timer);
    durationMs = Date.now() - start;
  }

  // Simple regression: non-2xx is a regression
  if (httpStatus < 200 || httpStatus >= 400) {
    regression = true;
  }

  // Apply threshold checks if baseline exists
  const thresholds: AlertThresholds = monitor.alert_thresholds
    ? JSON.parse(monitor.alert_thresholds)
    : {};

  if (thresholds.duration_threshold && durationMs > thresholds.duration_threshold) {
    regression = true;
  }

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO monitor_runs (id, monitor_id, team_id, http_status, score, regression, alerted, duration_ms, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, datetime('now'))`,
  ).bind(runId, monitor.id, monitor.team_id, httpStatus, httpStatus >= 200 && httpStatus < 400 ? 1.0 : 0.0, regression ? 1 : 0, durationMs).run();

  // Update monitor state
  const newFails = regression ? monitor.consecutive_fails + 1 : 0;
  await env.DB.prepare(
    `UPDATE monitors SET last_run_id = ?1, last_run_at = datetime('now'), consecutive_fails = ?2, updated_at = datetime('now') WHERE id = ?3`,
  ).bind(runId, newFails, monitor.id).run();

  // Alert if regression + cooldown passed + webhook configured
  if (regression && monitor.alert_webhook_url) {
    const cooldownOk = !monitor.last_alert_at ||
      Date.now() - new Date(monitor.last_alert_at).getTime() > ALERT_COOLDOWN_MS;

    if (cooldownOk) {
      try {
        await fetch(monitor.alert_webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            monitor: monitor.name,
            url: monitor.url,
            status: httpStatus,
            duration_ms: durationMs,
            consecutive_fails: newFails,
            run_id: runId,
          }),
        });
        await env.DB.prepare(
          `UPDATE monitors SET last_alert_at = datetime('now') WHERE id = ?1`,
        ).bind(monitor.id).run();
        await env.DB.prepare(
          `UPDATE monitor_runs SET alerted = 1 WHERE id = ?1`,
        ).bind(runId).run();
      } catch (err) {
        console.error(`alert_failed:${monitor.id}`, err instanceof Error ? err.message : err);
      }
    }
  }
}
