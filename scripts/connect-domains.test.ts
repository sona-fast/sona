import { describe, it, expect, vi, afterEach } from 'vitest';
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

	it('always returns 0 (diagnostic), even when a rung hard-fails', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		// Domain unreachable → cdn-loads fails, but the command still exits 0.
		const { api } = recordingApi();
		const code = await runDoctor(args(), deps(api, 0));
		spy.mockRestore();
		expect(code).toBe(0);
	});
});
