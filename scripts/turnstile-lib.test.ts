import { describe, it, expect } from 'vitest';
import type { CfApiResult } from './setup-lib.ts';
import {
	provisionTurnstileWidget,
	buildCreateBody,
	WIDGET_NAME,
	WIDGET_MODE
} from './turnstile-lib.ts';

const TOKEN = 'cf-secret-token-value-should-never-leak';
const WIDGET_SECRET = 'turnstile-widget-secret-should-never-leak';
const ACCT = 'acct123';
const SITEKEY = '0x4AAAAAAAsitekey';

interface Call {
	token: string;
	path: string;
	method: string;
	body?: unknown;
}

/**
 * Builds a fake `cfApi` that never touches the network: it records every call and
 * answers from a path+method → result map. Any path not in the map returns a 500,
 * which surfaces as an unexpected-call failure in assertions.
 */
function fakeApi(routes: Record<string, CfApiResult>) {
	const calls: Call[] = [];
	const api = async (
		token: string,
		path: string,
		init: { method?: string; body?: unknown } = {}
	): Promise<CfApiResult> => {
		const method = init.method ?? 'GET';
		calls.push({ token, path, method, body: init.body });
		return routes[`${method} ${path}`] ?? routes[path] ?? { ok: false, status: 500 };
	};
	return { api, calls };
}

const listPath = `GET /accounts/${ACCT}/challenges/widgets?per_page=50`;
const createPath = `POST /accounts/${ACCT}/challenges/widgets`;
const getPath = `GET /accounts/${ACCT}/challenges/widgets/${SITEKEY}`;

describe('buildCreateBody', () => {
	it('encodes the stable name, the domain, and managed mode', () => {
		expect(buildCreateBody('akito.dog')).toEqual({
			name: WIDGET_NAME,
			domains: ['akito.dog'],
			mode: WIDGET_MODE
		});
		expect(WIDGET_NAME).toBe('sona-admin-login');
		expect(WIDGET_MODE).toBe('managed');
	});
});

describe('provisionTurnstileWidget — creates when absent', () => {
	it('POSTs a new widget when none of ours exists, returning sitekey + secret', async () => {
		const { api, calls } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('created');
		expect(res.sitekey).toBe(SITEKEY);
		expect(res.secret).toBe(WIDGET_SECRET);

		const post = calls.find((c) => c.method === 'POST');
		expect(post?.path).toBe(`/accounts/${ACCT}/challenges/widgets`);
		expect(post?.body).toEqual({ name: WIDGET_NAME, domains: ['akito.dog'], mode: WIDGET_MODE });
		// No get-by-sitekey when we just created it.
		expect(calls.some((c) => c.path.endsWith(`/widgets/${SITEKEY}`))).toBe(false);
	});

	it('ignores widgets with a different name and creates ours', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: 'someone-elses-widget', sitekey: 'other-key' }]
			},
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('created');
		// Never fetched the unrelated widget's secret.
		expect(calls.some((c) => c.path.includes('other-key'))).toBe(false);
	});
});

describe('provisionTurnstileWidget — reuses when present (idempotent)', () => {
	it('finds our widget by name and reads its secret via the single-widget GET', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: WIDGET_NAME, sitekey: SITEKEY }]
			},
			[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('exists');
		expect(res.sitekey).toBe(SITEKEY);
		expect(res.secret).toBe(WIDGET_SECRET);
		// Reuse must NOT create a duplicate.
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		const get = calls.find((c) => c.path === `/accounts/${ACCT}/challenges/widgets/${SITEKEY}`);
		expect(get?.method).toBe('GET');
	});

	it('errors (no mutation) when the existing widget’s secret cannot be read', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: WIDGET_NAME, sitekey: SITEKEY }]
			},
			// GET succeeds but returns no secret (e.g. a partial/blank body).
			[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.secret).toBeUndefined();
		expect(res.detail).toContain('could not read its secret');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});

describe('provisionTurnstileWidget — clear errors, no mutation', () => {
	it('token lacks Turnstile scope (list 403) → error naming the scope, no create', async () => {
		const { api, calls } = fakeApi({
			[listPath]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('Turnstile: Edit');
		// Only the list GET happened — never proceeded to create.
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('GET');
	});

	it('create call fails → scoped error, sitekey/secret absent', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to create');
		expect(res.sitekey).toBeUndefined();
		expect(res.secret).toBeUndefined();
	});

	it('create returns ok but a body with no sitekey/secret → error', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: true, status: 200, result: {} }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
	});

	it('empty domain → error before any network call', async () => {
		const { api, calls } = fakeApi({});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, '   ', api);
		expect(res.status).toBe('error');
		expect(calls).toHaveLength(0);
	});
});

describe('provisionTurnstileWidget — never leaks the token or the widget secret', () => {
	it('the CF token appears in no returned detail and only ever rides as the first arg', async () => {
		const { api, calls } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.detail).not.toContain(TOKEN);
		for (const c of calls) {
			expect(c.token).toBe(TOKEN);
			expect(c.path).not.toContain(TOKEN);
			expect(JSON.stringify(c.body ?? '')).not.toContain(TOKEN);
		}
	});

	it('the widget secret never appears in a detail string, across create and reuse', async () => {
		const scenarios: Record<string, CfApiResult>[] = [
			// created
			{
				[listPath]: { ok: true, status: 200, result: [] },
				[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
			},
			// reused
			{
				[listPath]: { ok: true, status: 200, result: [{ name: WIDGET_NAME, sitekey: SITEKEY }] },
				[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
			}
		];
		for (const routes of scenarios) {
			const { api } = fakeApi(routes);
			const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
			expect(res.detail).not.toContain(WIDGET_SECRET);
			// The secret is still returned for wiring — just never in the printable detail.
			expect(res.secret).toBe(WIDGET_SECRET);
		}
	});
});
