// Observability read/query path (issue #6, Phase 1 — Tier-B operational view).
//
// Reads the rolled-up counters, error ring and job heartbeats that ./metrics.ts
// writes, and shapes them for /admin/observability. Also runs the OPTIONAL
// Cloudflare edge-analytics enrichment (GraphQL), which is only ever layered on
// top — the in-app numbers stand alone without it.
//
// ── MULTI-TENANT ISOLATION (the important part) ─────────────────────────────
// Sona is fork-per-tenant: every tenant is its own deploy with its OWN D1
// database. Every query below reads only `db` — this fork's own database — so the
// metrics are tenant-isolated BY CONSTRUCTION. There is no shared table, no
// account-wide query, and no `tenant_id` filter to forget; Tenant A physically
// cannot read Tenant B's numbers because they live in different databases. That
// is the whole reason in-app instrumentation is the foundation and Cloudflare
// Analytics is only an optional add-on (see issue #6, constraint C).
//
// If Sona ever grew a MANAGED multi-tenant deployment (many tenants sharing one
// database), preserving "each member sees only their own metrics" would need ONE
// of two things, and this file is where the boundary would move:
//   1. Keep per-tenant databases (the current model) — nothing here changes; each
//      request already binds to the tenant's own `db`. Preferred.
//   2. Add a `tenant_id` column to metric_rollup / error_sample / job_run and
//      scope EVERY read below (and every write in ./metrics.ts) by the tenant id
//      taken from the AUTHENTICATED admin session — never from request input, a
//      header, or a hostname a caller can spoof. A single unscoped query would be
//      a cross-tenant leak, so the scoping would belong in one shared helper, not
//      sprinkled per call site.
// Do not build (2) now; it is documented so the isolation boundary is explicit.

import { sql, gte, and, eq, desc } from 'drizzle-orm';
import { metricRollup, errorSample, jobRun } from './db/schema';
import { dayKey } from './metrics';
import type { Database } from './db';
import type { SiteSettings } from './settings';

/** Days of history the dashboard shows. */
export const WINDOW_DAYS = 7;
/** Recent-errors table depth. */
const RECENT_ERRORS_LIMIT = 8;
const CF_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
// Kept short: the CF query is streamed (see the page load), so this only bounds how
// long the deferred panel waits before degrading to an error state — never TTFB.
const CF_TIMEOUT_MS = 3000;

export type VerdictLevel = 'ok' | 'warn' | 'down';

export interface Verdict {
	level: VerdictLevel;
	/** Short eyebrow, e.g. "All clear" / "Needs attention". */
	eyebrow: string;
	/** One-line lead, e.g. "Orphan cleanup has failed." */
	lead: string;
	/** Supporting sentence with next step. */
	detail: string;
}

export interface JobStatus {
	name: string;
	/** Human label for the panel (e.g. "Orphan cleanup"). */
	label: string;
	/** 'ok' | 'failed' when it has run; null when it never has. */
	status: 'ok' | 'failed' | null;
	ranAt: string | null;
	detail: string | null;
}

export interface ErrorSampleRow {
	id: number;
	ts: string;
	route: string;
	status: number;
	message: string;
}

export interface StorageHealth {
	/** Display label from the active storageProvider setting. */
	label: string;
	/** Whether the active provider's deploy-time config is present. */
	configured: boolean;
	uploads: number;
	failed: number;
	/** 0..1. */
	failRate: number;
	lastFailure: { message: string; status: number; ts: string } | null;
}

export interface EmailHealth {
	/** Whether RESEND_API_KEY is present. */
	configured: boolean;
	sent: number;
	failed: number;
	lastFailure: { message: string; status: number; ts: string } | null;
	// Delivered/bounced/complaints are webhook-only and NOT available yet: there is
	// no Resend stats API, so the dashboard shows in-app sent/failed only and marks
	// the rest unavailable in the panel (GAP, until a Resend webhook is wired up).
}

export type CfEdge =
	| { state: 'not-configured' }
	| { state: 'error'; message: string }
	| {
			state: 'connected';
			requests: number;
			cachedRequests: number;
			cacheHitRate: number; // 0..1
			bytes: number;
			threats: number;
	  };

export interface ObservabilityData {
	windowDays: number;
	appRequests: number;
	errors5xx: number;
	errorRate: number; // 0..1
	uploads: { ok: number; fail: number };
	emails: { sent: number; failed: number };
	/** Per-day request totals over the window, oldest first (length WINDOW_DAYS). */
	sparkline: number[];
	recentErrors: ErrorSampleRow[];
	jobs: JobStatus[];
	verdict: Verdict;
	providers: { storage: StorageHealth; email: EmailHealth };
}

/** The background jobs we know about, in display order. There is deliberately no
 * "avatar refresh" job: that cron is not implemented in this codebase (GAP vs. the
 * mock), so it is not shown rather than faked. */
const KNOWN_JOBS: { name: string; label: string }[] = [
	{ name: 'resync-telegram', label: 'Telegram re-sync' },
	{ name: 'sync-artists', label: 'Artist registry sync' },
	{ name: 'cleanup-orphans', label: 'Orphan cleanup' }
];

/** Day keys for the last `n` days including today, oldest first (UTC). */
function windowDays(n: number): string[] {
	const days: string[] = [];
	const now = Date.now();
	for (let i = n - 1; i >= 0; i--) {
		days.push(dayKey(new Date(now - i * 24 * 60 * 60 * 1000)));
	}
	return days;
}

/**
 * Gather the full Tier-B operational view for /admin/observability. Reads only
 * this fork's own DB (tenant-isolated by construction — see the note above), plus
 * an optional Cloudflare edge query when its three secrets are present.
 */
export async function getObservability(
	db: Database,
	settings: SiteSettings,
	env: App.Platform['env'] | undefined
): Promise<ObservabilityData> {
	const days = windowDays(WINDOW_DAYS);
	const since = days[0];

	// The four in-app reads are independent, so fire them together to shave TTFB:
	// grouped counters, per-day request totals (sparkline), the recent-error ring,
	// and job heartbeats. Each reduces in JS below.
	const [rows, perDay, recentErrors, jobRows] = await Promise.all([
		db
			.select({
				metric: metricRollup.metric,
				dim: metricRollup.dim,
				total: sql<number>`SUM(${metricRollup.count})`
			})
			.from(metricRollup)
			.where(gte(metricRollup.day, since))
			.groupBy(metricRollup.metric, metricRollup.dim),
		db
			.select({ day: metricRollup.day, total: sql<number>`SUM(${metricRollup.count})` })
			.from(metricRollup)
			.where(and(eq(metricRollup.metric, 'request'), gte(metricRollup.day, since)))
			.groupBy(metricRollup.day),
		db
			.select()
			.from(errorSample)
			.orderBy(desc(errorSample.id))
			.limit(RECENT_ERRORS_LIMIT) as Promise<ErrorSampleRow[]>,
		db.select().from(jobRun)
	]);

	let appRequests = 0;
	let errors5xx = 0;
	const uploads = { ok: 0, fail: 0 };
	const emails = { sent: 0, failed: 0 };
	for (const r of rows) {
		const total = Number(r.total) || 0;
		if (r.metric === 'request') appRequests += total;
		else if (r.metric === 'error') errors5xx += total;
		else if (r.metric === 'upload') {
			if (r.dim === 'ok') uploads.ok += total;
			else if (r.dim === 'fail') uploads.fail += total;
		} else if (r.metric === 'email') {
			if (r.dim === 'sent') emails.sent += total;
			else if (r.dim === 'failed') emails.failed += total;
		}
	}
	const errorRate = appRequests > 0 ? errors5xx / appRequests : 0;

	// Per-day request totals for the sparkline, mapped onto every day in the window
	// so gaps render as zero rather than collapsing the x-axis.
	const perDayMap = new Map(perDay.map((d) => [d.day, Number(d.total) || 0]));
	const sparkline = days.map((d) => perDayMap.get(d) ?? 0);

	const jobMap = new Map(jobRows.map((j) => [j.name, j]));
	const jobs: JobStatus[] = KNOWN_JOBS.map(({ name, label }) => {
		const row = jobMap.get(name);
		return {
			name,
			label,
			status: (row?.status as 'ok' | 'failed' | undefined) ?? null,
			ranAt: row?.ranAt ?? null,
			detail: row?.detail ?? null
		};
	});

	// Last upload / email failure surfaced from the error ring (route markers).
	const lastUploadFailure = recentErrors.find((e) => e.route === 'upload') ?? null;
	const lastEmailFailure = recentErrors.find((e) => e.route === 'email') ?? null;

	const storage: StorageHealth = {
		label: settings.storageProvider === 'r2' ? 'Cloudflare R2' : 'UploadThing',
		configured: settings.storageProvider === 'r2' ? !!env?.IMAGES : !!env?.UPLOADTHING_TOKEN,
		uploads: uploads.ok + uploads.fail,
		failed: uploads.fail,
		failRate: uploads.ok + uploads.fail > 0 ? uploads.fail / (uploads.ok + uploads.fail) : 0,
		lastFailure: lastUploadFailure
			? { message: lastUploadFailure.message, status: lastUploadFailure.status, ts: lastUploadFailure.ts }
			: null
	};

	const email: EmailHealth = {
		configured: !!env?.RESEND_API_KEY,
		sent: emails.sent,
		failed: emails.failed,
		lastFailure: lastEmailFailure
			? { message: lastEmailFailure.message, status: lastEmailFailure.status, ts: lastEmailFailure.ts }
			: null
	};

	const verdict = deriveVerdict({ errorRate, jobs, storage });

	// The optional Cloudflare edge query is NOT awaited here — it is streamed
	// separately from the page load (see +page.server.ts) so it never blocks the
	// in-app metrics or TTFB.
	return {
		windowDays: WINDOW_DAYS,
		appRequests,
		errors5xx,
		errorRate,
		uploads,
		emails,
		sparkline,
		recentErrors,
		jobs,
		verdict,
		providers: { storage, email }
	};
}

/**
 * Server-derived verdict: the single worst current signal, so the hero always
 * points at the one thing to look at. A failing background job is the clearest
 * actionable signal; a high 5xx rate is next. Copy is plain, no em dashes.
 */
export function deriveVerdict(input: {
	errorRate: number;
	jobs: JobStatus[];
	storage: StorageHealth;
}): Verdict {
	const failedJob = input.jobs.find((j) => j.status === 'failed');
	if (input.errorRate >= 0.1) {
		return {
			level: 'down',
			eyebrow: 'Needs attention',
			lead: `${(input.errorRate * 100).toFixed(1)}% of requests are failing.`,
			detail: 'Server errors are elevated over the last 7 days. Open the recent errors below to see what is breaking.'
		};
	}
	if (failedJob) {
		return {
			level: 'warn',
			eyebrow: 'Needs attention',
			lead: `${failedJob.label} failed on its last run.`,
			detail: 'Everything else is serving normally. Retry the job or open the error below.'
		};
	}
	if (input.errorRate >= 0.02) {
		return {
			level: 'warn',
			eyebrow: 'Keep an eye out',
			lead: `${(input.errorRate * 100).toFixed(1)}% of requests returned a server error.`,
			detail: 'Background jobs are healthy, but a few requests are failing. Check the recent errors below.'
		};
	}
	if (input.storage.failRate >= 0.1 && input.storage.uploads > 0) {
		return {
			level: 'warn',
			eyebrow: 'Keep an eye out',
			lead: 'Some uploads are failing.',
			detail: 'Requests and jobs are healthy, but the storage provider is rejecting uploads. See the storage panel below.'
		};
	}
	return {
		level: 'ok',
		eyebrow: 'All clear',
		lead: 'Everything is serving normally.',
		detail: 'No failing jobs and a low error rate over the last 7 days.'
	};
}

/**
 * OPTIONAL Cloudflare edge enrichment. Returns 'not-configured' unless all three
 * secrets are present; otherwise queries the GraphQL Analytics API (dataset
 * httpRequests1dGroups) for the window and returns the connected shape. Any
 * failure (network, 403 from a mis-scoped token, empty result from a bare
 * pages.dev with no zone) degrades to an 'error' state the UI shows as not
 * connected. Never throws — this is enrichment, never required.
 */
export async function getCloudflareEdge(env: App.Platform['env'] | undefined): Promise<CfEdge> {
	const token = env?.CLOUDFLARE_ANALYTICS_TOKEN;
	const zoneTag = env?.CLOUDFLARE_ZONE_ID;
	// CLOUDFLARE_ACCOUNT_ID is documented in the connect flow and validated for presence,
	// though the zone-scoped query keys off the zone tag.
	if (!token || !zoneTag || !env?.CLOUDFLARE_ACCOUNT_ID) return { state: 'not-configured' };

	const until = dayKey();
	const since = dayKey(new Date(Date.now() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000));
	const query = `query($zoneTag: String!, $since: Date!, $until: Date!) {
		viewer { zones(filter: { zoneTag: $zoneTag }) {
			httpRequests1dGroups(limit: ${WINDOW_DAYS}, filter: { date_geq: $since, date_leq: $until }) {
				sum { requests cachedRequests bytes cachedBytes threats }
			}
		} }
	}`;

	try {
		const resp = await fetch(CF_GRAPHQL_ENDPOINT, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables: { zoneTag, since, until } }),
			signal: AbortSignal.timeout(CF_TIMEOUT_MS)
		});
		if (!resp.ok) {
			return { state: 'error', message: `Cloudflare API returned ${resp.status}` };
		}
		const body = (await resp.json()) as {
			errors?: { message: string }[];
			data?: {
				viewer?: {
					zones?: { httpRequests1dGroups?: { sum: Record<string, number> }[] }[];
				};
			};
		};
		if (body.errors?.length) {
			return { state: 'error', message: body.errors[0].message };
		}
		const groups = body.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
		if (groups.length === 0) {
			// Empty result: either a bare pages.dev / token without the zone (no zone at
			// all), OR a valid but idle zone with no traffic in the window. We can't tell
			// them apart from this response, so the copy covers both rather than wrongly
			// insisting a custom domain is required.
			return {
				state: 'error',
				message: 'No zone analytics for this window yet — a custom domain must be connected, or the zone has had no traffic.'
			};
		}
		let requests = 0;
		let cachedRequests = 0;
		let bytes = 0;
		let threats = 0;
		for (const g of groups) {
			requests += g.sum.requests ?? 0;
			cachedRequests += g.sum.cachedRequests ?? 0;
			bytes += g.sum.bytes ?? 0;
			threats += g.sum.threats ?? 0;
		}
		return {
			state: 'connected',
			requests,
			cachedRequests,
			cacheHitRate: requests > 0 ? cachedRequests / requests : 0,
			bytes,
			threats
		};
	} catch (e) {
		return { state: 'error', message: e instanceof Error ? e.message : 'Cloudflare query failed' };
	}
}
