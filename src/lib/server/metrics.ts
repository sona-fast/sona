// Observability write path (issue #6, Phase 1 — Tier-B operational telemetry).
//
// These are the CHEAP, NON-BLOCKING recorders that feed the /admin/observability
// dashboard. Design rules (all load-bearing):
//   - Never add latency to a request and never break one. Callers schedule these
//     via `schedule()` (waitUntil / fire-and-forget) and every write is wrapped so
//     a metrics failure is swallowed, never propagated.
//   - Rolled-up counters, not a row per request: metric_rollup is a bounded UPSERT
//     keyed by (day, metric, dim), so write cost is O(1) regardless of traffic.
//   - Bounded cardinality: `dim` is a coarse label (route class, status, ok/fail),
//     never a raw path, id, IP or user-agent. No PII is ever written here.
//   - Tenant-isolated by construction: every write targets THIS fork's own DB.
//
// Read/query side lives in ./observability.ts.

import { sql } from 'drizzle-orm';
import { metricRollup, errorSample, jobRun } from './db/schema';
import type { Database } from './db';

type Env = { OBSERVABILITY_ENABLED?: string };

/**
 * Opt-in gate for the issue #6 observability feature. DEFAULT OFF: enabled only
 * when OBSERVABILITY_ENABLED is one of 'true'/'1'/'on'/'yes' (case-insensitive);
 * anything else (unset, '', 'false', '0', 'off', 'no') leaves the feature dormant.
 */
export function isObservabilityEnabled(env: Env | undefined): boolean {
	const v = (env?.OBSERVABILITY_ENABLED ?? '').toString().trim().toLowerCase();
	return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

export type Metric = 'request' | 'error' | 'upload' | 'email';
/** Coarse request bucket — the only `dim` used for metric='request'. */
export type RouteClass = 'public' | 'admin' | 'api';

/** Newest N error samples are kept; older rows are pruned on each write. */
export const ERROR_SAMPLE_CAP = 200;
/** Error messages are trimmed to this length before storage (defensive; no PII). */
const ERROR_MESSAGE_MAX = 300;

/** UTC day key ('YYYY-MM-DD') for a Date (defaults to now). */
export function dayKey(d: Date = new Date()): string {
	return d.toISOString().slice(0, 10);
}

/** Classify a request path into the coarse bucket used as the request `dim`. */
export function routeClass(pathname: string): RouteClass {
	if (pathname.startsWith('/admin')) return 'admin';
	if (pathname.startsWith('/api')) return 'api';
	return 'public';
}

/** True for static-asset / favicon paths that must not be counted as requests. */
export function isAssetPath(pathname: string): boolean {
	return pathname.startsWith('/_app/') || pathname === '/favicon.ico' || pathname === '/favicon.png';
}

/**
 * One PII-free line: collapse whitespace, redact anything that could carry PII or a
 * secret, then clamp length. Masks email-like addresses and long token-like runs
 * (API keys, bearer tokens) so error_sample.message and job_run.detail can't leak
 * them — keeping the dashboard's "no PII" claim true even when a raw error embeds
 * them.
 */
function cleanMessage(message: string): string {
	return (message ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\S+@\S+/g, '[redacted]')
		.replace(/[A-Za-z0-9_\-+=]{20,}/g, '[redacted]')
		.slice(0, ERROR_MESSAGE_MAX);
}

/**
 * Increment a rolled-up counter by `n` (default 1). Bounded UPSERT — one row per
 * (day, metric, dim), `count = count + n` on conflict. Contention-safe: a single
 * statement, no read-modify-write.
 */
export async function recordMetric(
	db: Database,
	metric: Metric,
	dim: string = '',
	n: number = 1
): Promise<void> {
	const day = dayKey();
	await db
		.insert(metricRollup)
		.values({ day, metric, dim, count: n })
		.onConflictDoUpdate({
			target: [metricRollup.day, metricRollup.metric, metricRollup.dim],
			set: { count: sql`${metricRollup.count} + ${n}` }
		});
}

/**
 * Append a Tier-B error sample to the capped ring, then prune to the newest
 * ERROR_SAMPLE_CAP rows. Stores route + status + a trimmed, PII-free message
 * only — never IP, user-agent, headers, body or a stack. ids are monotonic
 * (autoincrement), so the prune is a cheap id-threshold delete.
 */
export async function recordError(
	db: Database,
	sample: { route: string; status: number; message: string }
): Promise<void> {
	await db.insert(errorSample).values({
		ts: new Date().toISOString(),
		route: sample.route,
		status: sample.status,
		message: cleanMessage(sample.message)
	});
	await db.delete(errorSample).where(
		sql`${errorSample.id} <= (SELECT MAX(${errorSample.id}) - ${ERROR_SAMPLE_CAP} FROM ${errorSample})`
	);
}

/** Record an upload attempt outcome. A failure also drops an error sample. */
export async function recordUpload(
	db: Database,
	ok: boolean,
	failure?: { status: number; message: string }
): Promise<void> {
	await recordMetric(db, 'upload', ok ? 'ok' : 'fail');
	if (!ok) {
		await recordError(db, {
			route: 'upload',
			status: failure?.status ?? 500,
			message: failure?.message ?? 'upload failed'
		});
	}
}

/** Record a transactional-email send outcome. A failure also drops an error sample. */
export async function recordEmail(
	db: Database,
	sent: boolean,
	failure?: { status: number; message: string }
): Promise<void> {
	await recordMetric(db, 'email', sent ? 'sent' : 'failed');
	if (!sent) {
		await recordError(db, {
			route: 'email',
			status: failure?.status ?? 500,
			message: failure?.message ?? 'email send failed'
		});
	}
}

/** Upsert a background-job heartbeat — one row per named cron, latest run wins. */
export async function recordJobRun(
	db: Database,
	name: string,
	status: 'ok' | 'failed',
	detail?: string
): Promise<void> {
	const ranAt = new Date().toISOString();
	const cleanDetail = detail ? cleanMessage(detail) : null;
	await db
		.insert(jobRun)
		.values({ name, status, ranAt, detail: cleanDetail })
		.onConflictDoUpdate({
			target: jobRun.name,
			set: { status, ranAt, detail: cleanDetail }
		});
}

/**
 * Run a metrics write off the request's critical path. Uses Cloudflare's
 * `waitUntil` when available so the write outlives the response without delaying
 * it; otherwise fire-and-forget. Errors are always swallowed — instrumentation
 * must never surface to the caller.
 */
export function schedule(platform: App.Platform | undefined, work: Promise<unknown>): void {
	const guarded = Promise.resolve(work).catch(() => {});
	if (platform?.context?.waitUntil) {
		platform.context.waitUntil(guarded);
	} else {
		void guarded;
	}
}
