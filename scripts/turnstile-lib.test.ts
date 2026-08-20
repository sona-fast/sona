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

const PER_PAGE = 50;
const listPage = (page: number) =>
	`GET /accounts/${ACCT}/challenges/widgets?page=${page}&per_page=${PER_PAGE}&order=created_on&direction=asc`;
const listPath = listPage(1);
/** A full page of widgets belonging to nobody we care about. */
const fullPageOfStrangers = (tag: string) =>
	Array.from({ length: PER_PAGE }, (_, i) => ({
		name: `stranger-${tag}-${i}`,
		sitekey: `stranger-key-${tag}-${i}`,
		domains: ['someone-else.example']
	}));
const createPath = `POST /accounts/${ACCT}/challenges/widgets`;
const getPath = `GET /accounts/${ACCT}/challenges/widgets/${SITEKEY}`;
// This fork's own widget, exactly as the list returns it.
const ourWidget = { name: WIDGET_NAME, sitekey: SITEKEY, domains: ['akito.dog'] };

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
	it('finds our widget by name + host and reads its secret via the single-widget GET', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [ourWidget]
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

	// One Cloudflare account can hold several forks, and every fork's widget carries
	// the same stable name — so the host, not the name alone, is what identifies ours.
	// Reusing a sibling fork's widget would hand this fork a sitekey scoped to the
	// wrong domain: every Turnstile verify then fails and, the check being
	// fail-closed, the
	// admin login locks. A duplicate widget is the acceptable failure; this is not.
	it('ignores a same-name widget issued for a SIBLING fork and creates ours', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: WIDGET_NAME, sitekey: 'sibling-fork-key', domains: ['sparky.ink'] }]
			},
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('created');
		expect(res.sitekey).toBe(SITEKEY);
		// Never adopted the sibling's sitekey, and never read its secret.
		expect(res.sitekey).not.toBe('sibling-fork-key');
		expect(calls.some((c) => c.path.includes('sibling-fork-key'))).toBe(false);
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body).toEqual({ name: WIDGET_NAME, domains: ['akito.dog'], mode: WIDGET_MODE });
	});

	it('picks OUR host out of a multi-fork account listing several of our widgets', async () => {
		const { api } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: WIDGET_NAME, sitekey: 'sparky-key', domains: ['sparky.ink'] }, ourWidget]
			},
			[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('exists');
		// The FIRST listed widget is a sibling's — order must not decide the match.
		expect(res.sitekey).toBe(SITEKEY);
	});

	it('treats a widget with no domains field as not ours (creates rather than reuses)', async () => {
		const { api } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [{ name: WIDGET_NAME, sitekey: 'domainless-key' }]
			},
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('created');
		expect(res.sitekey).toBe(SITEKEY);
	});

	it('errors (no mutation) when the existing widget’s secret cannot be read', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [ourWidget]
			},
			// GET succeeds but returns no secret (e.g. a partial/blank body).
			[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.secret).toBeUndefined();
		expect(res.detail).toContain('could not read its secret');
		// The GET was a 200 — a blank body is not a token-scope FAILURE, but the
		// one actionable lead is still the token's read-vs-edit scope.
		expect(res.detail).not.toContain('token needs');
		expect(res.detail).toContain('the widget came back without one');
		expect(res.detail).toContain('check that the token has');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});
});

// An account can hold more widgets than one page returns. Reading only the first
// page would miss ours and the re-run would mint a duplicate, rewiring Pages to a
// fresh sitekey/secret, so the list has to be walked page by page.
describe('provisionTurnstileWidget — walks past the first list page', () => {
	it('finds and reuses our widget when it sits on page 2', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: fullPageOfStrangers('p1') },
			[listPage(2)]: { ok: true, status: 200, result: [ourWidget] },
			[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('exists');
		expect(res.sitekey).toBe(SITEKEY);
		expect(res.secret).toBe(WIDGET_SECRET);
		// The whole point: no duplicate widget.
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		// Stopped at the match rather than reading on.
		expect(calls.some((c) => c.path.includes('page=3'))).toBe(false);
		// Offsets only mean the same thing page to page under an explicit sort.
		expect(calls[0].path).toContain('order=created_on&direction=asc');
	});

	it('creates exactly once after two full pages hold no widget of ours', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: fullPageOfStrangers('p1') },
			[listPage(2)]: { ok: true, status: 200, result: fullPageOfStrangers('p2') },
			[listPage(3)]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('created');
		expect(res.sitekey).toBe(SITEKEY);
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
		// The empty third page ended the walk.
		expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
	});

	// A body that isn't a list reads as a zero-length page, which looks exactly like
	// the last page of the walk — so the old `?? []` ended the walk and created a
	// second widget for a fork that already had one.
	it('an ok page whose body is not a list errors instead of creating a duplicate', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: { widgets: [ourWidget] } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('could not list Turnstile widgets');
		expect(res.detail).toContain('HTTP 200');
		expect(res.detail).toContain('carried no widget list');
		// The reason is the body's shape, not the token — no scope misdirection.
		expect(res.detail).not.toContain('token needs');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a missing result on a later page errors rather than ending the walk quietly', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: fullPageOfStrangers('p1') },
			[listPage(2)]: { ok: true, status: 200 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('carried no widget list');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a failure on page 2 reports it the same way a first-page failure does', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: fullPageOfStrangers('p1') },
			[listPage(2)]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('could not list Turnstile widgets');
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('Turnstile: Edit');
		// A failed page must never fall through to a create.
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	// An API that ignored `page` would hand back the same full page forever. The fake
	// here is a handler rather than a route map so it can do exactly that: every list
	// request answers with a full page of strangers, whatever page was asked for.
	it('stops after MAX_PAGES when every page comes back full, without creating', async () => {
		const calls: Call[] = [];
		const api = async (
			token: string,
			path: string,
			init: { method?: string; body?: unknown } = {}
		): Promise<CfApiResult> => {
			const method = init.method ?? 'GET';
			calls.push({ token, path, method, body: init.body });
			// Trip fast if the page bound is ever removed: without this, an unbounded
			// walk only dies by exhausting the heap minutes later, taking the whole
			// file's results with it and reading as CI flake instead of a lost bound.
			if (calls.filter((c) => c.method === 'GET').length > 25) {
				throw new Error('walk exceeded MAX_PAGES — the page bound is gone');
			}
			if (method === 'POST') {
				return { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } };
			}
			return { ok: true, status: 200, result: fullPageOfStrangers('endless') };
		};

		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);

		// Terminated at the bound instead of hanging.
		expect(calls.filter((c) => c.method === 'GET')).toHaveLength(20);
		// Ending on a full page is not the end of the list: ours could sit on page 21.
		// Creating here would mint a duplicate for the same name+host, after which
		// every later run matches whichever one comes back first — so the walk stops
		// and says what it could not rule out.
		expect(res.status).toBe('error');
		expect(res.detail).toContain('first 20 pages');
		expect(res.detail).toContain('did not end there');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('a page holding a non-object entry errors instead of throwing', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: { ok: true, status: 200, result: [null] }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('carried no widget list');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('an entry whose domains is not a list never matches', async () => {
		const { api, calls } = fakeApi({
			[listPage(1)]: {
				ok: true,
				status: 200,
				result: [{ ...ourWidget, domains: 'akito.dog' }]
			},
			[createPath]: { ok: true, status: 200, result: { sitekey: SITEKEY, secret: WIDGET_SECRET } }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		// A short page ended the walk, so absence is proven and the create is right.
		expect(res.status).toBe('created');
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
	});
});

describe('provisionTurnstileWidget — clear errors, no mutation', () => {
	it('token lacks Turnstile scope (list 403) → error naming the scope, no create', async () => {
		const { api, calls } = fakeApi({
			[listPath]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('Turnstile: Edit');
		// Only the list GET happened — never proceeded to create.
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('GET');
	});

	it('a 401 list names the scope too — both permission statuses hint', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: false, status: 401 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 401');
		expect(res.detail).toContain('token needs');
		expect(res.detail).toContain('Turnstile: Edit');
	});

	it('a 403 secret read names the scope, and no create fires', async () => {
		const { api, calls } = fakeApi({
			[listPath]: {
				ok: true,
				status: 200,
				result: [ourWidget]
			},
			[getPath]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('could not read its secret');
		expect(res.detail).toContain('token needs');
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	// New contract: a 500 stays bare only when the body carried no usable
	// errors (this fixture has none); with errors the reason is appended.
	it('a transient list failure (500, no errors body) reports the status without blaming token scope', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: false, status: 500 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 500');
		expect(res.detail).not.toContain('token needs');
	});

	it('create call fails with 403 → scoped error, sitekey/secret absent', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: false, status: 403 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to create');
		expect(res.detail).toContain('token needs');
		expect(res.sitekey).toBeUndefined();
		expect(res.secret).toBeUndefined();
	});

	it('create returns ok but a body with no sitekey/secret → error, no scope blame', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: true, status: 200, result: {} }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		// The ok create just proved the token's scope, so no scope advice — and
		// no claim about whether the widget exists, because we can't know.
		expect(res.detail).not.toContain('token needs');
		expect(res.detail).not.toContain('confirm the token');
		expect(res.detail).toContain(
			'the response carried no sitekey/secret, so the widget may exist but setup could not read its keys'
		);
	});

	// cfApi maps a 2xx whose body says success:false to ok=false — a bare
	// '(HTTP 200)' would be nonsense, so the detail carries the error summary.
	it('a 200 list whose body says success:false repeats the API’s own reason', async () => {
		const { api } = fakeApi({
			[listPath]: {
				ok: false,
				status: 200,
				errors: [{ code: 1001, message: 'account is on hold' }]
			}
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('HTTP 200');
		expect(res.detail).toContain('the API reported failure (1001: account is on hold)');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 200 secret read whose body says success:false repeats the reason too', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [ourWidget] },
			[getPath]: { ok: false, status: 200, errors: [{ code: 1002, message: 'widget is locked' }] }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('could not read its secret');
		expect(res.detail).toContain('the API reported failure (1002: widget is locked)');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 200 create whose body says success:false repeats the reason too', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: true, status: 200, result: [] },
			[createPath]: { ok: false, status: 200, errors: [{ code: 1003, message: 'quota exceeded' }] }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('failed to create');
		expect(res.detail).toContain('the API reported failure (1003: quota exceeded)');
		expect(res.detail).not.toContain('token needs');
	});

	it('a 201 whose body says success:false is treated the same as a 200', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: false, status: 201, errors: [{ code: 1004, message: 'odd but possible' }] }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('the API reported failure (1004: odd but possible)');
		expect(res.detail).not.toContain('token needs');
	});

	it('a thrown fetch (status 0) says the API was never reached', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: false, status: 0 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('the Cloudflare API did not respond');
		// The tail already says it; a bare '(HTTP 0)' would be noise.
		expect(res.detail).not.toContain('HTTP 0');
		expect(res.detail).not.toContain('token needs');
		expect(res.detail).not.toContain('reported failure');
	});

	it('a success:false body with no errors says so instead of trailing nothing', async () => {
		const { api } = fakeApi({
			[listPath]: { ok: false, status: 200 }
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('the API reported failure with no reason given');
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
				[listPath]: {
					ok: true,
					status: 200,
					result: [ourWidget]
				},
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

	it('no error detail carries a non-allowlisted error field, the secret, or the sitekey', async () => {
		// The allowlisted code+message IS repeated in error details now (that is
		// the honest contract); everything else in the body must never be.
		const ALLOWLISTED_MESSAGE = 'cf-error-message-expected-in-detail';
		const NON_ALLOWLISTED_MARKER = 'cf-error-extra-field-must-not-leak';
		const apiErrors = [
			{ code: 10000, message: ALLOWLISTED_MESSAGE, detail_url: NON_ALLOWLISTED_MARKER }
		];
		// `carriesReason` = the failing route returned an errors body, so the
		// detail must repeat its code+message.
		const scenarios: { routes: Record<string, CfApiResult>; carriesReason?: boolean }[] = [
			// list: scope failure / transient failure
			{ routes: { [listPath]: { ok: false, status: 403, errors: apiErrors } }, carriesReason: true },
			{ routes: { [listPath]: { ok: false, status: 500, errors: apiErrors } }, carriesReason: true },
			// secret read: scope failure / 200 with a blank body
			{
				routes: {
					[listPath]: { ok: true, status: 200, result: [ourWidget] },
					[getPath]: { ok: false, status: 403, errors: apiErrors }
				},
				carriesReason: true
			},
			// Partial-body branches ignore `errors` entirely — the bodies here make
			// the absent-message assertion below load-bearing.
			{
				routes: {
					[listPath]: { ok: true, status: 200, result: [ourWidget] },
					[getPath]: { ok: true, status: 200, result: { sitekey: SITEKEY }, errors: apiErrors }
				}
			},
			// create: scope failure / 200 with a partial body
			{
				routes: {
					[listPath]: { ok: true, status: 200, result: [] },
					[createPath]: { ok: false, status: 403, errors: apiErrors }
				},
				carriesReason: true
			},
			{
				routes: {
					[listPath]: { ok: true, status: 200, result: [] },
					[createPath]: { ok: true, status: 200, result: {}, errors: apiErrors }
				}
			}
		];
		for (const { routes, carriesReason } of scenarios) {
			const { api } = fakeApi(routes);
			const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
			expect(res.status).toBe('error');
			expect(res.detail).not.toContain(NON_ALLOWLISTED_MARKER);
			expect(res.detail).not.toContain(WIDGET_SECRET);
			expect(res.detail).not.toContain(SITEKEY);
			if (carriesReason) expect(res.detail).toContain(`10000: ${ALLOWLISTED_MESSAGE}`);
			else expect(res.detail).not.toContain(ALLOWLISTED_MESSAGE);
		}

		// 200/success:false: the reported-failure arm repeats the allowlisted
		// code+message too, and only the allowlisted fields may appear.
		const { api } = fakeApi({
			[listPath]: {
				ok: false,
				status: 200,
				errors: [
					{
						code: 9109,
						message: ALLOWLISTED_MESSAGE,
						detail_url: NON_ALLOWLISTED_MARKER,
						account_id: NON_ALLOWLISTED_MARKER
					}
				]
			}
		});
		const res = await provisionTurnstileWidget(TOKEN, ACCT, 'akito.dog', api);
		expect(res.status).toBe('error');
		expect(res.detail).toContain(`9109: ${ALLOWLISTED_MESSAGE}`);
		expect(res.detail).not.toContain(NON_ALLOWLISTED_MARKER);
		expect(res.detail).not.toContain(WIDGET_SECRET);
		expect(res.detail).not.toContain(SITEKEY);
	});
});
