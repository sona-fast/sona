import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isHttpError } from '@sveltejs/kit';
import { clearSettingsCache } from '$lib/server/settings';
import { MAX_BUFFER_BYTES } from '$lib/server/storage/buffer';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';
import { PNG_MAGIC } from '$lib/server/test/raster-fixtures';

// Stub only the provider resolution — the endpoint's own validation
// (allowlist, sniff, size cap) stays real. `put` is what the assertions probe:
// the endpoint must hand the provider a stream plus the declared size.
const put = vi.hoisted(() =>
	vi.fn(async (_input?: unknown) => ({ url: '/img/artwork/stored.png' }))
);
vi.mock('$lib/server/storage', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage')>();
	return { ...original, getStorage: vi.fn(() => ({ put })) };
});

function makePlatform() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	return { env: { DB: makeD1(sqlite) } } as unknown as App.Platform;
}

function pngFile(size: number, name = 'a.png', type = 'image/png') {
	const bytes = new Uint8Array(size);
	bytes.set(PNG_MAGIC);
	return new File([bytes], name, { type });
}

function postEvent(platform: App.Platform, file: File) {
	const form = new FormData();
	form.append('file', file);
	const request = new Request('http://localhost/api/upload', { method: 'POST', body: form });
	return { request, platform } as never;
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

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
	put.mockClear();
});

describe('POST /api/upload', () => {
	it('streams the file to the provider with its declared size', async () => {
		const file = pngFile(64 * 1024);
		let drained = 0;
		put.mockImplementationOnce(async (input?: unknown) => {
			const { body } = input as { body: ReadableStream<Uint8Array> };
			drained = (await new Response(body).arrayBuffer()).byteLength;
			return { url: '/img/artwork/stored.png' };
		});

		const res = (await POST(postEvent(makePlatform(), file))) as Response;

		expect(put).toHaveBeenCalledTimes(1);
		const input = put.mock.calls[0][0] as unknown as {
			body: unknown;
			size: number;
			contentType: string;
			suggestedKey: string;
			filename: string;
		};
		// The provider gets the STREAM plus the exact declared size — never a
		// buffered copy (that is what lets large uploads bypass buffering).
		expect(input.body).toBeInstanceOf(ReadableStream);
		expect(input.size).toBe(file.size);
		expect(drained).toBe(file.size);
		expect(input.contentType).toBe('image/png');
		expect(input.suggestedKey).toMatch(/^artwork\/[0-9a-f-]+\.png$/);
		expect(input.filename).toBe('a.png');
		// The dev-relative provider URL is absolutized against the request origin.
		expect(await res.json()).toEqual({
			url: 'http://localhost/img/artwork/stored.png',
			size: file.size
		});
	});

	it('413s a file over MAX_BUFFER_BYTES without calling the provider', async () => {
		const file = pngFile(MAX_BUFFER_BYTES + 1);
		expect(await statusOf(() => POST(postEvent(makePlatform(), file)))).toBe(413);
		expect(put).not.toHaveBeenCalled();
	});

	it('passes the allowlist-matched content type (parameters stripped) to the provider', async () => {
		const file = pngFile(1024, 'a.png', 'image/png; charset=UTF-8');
		await POST(postEvent(makePlatform(), file));
		expect(put).toHaveBeenCalledTimes(1);
		expect((put.mock.calls[0][0] as unknown as { contentType: string }).contentType).toBe(
			'image/png'
		);
	});
});
