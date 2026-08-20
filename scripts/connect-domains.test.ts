import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, type DoctorArgs, type DoctorDeps } from './connect-domains.ts';
import type { CfApiResult } from './setup-lib.ts';

const zone = { exists: true, active: true, id: 'z1' };

const args = (over: Partial<DoctorArgs> = {}): DoctorArgs => ({
	cfToken: 'v1.0-SUPERSECRET-tok-DEADBEEFcafef00d',
	cfAccount: 'acct-1234567890',
	bucket: 'taro-surf-images',
	host: 'taro.surf',
	cdn: 'cdn.taro.surf',
	zone,
	dbName: '',
	...over
});

/** A recording api stub: logs every (path, method) and answers healthy by default. */
function recordingApi(overrides: Record<string, CfApiResult> = {}) {
	const calls: { path: string; method?: string }[] = [];
	const api: DoctorDeps['api'] = async (_token, path, init) => {
		calls.push({ path, method: init?.method });
		for (const [frag, res] of Object.entries(overrides)) if (path.includes(frag)) return res;
		if (path.includes('/domains/custom'))
			return {
				ok: true,
				status: 200,
				result: { domains: [{ domain: 'cdn.taro.surf', enabled: true, status: { ssl: 'active' } }] }
			};
		if (path.includes('image_resizing')) return { ok: true, status: 200, result: { value: 'on' } };
		return { ok: true, status: 200, result: {} };
	};
	return { api, calls };
}

const deps = (api: DoctorDeps['api'], probeStatus = 200): DoctorDeps => ({
	api,
	probeCdn: async () => probeStatus,
	readSiteUrl: () => null
});

describe('runDoctor', () => {
	afterEach(() => vi.restoreAllMocks());

	it('issues ZERO mutations — every API call is a read (mutation discipline)', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { api, calls } = recordingApi();
		await runDoctor(args(), deps(api));
		spy.mockRestore();
		expect(calls.length).toBeGreaterThan(0);
		// No call carries a write method; the doctor only GETs.
		expect(calls.every((c) => c.method === undefined || c.method === 'GET')).toBe(true);
		expect(calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
	});

	it('renders secret-free output — the token never appears, even though it is in scope', async () => {
		const out: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
			out.push(a.join(' '));
		});
		const a = args();
		const { api } = recordingApi();
		await runDoctor(a, deps(api));
		spy.mockRestore();
		const text = out.join('\n');
		expect(text).not.toContain(a.cfToken);
		expect(text).not.toContain(a.cfAccount);
		expect(text).toContain('All connect-domains checks pass.');
	});

	it('renders a 403 on the R2 read as "couldn\'t verify", NOT "not attached" (auth-vs-absent)', async () => {
		const out: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...x) => {
			out.push(x.join(' '));
		});
		const { api } = recordingApi({ '/domains/custom': { ok: false, status: 403 } });
		// Probe still passes (independent HTTPS check), so the only non-pass is the warn.
		await runDoctor(args(), deps(api, 200));
		spy.mockRestore();
		const text = out.join('\n');
		expect(text).toMatch(/Couldn't verify/);
		expect(text).not.toMatch(/Next action:/); // a warn is not a hard failure
	});

	it('names the RESOLVED (parent) zone in the transforms rung for a subdomain host', async () => {
		const out: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...x) => {
			out.push(x.join(' '));
		});
		const { api } = recordingApi({ image_resizing: { ok: true, status: 200, result: { value: 'off' } } });
		await runDoctor(
			args({
				host: 'sona.taro.surf',
				cdn: 'cdn.sona.taro.surf',
				zoneName: 'taro.surf',
				candidates: ['sona.taro.surf', 'taro.surf']
			}),
			deps(api)
		);
		spy.mockRestore();
		const text = out.join('\n');
		expect(text).toContain('the taro.surf zone');
	});

	it('tells a no-zone operator to add the domain they registered, naming the zones tried', async () => {
		const out: string[] = [];
		const spy = vi.spyOn(console, 'log').mockImplementation((...x) => {
			out.push(x.join(' '));
		});
		const { api, calls } = recordingApi();
		await runDoctor(
			args({
				host: 'sona.taro.surf',
				cdn: 'cdn.sona.taro.surf',
				zone: { exists: false, active: false },
				zoneName: null,
				candidates: ['sona.taro.surf', 'taro.surf']
			}),
			deps(api)
		);
		spy.mockRestore();
		expect(calls).toEqual([]); // no zone → nothing else to look up
		const text = out.join('\n');
		expect(text).toContain('Add the domain you registered to this Cloudflare account');
		expect(text).toContain('Looked for zones named sona.taro.surf, taro.surf');
		expect(text).not.toContain('Add the root domain');
	});

	// One 'unknown' outcome, several causes. The doctor threads the read's own
	// status and errors into the rung, so a 5xx or an unreachable API never reads
	// as "your token is missing a scope".
	it('gives the Image Transformations rung a different reason per failure status', async () => {
		const render = async (ir: CfApiResult) => {
			const out: string[] = [];
			const spy = vi.spyOn(console, 'log').mockImplementation((...x) => {
				out.push(x.join(' '));
			});
			const { api } = recordingApi({ image_resizing: ir });
			await runDoctor(args(), deps(api));
			spy.mockRestore();
			return out.join('\n');
		};

		const denied = await render({ ok: false, status: 403 });
		expect(denied).toContain('token needs Zone → Zone Settings: Read');

		const server = await render({
			ok: false,
			status: 500,
			errors: [{ code: 10000, message: 'Internal error' }]
		});
		expect(server).not.toContain('Zone → Zone Settings: Read');
		expect(server).toContain('(HTTP 500)');
		expect(server).toContain('the API said 10000: Internal error');

		const offline = await render({ ok: false, status: 0 });
		expect(offline).not.toContain('Zone → Zone Settings: Read');
		expect(offline).toContain('the Cloudflare API did not respond');
	});

	it('always returns 0 (diagnostic), even when a rung hard-fails', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		// Domain unreachable → cdn-loads fails, but the command still exits 0.
		const { api } = recordingApi();
		const code = await runDoctor(args(), deps(api, 0));
		spy.mockRestore();
		expect(code).toBe(0);
	});
});

describe('connect-domains.ts ↔ candidate-walk source contract', () => {
	// main() isn't importable without running the CLI, so pin the subdomain zone
	// wiring at the source level: the host's candidate list must be built via
	// zoneNameCandidates and flow into BOTH resolveZone (the walk) and
	// zoneGuidance (the no-zone message). Reverting to a bare [host] would
	// silently break subdomain hosts again. Whitespace-tolerant, wiring-only
	// assertions — message wording is covered behaviorally in the lib tests.
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'connect-domains.ts'),
		'utf8'
	);

	it('builds the candidate list with zoneNameCandidates(host)', () => {
		expect(src).toMatch(/zoneNameCandidates\(\s*host\s*\)/);
	});

	it('passes the candidates to resolveZone', () => {
		expect(src).toMatch(/resolveZone\(\s*candidates/);
	});

	it('attributes the API reason on the zone-lookup error line', () => {
		// Three sites print '; the API said …' (this one, setup.ts's warn, and
		// cfFailureTail); pin this inline copy so the wording cannot drift back
		// to a bare parenthetical.
		expect(src).toContain('; the API said ${apiWhy}');
		expect(src).not.toContain('(${apiWhy})');
	});

	it('passes the candidates to zoneGuidance', () => {
		expect(src).toMatch(/zoneGuidance\(\s*zone,\s*host,\s*candidates,\s*zoneName\s*\)/);
	});

	// Consent honesty: the confirm prompt covers a zone-wide mutation, so it must
	// name the RESOLVED zone via zoneConsentLabel — reverting to `the ${host}
	// zone` (the round-3 bug) would mislead subdomain operators with every
	// behavioral test still green. The transforms bullet's whole-zone disclosure
	// is pinned the same way.
	it('derives the consent label via zoneConsentLabel and prints it', () => {
		expect(src).toMatch(/zoneConsentLabel\(\s*host,\s*zoneName\s*\)/);
		expect(src).toMatch(/your account and \$\{zoneLabel\}/);
	});

	it('keeps the whole-zone disclosure on the transforms bullet', () => {
		expect(src).toMatch(/affects the whole zone, not just \$\{host\}/);
	});

	it('reads the API reason whatever the status was', () => {
		// Gating the summary on a 2xx dropped it for 400/404/500 — the statuses whose
		// reason the operator most needs, since a 2xx-with-success:false is the only
		// one they could have guessed at.
		expect(src).toContain('const apiWhy = cfErrorSummary(errors);');
		expect(src).not.toContain('errorStatus >= 200 && errorStatus < 300');
	});
});

// Every other failed call in the mutating path reports through cfFailureTail, so
// the reason tracks the status: the scope only on 401/403, the API's own words
// when it gave any, and the network line for a thrown fetch. The previous copy
// recommended the R2 read scope for every failure — including a 5xx and an
// unreachable API — and printed a bare "(HTTP 0)" carrying nothing.
describe('connect-domains.ts ↔ failure-reporting source contract', () => {
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'connect-domains.ts'),
		'utf8'
	);

	it('reports the R2 custom-domain read through cfFailureTail', () => {
		expect(src).toMatch(/cfFailureTail\(\s*r2Res\.status,\s*r2Res\.errors,\s*'Account → Workers R2 Storage: Read'/);
		expect(src).not.toContain('token may lack Account → Workers R2 Storage: Read');
	});

	it("reports a failed attach with that mutation's own scope, never a bare HTTP 0", () => {
		expect(src).toContain('cfFailureTail(res.status, res.errors, m.scopeHint)');
		expect(src).not.toContain('(HTTP ${res.status})');
	});

	it('reports a failed Image Transformations enable the same way', () => {
		expect(src).toMatch(/cfFailureTail\(\s*patched\.status,\s*patched\.errors,\s*'Zone → Zone Settings: Edit'/);
		expect(src).not.toContain('(HTTP ${patched.status})');
	});

	it('uses statusLabel so a thrown fetch prints no status at all', () => {
		expect(src).toContain('statusLabel(r2Res.status)');
		expect(src).toContain('statusLabel(res.status)');
		expect(src).toContain('statusLabel(patched.status)');
	});

	it('reports the Pages-domain read through cfFailureTail as well', () => {
		expect(src).toMatch(
			/cfFailureTail\(\s*pagesRes\.status,\s*pagesRes\.errors,\s*'Account → Cloudflare Pages: Read'/
		);
		expect(src).toContain('statusLabel(pagesRes.status)');
	});

	it('reads the Image Transformations reason off the response, not off a fixed scope', () => {
		expect(src).toMatch(
			/cfFailureTail\(\s*irGet\.status,\s*irGet\.errors,\s*'Zone → Zone Settings: Read'/
		);
		expect(src).not.toContain('token lacks Zone → Zone Settings: Read');
	});
});

// A read that failed is the one that would have told us whether the mutation is
// needed, so it can't license the mutation. main() self-executes and isn't
// importable, so pin the wiring at the source level; the behavior itself is
// covered in connect-domains-lib.test.ts (pagesDomainState + planConnect).
describe('connect-domains.ts ↔ never-mutate-on-an-unread-state contract', () => {
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'connect-domains.ts'),
		'utf8'
	);

	it('derives the Pages attach from pagesDomainState, which reports a failed read as unknown', () => {
		expect(src).toMatch(/pagesDomainState\(\s*pagesRes,\s*host\s*\)/);
		expect(src).toContain("pagesPresent: pagesState !== 'absent'");
		// The old wiring read the list off a possibly-failed response, so a 403
		// became "not attached" and the attach went out anyway.
		expect(src).not.toContain('pagesDomainAttached(pagesRes.result, host)');
	});

	it('skips the attach and says so when either read came back unknown', () => {
		expect(src).toMatch(/pagesState === 'unknown'/);
		expect(src).toMatch(/skipping the \$\{host\} attach/);
		expect(src).toMatch(/skipping the \$\{cdn\} attach/);
	});

	it('never claims "Already connected" off a read that failed', () => {
		expect(src).toMatch(/const unread = cdnState === 'unknown' \? cdn : pagesState === 'unknown' \? host : null/);
	});
});
