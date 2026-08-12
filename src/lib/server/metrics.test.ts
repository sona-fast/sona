import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { getDb } from './db';
import {
	recordMetric,
	recordError,
	recordUpload,
	recordEmail,
	recordJobRun,
	pageViewStatements,
	pruneVisitorRollups,
	dayKey,
	routeClass,
	isAssetPath,
	isObservabilityEnabled,
	deviceClass,
	referrerHost,
	countryCode,
	ERROR_SAMPLE_CAP
} from './metrics';

import { makeD1 } from '$lib/server/test/d1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSqlite(): any {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE metric_rollup (
			day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '',
			count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim)
		);
		CREATE TABLE error_sample (
			id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, route TEXT NOT NULL,
			status INTEGER NOT NULL, message TEXT NOT NULL
		);
		CREATE TABLE job_run (
			name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT
		);
	`);
	return sqlite;
}

describe('metrics — pure helpers', () => {
	it('dayKey is the UTC YYYY-MM-DD prefix', () => {
		expect(dayKey(new Date('2026-07-06T23:59:59Z'))).toBe('2026-07-06');
	});

	it('routeClass buckets by prefix', () => {
		expect(routeClass('/admin/observability')).toBe('admin');
		expect(routeClass('/api/upload')).toBe('api');
		expect(routeClass('/gallery')).toBe('public');
	});

	it('isAssetPath matches _app and favicons only', () => {
		expect(isAssetPath('/_app/immutable/x.js')).toBe(true);
		expect(isAssetPath('/favicon.ico')).toBe(true);
		expect(isAssetPath('/gallery')).toBe(false);
	});

	it('isObservabilityEnabled defaults OFF and is opt-in', () => {
		// Off for unset / empty / explicit-negative values.
		expect(isObservabilityEnabled(undefined)).toBe(false);
		expect(isObservabilityEnabled({})).toBe(false);
		for (const v of ['', 'false', '0', 'off', 'no', ' ', 'nope']) {
			expect(isObservabilityEnabled({ OBSERVABILITY_ENABLED: v })).toBe(false);
		}
		// On only for the accepted truthy tokens, case-insensitive + trimmed.
		for (const v of ['true', '1', 'on', 'yes', 'TRUE', 'On', ' yes ']) {
			expect(isObservabilityEnabled({ OBSERVABILITY_ENABLED: v })).toBe(true);
		}
	});
});

describe('recordMetric — bounded UPSERT', () => {
	it('increments the SAME (day, metric, dim) row instead of inserting a new one', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'public', 3); // explicit n

		const rows = sqlite.prepare('SELECT day, metric, dim, count FROM metric_rollup').all();
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(5);
		expect(rows[0].day).toBe(dayKey());
	});

	it('keeps different dims as separate rows', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordMetric(db, 'request', 'public');
		await recordMetric(db, 'request', 'admin');
		await recordMetric(db, 'upload', 'ok');

		const rows = sqlite.prepare("SELECT count FROM metric_rollup WHERE metric='request'").all();
		expect(rows).toHaveLength(2);
		const total = sqlite.prepare('SELECT SUM(count) c FROM metric_rollup').get();
		expect(total.c).toBe(3);
	});
});

describe('recordError — capped ring', () => {
	it('stores route + status + a trimmed message and prunes beyond the cap', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// One well past the cap to force a prune.
		const n = ERROR_SAMPLE_CAP + 5;
		for (let i = 0; i < n; i++) {
			await recordError(db, { route: `/r/${i}`, status: 500, message: `err ${i}` });
		}

		const { c } = sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get();
		expect(c).toBe(ERROR_SAMPLE_CAP);
		// The oldest 5 were pruned; the newest survive (highest ids kept).
		const min = sqlite.prepare('SELECT MIN(id) m FROM error_sample').get();
		expect(min.m).toBe(6);
	});

	it('collapses whitespace and clamps very long messages', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, { route: 'upload', status: 413, message: 'line one\n\n   line two' });
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('line one line two');

		await recordError(db, { route: 'x', status: 500, message: 'z'.repeat(500) });
		const rows = sqlite.prepare('SELECT message FROM error_sample ORDER BY id DESC').all();
		expect(rows[0].message.length).toBeLessThanOrEqual(300);
	});

	it('redacts email addresses and long token-like runs (no PII/secrets stored)', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: 'email',
			status: 500,
			message: 'send to user@example.com failed with key sk_live_0123456789abcdefABCDEF'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('user@example.com');
		expect(row.message).not.toContain('sk_live_0123456789abcdefABCDEF');
		expect(row.message).toContain('[redacted]');
		// Ordinary words are left intact.
		expect(row.message).toContain('failed');
	});

	it('redacts IPv4 and IPv6 literals (connection errors embed peer addresses)', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: 'x',
			status: 502,
			message: 'connect to 203.0.113.7 and [2001:db8::1] and ::1 refused'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('203.0.113.7');
		expect(row.message).not.toContain('2001:db8::1');
		expect(row.message).toContain('[redacted]');
		expect(row.message).toContain('refused');
	});

	it('leaves code punctuation alone — "::" in identifiers is not an IPv6 literal', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: 'x',
			status: 500,
			message: 'std::bad_alloc in .card::before handler threw Error::Timeout'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		// Hex-letter neighbours of code punctuation must survive unredacted.
		expect(row.message).toBe('std::bad_alloc in .card::before handler threw Error::Timeout');
	});

	it('still redacts real compressed IPv6 literals (a hex group must touch the "::")', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: 'x',
			status: 502,
			message: 'peers fe80::1 and ::1 and 2001:db8::8a2e:370:7334 unreachable'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('fe80::1');
		expect(row.message).not.toContain('::1');
		expect(row.message).not.toContain('2001:db8::8a2e:370:7334');
		expect(row.message).toBe('peers [redacted] and [redacted] and [redacted] unreachable');
	});

	it('redacts the bound-params tail of a drizzle-shaped message, keeping the query', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// DrizzleQueryError.message embeds the bound params after the SQL echo —
		// real names/emails land there. The \n becomes a space after collapse.
		await recordError(db, {
			route: '/admin/images',
			status: 500,
			message: 'Failed query: insert into "artists" ("name") values (?)\nparams: Jane Q. Artist'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('Failed query: insert into "artists" ("name") values (?) params: [redacted]');
	});

	it('redacts a punctuation-preceded params marker — "(params: …" fires the rule', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// A whitespace-only anchor misses a marker glued to '(' — the bound
		// values (real names) would be stored verbatim. The rule redacts to the
		// segment's end, so the closing ')' goes with the tail.
		await recordError(db, {
			route: '/admin/images',
			status: 500,
			message: 'Invalid arguments (params: Jane Doe)'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('Jane');
		expect(row.message).toBe('Invalid arguments (params: [redacted]');
	});

	it('still redacts an email-shaped segment in the route — and ONLY that segment', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: '/unsubscribe/user@example.com',
			status: 500,
			message: 'boom'
		});
		// Exact value: the leading path segment must survive — a \S+@\S+ rule
		// would swallow the WHOLE route (a path has no whitespace).
		const row = sqlite.prepare('SELECT route FROM error_sample').get();
		expect(row.route).toBe('/unsubscribe/[redacted]');
	});

	it('redacts only the @-carrying segment, keeping the rest of the path', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: '/stickers/winter-pack/@kira',
			status: 500,
			message: 'boom'
		});
		const row = sqlite.prepare('SELECT route FROM error_sample').get();
		expect(row.route).toBe('/stickers/winter-pack/[redacted]');
	});

	it('treats a percent-encoded at-sign (%40) as an email marker in the route', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: '/unsubscribe/user%40example.com',
			status: 500,
			message: 'boom'
		});
		const row = sqlite.prepare('SELECT route FROM error_sample').get();
		expect(row.route).toBe('/unsubscribe/[redacted]');
	});

	it('redacts an IP literal in the route', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: '/proxy/203.0.113.7',
			status: 502,
			message: 'boom'
		});
		const row = sqlite.prepare('SELECT route FROM error_sample').get();
		expect(row.route).not.toContain('203.0.113.7');
		expect(row.route).toBe('/proxy/[redacted]');
	});

	it('keeps a long ordinary slug route VERBATIM, only stripping its query string', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// The route is the sample's primary diagnostic key: the message-side
		// long-token rule must NOT apply to it ("/stickers/winter-holiday-pack-a1b2"
		// once stored as "/stickers/[redacted]", destroying the sample's value).
		await recordError(db, {
			route: '/stickers/winter-holiday-pack-a1b2?ref=home',
			status: 500,
			message: 'boom'
		});
		const row = sqlite.prepare('SELECT route FROM error_sample').get();
		expect(row.route).toBe('/stickers/winter-holiday-pack-a1b2');
	});

	it('stores no fragment of a secret cut in half by the pre-clamp', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// A 40-char key straddling the 1200-char pre-clamp boundary: the cut
		// strands a sub-20-char prefix ('sk_live_ZZ') that the 20+-token rule
		// would miss — the trailing-run trim must drop it entirely.
		const key = 'sk_live_' + 'Z'.repeat(32);
		await recordError(db, {
			route: 'x',
			status: 500,
			message: 'A'.repeat(1189) + ' ' + key
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('sk_live');
		expect(row.message).not.toContain('Z');
		expect(row.message).toBe('[redacted]');
	});

	it('lets nothing beyond the pre-clamp survive (giant single run)', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// The pre-clamp cuts inside the giant run; the trailing-run trim then
		// drops the truncated run itself — so neither a run fragment nor the
		// ' tail' beyond the clamp reaches storage. The emptied segment stores
		// the '[redacted]' marker, not '' — the sample should say something
		// was cut.
		await recordError(db, { route: 'x', status: 500, message: 'A'.repeat(5000) + ' tail' });
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('[redacted]');
	});

	it('drops whitespace-only segments — no dangling " ← " separator is stored', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// A wrapper whose message is pure whitespace (Error(' ') in a chain)
		// cleans to '' and must vanish, not leave 'root ← ← outer' litter.
		await recordError(db, {
			route: '/stickers/pack/1',
			status: 500,
			message: ['D1_ERROR: boom', '   ', 'outer wrapper']
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe('D1_ERROR: boom ← outer wrapper');
	});

	it("a ' ← ' inside a bound value of a RAW message cannot stop the params redaction early", async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// recordJobRun/recordUpload/recordEmail pass raw e.message: a raw string
		// is ONE segment, so a user-controlled bound value containing ' ← '
		// (artist name "Kira ← Nyx" in a failed cron-sync insert) must not fake
		// a chain boundary and leak the later bound params.
		await recordError(db, {
			route: '/api/cron/sync-artists',
			status: 500,
			message:
				'Failed query: insert into "artists" ("name", "email", "address") values (?, ?, ?)\nparams: Kira ← Nyx, victim2@example.com, 42 Elm St'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).not.toContain('Nyx');
		expect(row.message).not.toContain('Elm');
		expect(row.message).toBe(
			'Failed query: insert into "artists" ("name", "email", "address") values (?, ?, ?) params: [redacted]'
		);
	});

	it('params redaction stops at a SEGMENT-ARRAY boundary — later wrapper segments survive', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		// causeChainMessage passes the chain as an array (root first): the
		// drizzle segment's params redaction runs to that segment's end only,
		// keeping the wrapper segments after it readable.
		await recordError(db, {
			route: '/admin/images',
			status: 500,
			message: [
				'Failed query: insert into "artists" ("name") values (?) params: Jane Q. Artist',
				'Failed to save artist'
			]
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toBe(
			'Failed query: insert into "artists" ("name") values (?) params: [redacted] ← Failed to save artist'
		);
	});

	it('strips query strings from URLs but keeps the URL itself', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordError(db, {
			route: 'x',
			status: 500,
			message: 'fetch https://example.com/cb?code=s3cret&uid=42 failed'
		});
		const row = sqlite.prepare('SELECT message FROM error_sample').get();
		expect(row.message).toContain('https://example.com/cb');
		expect(row.message).not.toContain('code=s3cret');
		expect(row.message).not.toContain('uid=42');
		expect(row.message).toContain('failed');
	});
});

describe('recordUpload / recordEmail — outcome + failure sample', () => {
	it('recordUpload: success bumps only the ok rollup; failure bumps fail + one sample', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordUpload(db, true);
		await recordUpload(db, false, { status: 413, message: 'file too large' });

		const rollups = sqlite.prepare("SELECT dim, count FROM metric_rollup WHERE metric='upload' ORDER BY dim").all();
		expect(rollups).toEqual([
			{ dim: 'fail', count: 1 },
			{ dim: 'ok', count: 1 }
		]);
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: 'upload', status: 413, message: 'file too large' }]);
	});

	it('recordEmail: sent bumps only the sent rollup; failure bumps failed + one sample', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordEmail(db, true);
		await recordEmail(db, false, { status: 422, message: 'invalid from domain' });

		const rollups = sqlite.prepare("SELECT dim, count FROM metric_rollup WHERE metric='email' ORDER BY dim").all();
		expect(rollups).toEqual([
			{ dim: 'failed', count: 1 },
			{ dim: 'sent', count: 1 }
		]);
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: 'email', status: 422, message: 'invalid from domain' }]);
	});
});

describe('visitor capture helpers (issue #149) — reduce to PII-free labels', () => {
	it('deviceClass does NOT exclude legit UAs that merely contain a broad word', () => {
		// The generic substrings 'preview', 'monitor', 'scan', 'uptime' were tightened
		// out so a real browser carrying one isn't silently dropped.
		expect(deviceClass('Mozilla/5.0 (Windows NT 10.0) MonitorApp/1 Chrome/120')).toBe('desktop');
		expect(deviceClass('Mozilla/5.0 (iPhone) PreviewBrowser Mobile/15E148')).toBe('mobile');
		// But specific bot forms of those words are still excluded.
		expect(deviceClass('Mozilla/5.0 (compatible; UptimeRobot/2.0)')).toBeNull();
		expect(deviceClass('Mozilla/5.0 (compatible; bingpreview/1.0b)')).toBeNull();
	});

	it('deviceClass splits desktop / mobile / tablet and drops known bots + empty UA', () => {
		// Desktop.
		expect(deviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe('desktop');
		expect(deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605')).toBe('desktop');
		// Mobile: an Android *phone* UA carries "Mobile".
		expect(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148')).toBe('mobile');
		expect(deviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537')).toBe('mobile');
		// Tablet: iPad and an Android *tablet* UA (no "Mobile" token).
		expect(deviceClass('Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605')).toBe('tablet');
		expect(deviceClass('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari/537')).toBe('tablet');
		// Bots / crawlers / automation → null (excluded, never counted or stored).
		for (const ua of [
			'Googlebot/2.1 (+http://www.google.com/bot.html)',
			'Mozilla/5.0 (compatible; bingbot/2.0)',
			'facebookexternalhit/1.1',
			'curl/8.4.0',
			'python-requests/2.31',
			'Mozilla/5.0 ... HeadlessChrome/120'
		]) {
			expect(deviceClass(ua), ua).toBeNull();
		}
		// No UA at all is treated as non-human.
		expect(deviceClass('')).toBeNull();
		expect(deviceClass(null)).toBeNull();
	});

	it('referrerHost keeps ONLY the host and drops same-site + junk (no path/query stored)', () => {
		// Full URL with a path + query reduces to the bare host — the query, which can
		// carry personal data, is never returned. Leading www. is stripped.
		expect(referrerHost('https://t.co/abc?utm_source=x&uid=secret', 'taro.surf')).toBe('t.co');
		expect(referrerHost('https://www.Google.com/search?q=me', 'taro.surf')).toBe('google.com');
		// Same-site navigation is not a referring host — including a www-vs-apex self
		// referral either way round.
		expect(referrerHost('https://taro.surf/gallery', 'taro.surf')).toBeNull();
		expect(referrerHost('https://www.taro.surf/gallery', 'taro.surf')).toBeNull();
		expect(referrerHost('https://taro.surf/gallery', 'www.taro.surf')).toBeNull();
		// Empty / unparseable.
		expect(referrerHost(null, 'taro.surf')).toBeNull();
		expect(referrerHost('not a url', 'taro.surf')).toBeNull();
	});

	it('referrerHost drops oversized/malformed hosts (attacker-controlled Referer)', () => {
		// A host past the 253-char DNS limit can't bloat a counter key: dropped.
		const huge = 'https://' + 'a'.repeat(300) + '.com/';
		expect(referrerHost(huge, 'taro.surf')).toBeNull();
		// A host at the limit is still accepted.
		const ok = 'a'.repeat(245) + '.com'; // 249 chars
		expect(referrerHost(`https://${ok}/x`, 'taro.surf')).toBe(ok);
		// An IPv6 literal (brackets) isn't a plausible DNS name: dropped.
		expect(referrerHost('https://[2001:db8::1]/x', 'taro.surf')).toBeNull();
	});

	it('countryCode accepts a real 2-letter code and rejects placeholders', () => {
		expect(countryCode('US')).toBe('US');
		expect(countryCode('gb')).toBe('GB');
		expect(countryCode('XX')).toBeNull(); // CF "unknown"
		expect(countryCode('T1')).toBeNull(); // Tor
		expect(countryCode('')).toBeNull();
		expect(countryCode(null)).toBeNull();
	});
});

describe('pageViewStatements — Tier-A counters in one batch, no per-visitor row', () => {
	it('bumps pageview/device and, when present, referrer/country — nothing else', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await db.batch(
			pageViewStatements(db, { path: '/gallery', device: 'mobile', referrerHost: 't.co', country: 'US' }) as [
				never,
				...never[]
			]
		);

		const rows = sqlite.prepare('SELECT metric, dim, count FROM metric_rollup ORDER BY metric, dim').all();
		expect(rows).toEqual([
			{ metric: 'country', dim: 'US', count: 1 },
			{ metric: 'device', dim: 'mobile', count: 1 },
			{ metric: 'pageview', dim: '/gallery', count: 1 },
			{ metric: 'referrer', dim: 't.co', count: 1 }
		]);
	});

	it('omits the referrer and country counters when they are absent (direct hit)', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		const stmts = pageViewStatements(db, { path: '/', device: 'desktop', referrerHost: null, country: null });
		expect(stmts).toHaveLength(2); // pageview + device only
		await db.batch(stmts as [never, ...never[]]);

		const metrics = sqlite.prepare('SELECT DISTINCT metric FROM metric_rollup ORDER BY metric').all();
		expect(metrics).toEqual([{ metric: 'device' }, { metric: 'pageview' }]);
	});

	it('stores ONLY counter keys — never a raw UA or IP string anywhere in the row', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await db.batch(
			pageViewStatements(db, { path: '/about', device: 'desktop', referrerHost: 'bsky.app', country: 'DE' }) as [
				never,
				...never[]
			]
		);

		// Every stored dim is a reduced label; none is a UA/IP-shaped string.
		const dims = sqlite.prepare('SELECT dim FROM metric_rollup').all().map((r: { dim: string }) => r.dim);
		expect(dims.sort()).toEqual(['/about', 'DE', 'bsky.app', 'desktop']);
		for (const d of dims) {
			expect(d).not.toMatch(/Mozilla|\d+\.\d+\.\d+\.\d+/); // no user-agent, no dotted-quad IP
		}
	});
});

describe('pruneVisitorRollups — Tier-A retention, operational metrics untouched', () => {
	it('deletes visitor rows older than the window and leaves recent + operational rows', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));
		const seed = sqlite.prepare('INSERT INTO metric_rollup (day, metric, dim, count) VALUES (?, ?, ?, ?)');
		const day = (n: number) => dayKey(new Date(Date.now() - n * 86400000));

		// Old Tier-A rows (past retention) — must be pruned.
		seed.run(day(40), 'pageview', '/old', 5);
		seed.run(day(40), 'referrer', 'spam.example', 9);
		// Recent Tier-A rows (inside retention) — must survive.
		seed.run(day(3), 'pageview', '/', 20);
		// Old OPERATIONAL rows — must survive (health metrics keep their history).
		seed.run(day(40), 'request', 'public', 100);
		seed.run(day(40), 'error', '500', 2);

		await pruneVisitorRollups(db, 35);

		const rows = sqlite.prepare('SELECT metric, dim FROM metric_rollup ORDER BY metric, dim').all();
		expect(rows).toEqual([
			{ metric: 'error', dim: '500' }, // operational, old, kept
			{ metric: 'pageview', dim: '/' }, // Tier-A, recent, kept
			{ metric: 'request', dim: 'public' } // operational, old, kept
		]);
	});
});

describe('recordJobRun — heartbeat upsert', () => {
	it('keeps one row per job, overwriting with the latest run', async () => {
		const sqlite = makeSqlite();
		const db = getDb(makeD1(sqlite));

		await recordJobRun(db, 'cleanup-orphans', 'ok', 'deleted 3');
		await recordJobRun(db, 'cleanup-orphans', 'failed', 'R2 error');

		const rows = sqlite.prepare('SELECT name, status, detail FROM job_run').all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'cleanup-orphans', status: 'failed', detail: 'R2 error' });
	});
});
