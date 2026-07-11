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

import { sql, and, lt, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
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

export type Metric =
	| 'request'
	| 'error'
	| 'upload'
	| 'email'
	| 'download'
	// Tier-A visitor aggregates (issue #149). Per-day counters keyed by a reduced,
	// PII-free dim: 'pageview' → page path, 'referrer' → referring host (never a
	// full URL), 'country' → CF-IPCountry code, 'device' → coarse device class.
	| 'pageview'
	| 'referrer'
	| 'country'
	| 'device';
/** Coarse request bucket — the only `dim` used for metric='request'. */
export type RouteClass = 'public' | 'admin' | 'api';

/** Coarse device class stored for the visitor 'device' aggregate. */
export type DeviceClass = 'desktop' | 'mobile' | 'tablet';

/** The Tier-A visitor metrics — grouped so reads/retention can target them. */
export const VISITOR_METRICS = ['pageview', 'referrer', 'country', 'device'] as const;

/** Longest page path stored as a 'pageview' dim (defensive cardinality bound). */
const PATH_MAX = 512;
/** DNS name length limit; referrer hosts longer than this are dropped, not stored. */
const HOST_MAX = 253;
/**
 * Days of Tier-A visitor rows to keep. Comfortably past the 7-day dashboard view
 * (and a future 30-day range) so the prune never eats data the UI still shows,
 * while bounding metric_rollup growth from attacker-varied referrer hosts.
 */
export const VISITOR_RETENTION_DAYS = 35;

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

// ── Tier-A visitor capture (issue #149) ─────────────────────────────────────
// These reduce a request's headers to PII-free labels BEFORE anything is stored.
// The raw User-Agent, IP and full referrer URL never reach the database — only a
// coarse device class, a bare host and a country code do. Cookieless throughout.

/**
 * Coarse device class from a User-Agent, or null for known bots/crawlers and for
 * a missing UA. A null return means "do not count" — bots are excluded at capture
 * time and never stored. The UA string itself is NEVER persisted; only the class
 * ('desktop' | 'mobile' | 'tablet') is. Heuristic, not exhaustive: enough to split
 * the device share and drop the obvious automated traffic.
 */
export function deviceClass(ua: string | null | undefined): DeviceClass | null {
	const s = (ua ?? '').toLowerCase().trim();
	if (!s) return null; // no UA at all → treat as non-human, don't count
	// Known-crawler / automation tokens only. The generic substrings 'preview',
	// 'monitor', 'scan' and 'uptime' were dropped (they can appear in legit UAs);
	// the specific bot forms (bingpreview, uptimerobot, …) stay.
	if (
		/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|headless|python-requests|curl\/|wget|axios|http-client|lighthouse|pingdom|uptimerobot|semrush|ahrefs|feedfetcher|applebot/.test(
			s
		)
	)
		return null;
	// Tablets first: an iPad / Android tablet also matches mobile-ish tokens. An
	// Android *phone* UA carries "mobile"; an Android *tablet* UA does not.
	if (/ipad|tablet|playbook|silk|kindle|android(?!.*mobi)/.test(s)) return 'tablet';
	if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/.test(s)) return 'mobile';
	return 'desktop';
}

/**
 * Reduce a Referer header to its bare host for the aggregate — NEVER the full URL,
 * whose path and query string can carry personal data. A leading `www.` is stripped
 * (from both the candidate and the self host) so an apex-vs-www self-referral is
 * treated as same-site, not logged as external. Returns null for an empty,
 * unparseable, or same-site referer, and — because the Referer is attacker-
 * controlled — for a malformed or oversized host: only a plausible DNS name within
 * the 253-char limit is kept, so one junk header can't bloat a counter key or the
 * stored dim space.
 */
export function referrerHost(referer: string | null | undefined, selfHost: string): string | null {
	if (!referer) return null;
	let host: string;
	try {
		host = new URL(referer).hostname.toLowerCase();
	} catch {
		return null;
	}
	const bare = host.replace(/^www\./, '');
	const selfBare = selfHost.toLowerCase().replace(/^www\./, '');
	if (!bare || bare === selfBare) return null;
	if (bare.length > HOST_MAX || !/^[a-z0-9.-]+$/.test(bare)) return null;
	return bare;
}

/**
 * A country code from Cloudflare's CF-IPCountry edge header, normalized, or null
 * when absent or a placeholder. CF sends a 2-letter ISO code plus 'XX' (unknown)
 * and 'T1'/'T2' (Tor); we keep only real 2-letter alpha codes. The IP is never
 * read — only this coarse country label is.
 */
export function countryCode(raw: string | null | undefined): string | null {
	const s = (raw ?? '').trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(s) || s === 'XX') return null;
	return s;
}

/** One reduced, PII-free page view — the caller has already dropped IP/UA/URL. */
export interface PageView {
	path: string;
	device: DeviceClass;
	referrerHost: string | null;
	country: string | null;
}

/**
 * Build the Tier-A counter statements for ONE public page view: the per-day
 * counters for path and device class, plus referrer host and country when present.
 * Returned as statements so the caller batches them (with the request counter) into
 * a single db.batch — one D1 subrequest per view, not up to five. Counters only —
 * no per-visitor row, no IP, no cookie, no raw user-agent. The path is clamped so
 * one absurd URL can't bloat a counter key; a raw path as a `dim` is a deliberate
 * Tier-A divergence from the coarse-only rule the operational metrics follow.
 */
export function pageViewStatements(db: Database, view: PageView): BatchItem<'sqlite'>[] {
	const stmts: BatchItem<'sqlite'>[] = [
		metricUpsert(db, 'pageview', view.path.slice(0, PATH_MAX)),
		metricUpsert(db, 'device', view.device)
	];
	if (view.referrerHost) stmts.push(metricUpsert(db, 'referrer', view.referrerHost));
	if (view.country) stmts.push(metricUpsert(db, 'country', view.country));
	return stmts;
}

/**
 * Retention for the Tier-A visitor rows: delete metric_rollup rows for the visitor
 * metrics older than `olderThanDays`. Bounds table growth from attacker-varied
 * referrer hosts (each a distinct dim). Scoped to VISITOR_METRICS so operational
 * counters — request/error/upload/email/download, which have bounded dims and feed
 * long-run health — are never touched. Runs from the weekly cleanup-orphans cron.
 */
export async function pruneVisitorRollups(
	db: Database,
	olderThanDays: number = VISITOR_RETENTION_DAYS
): Promise<void> {
	const cutoff = dayKey(new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000));
	await db
		.delete(metricRollup)
		.where(and(lt(metricRollup.day, cutoff), inArray(metricRollup.metric, [...VISITOR_METRICS])));
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
 * Build (not run) the bounded UPSERT that increments a rolled-up counter by `n` —
 * one row per (day, metric, dim), `count = count + n` on conflict. Returned as a
 * statement so callers that write several counters for one request can collapse
 * them into a single `db.batch()` (one D1 subrequest, atomic). Contention-safe: a
 * single statement, no read-modify-write.
 */
export function metricUpsert(
	db: Database,
	metric: Metric,
	dim: string = '',
	n: number = 1
): BatchItem<'sqlite'> {
	const day = dayKey();
	return db
		.insert(metricRollup)
		.values({ day, metric, dim, count: n })
		.onConflictDoUpdate({
			target: [metricRollup.day, metricRollup.metric, metricRollup.dim],
			set: { count: sql`${metricRollup.count} + ${n}` }
		});
}

/** Run a single counter increment. Multi-counter writers use `metricUpsert` + batch. */
export async function recordMetric(
	db: Database,
	metric: Metric,
	dim: string = '',
	n: number = 1
): Promise<void> {
	await metricUpsert(db, metric, dim, n);
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
