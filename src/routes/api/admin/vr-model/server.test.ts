import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isHttpError } from '@sveltejs/kit';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { MAX_VR_MODEL_BYTES } from '$lib/vr';
import { EARLY_ACCESS } from '$lib/early-access';
import { makeD1 } from '$lib/server/test/d1';

import { POST } from './+server';

// Stub only the provider resolution — the endpoint's own validation (gate,
// Content-Length, extension/content-type, magic-byte sniff) stays real. `put`
// is what the assertions probe: the endpoint must hand the provider a STREAM
// plus the declared size (SONA-136 contract), never a buffered body.
const put = vi.hoisted(() =>
	vi.fn(async (_input?: unknown) => ({ url: '/img/vr-models/stored.vrm' }))
);
vi.mock('$lib/server/storage', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage')>();
	return { ...original, getStorage: vi.fn(() => ({ put })) };
});

// Registry-driven gate control (same mutation pattern as early-access.test.ts).
const SHIPPED = { ...EARLY_ACCESS };
const FUTURE_GA = '2999-01-01';
const PAST_GA = '2000-01-01';
function restoreRegistry() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}
beforeEach(() => {
	restoreRegistry();
	EARLY_ACCESS['vr-avatars'] = PAST_GA; // ungated by default; gate tests override
	clearSettingsCache();
	// The gate memoizes the verified supporter key per isolate; every test builds
	// a fresh DB, so the previous test's key would otherwise answer for this one.
	clearSupporterKeyStatusCache();
	put.mockClear();
});
afterEach(restoreRegistry);

// Small fixtures — the guards must reject an oversized upload from its
// DECLARED length alone, so no test ships a real 50 MB body.
const GLB_HEAD = new TextEncoder().encode('glTF....binary model bytes');
const FBX_BINARY_HEAD = new TextEncoder().encode('Kaydara FBX Binary  \x00rest');
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function makePlatform() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	return { env: { DB: makeD1(sqlite) } } as unknown as App.Platform;
}

function postEvent(
	platform: App.Platform,
	opts: {
		filename?: string;
		body?: Uint8Array | null;
		contentLength?: string | null;
		contentType?: string | null;
	} = {}
) {
	const {
		filename = 'avatar.vrm',
		body = GLB_HEAD,
		contentLength = body ? String(body.length) : null,
		contentType = 'application/octet-stream'
	} = opts;
	const headers = new Headers();
	if (contentLength !== null) headers.set('content-length', contentLength);
	if (contentType !== null) headers.set('content-type', contentType);
	const url = new URL(
		`http://localhost/api/admin/vr-model${filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`}`
	);
	const request = new Request(url, {
		method: 'POST',
		// TS's dom BodyInit doesn't admit Uint8Array<ArrayBufferLike>; undici does.
		body: (body ?? undefined) as BodyInit | undefined,
		headers
	});
	return { request, url, platform } as never;
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		await fn();
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

describe('POST /api/admin/vr-model', () => {
	it('streams the model to the provider with the declared size and returns url/size/format', async () => {
		const platform = makePlatform();
		const res = (await POST(postEvent(platform))) as Response;
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			url: 'http://localhost/img/vr-models/stored.vrm',
			size: GLB_HEAD.length,
			format: 'vrm'
		});
		expect(put).toHaveBeenCalledTimes(1);
		const input = put.mock.calls[0][0] as {
			body: unknown;
			size: number;
			suggestedKey: string;
			contentType: string;
		};
		// The SONA-136 contract only streams when body is a ReadableStream AND
		// size is declared — both must hold, or a 50 MB model gets buffered.
		expect(input.body).toBeInstanceOf(ReadableStream);
		expect(input.size).toBe(GLB_HEAD.length);
		expect(input.suggestedKey).toMatch(/^vr-models\/[0-9a-f-]{36}\.vrm$/);
		expect(input.contentType).toBe('application/octet-stream');
	});

	it('accepts a binary FBX by its Kaydara header', async () => {
		const platform = makePlatform();
		const res = (await POST(
			postEvent(platform, { filename: 'avatar.fbx', body: FBX_BINARY_HEAD })
		)) as Response;
		expect(res.status).toBe(200);
		expect(((await res.json()) as { format: string }).format).toBe('fbx');
	});

	it('refuses while gated (pre-GA, no key) — 403 before anything else', async () => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const platform = makePlatform();
		expect(await statusOf(() => POST(postEvent(platform)))).toBe(403);
		expect(put).not.toHaveBeenCalled();
	});

	it('requires Content-Length (411)', async () => {
		const platform = makePlatform();
		expect(await statusOf(() => POST(postEvent(platform, { contentLength: null })))).toBe(411);
		expect(put).not.toHaveBeenCalled();
	});

	it('rejects a declared length over the cap (413) without reading the body', async () => {
		const platform = makePlatform();
		// Tiny body, lying header — the guard must act on the DECLARED length.
		const event = postEvent(platform, { contentLength: String(MAX_VR_MODEL_BYTES + 1) });
		expect(await statusOf(() => POST(event))).toBe(413);
		expect(put).not.toHaveBeenCalled();
		// The body was never read: its stream is still untouched.
		expect((event as { request: Request }).request.bodyUsed).toBe(false);
	});

	it('rejects a filename without a .vrm/.fbx extension (415)', async () => {
		const platform = makePlatform();
		expect(await statusOf(() => POST(postEvent(platform, { filename: 'avatar.png' })))).toBe(415);
		expect(await statusOf(() => POST(postEvent(platform, { filename: 'avatar' })))).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});

	it('rejects a non-model content-type (415)', async () => {
		const platform = makePlatform();
		expect(await statusOf(() => POST(postEvent(platform, { contentType: 'image/png' })))).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});

	it('rejects contents that do not match the claimed model format (415)', async () => {
		const platform = makePlatform();
		// PNG bytes wearing a .vrm name: extension and content-type pass, the
		// magic-byte sniff must not.
		expect(await statusOf(() => POST(postEvent(platform, { body: PNG_HEAD })))).toBe(415);
		// glTF bytes wearing a .fbx name: sniffed format contradicts the extension.
		expect(
			await statusOf(() => POST(postEvent(platform, { filename: 'avatar.fbx', body: GLB_HEAD })))
		).toBe(415);
		expect(put).not.toHaveBeenCalled();
	});
});
