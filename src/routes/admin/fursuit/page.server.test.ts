import { describe, it, expect, vi } from 'vitest';
import { actions } from './+page.server';
import { importFursuitPhotos } from '$lib/server/fursuit-import';

// The import itself (FurTrack fetch, storage put, D1 insert) is covered in
// fursuit-import.test.ts. Here only the form parsing matters: what the action
// hands the importer, so stub it and read back the options it received.
vi.mock('$lib/server/fursuit-import', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/fursuit-import')>()),
	importFursuitPhotos: vi.fn(async () => ({ imported: 0, skipped: 0, failed: 0 }))
}));
vi.mock('$lib/server/settings', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/settings')>()),
	getSettings: vi.fn(async () => ({ primaryCharacter: 'Taro' }))
}));

function importEvent(fields: Array<[string, string]>) {
	const body = new FormData();
	for (const [k, v] of fields) body.append(k, v);
	return {
		platform: { env: { DB: {} } },
		url: new URL('https://taro.surf/admin/fursuit'),
		fetch,
		request: new Request('https://taro.surf/admin/fursuit?/import', { method: 'POST', body })
	} as never;
}

function received() {
	const calls = vi.mocked(importFursuitPhotos).mock.calls;
	return calls[calls.length - 1][0];
}

describe('fursuit import action — form fields are capped before they are stored', () => {
	it('caps the character name and each permission source', async () => {
		await actions.import(
			importEvent([
				['character', 'c'.repeat(10_000)],
				['postId', '7'],
				['permission[7]', 'p'.repeat(10_000)]
			])
		);

		const opts = received();
		expect(opts.character).toBe('c'.repeat(100));
		expect(opts.manualPermissions!.get(7)).toBe('p'.repeat(200));
	});

	it('falls back to the primary character when the field is blank', async () => {
		await actions.import(importEvent([['character', '   '], ['postId', '7']]));

		expect(received().character).toBe('Taro');
	});
});
