import { describe, it, expect, vi } from 'vitest';
import { getStorage } from './index';
import type { SiteSettings } from '$lib/server/settings';

// The `$app/environment` stub reports dev:false, so getStorage here runs the
// production branch — exactly the path these tests care about.

type Env = Parameters<typeof getStorage>[0];

const fakeBucket = {
	put: vi.fn(async () => {}),
	delete: vi.fn(async () => {}),
	list: vi.fn(async () => ({ objects: [], truncated: false }))
};
const env = { IMAGES: fakeBucket } as unknown as Env;

function r2Settings(r2PublicUrl: string): SiteSettings {
	return { storageProvider: 'r2', r2PublicUrl } as unknown as SiteSettings;
}

describe('getStorage r2 public-base fallback (prod)', () => {
	it('serves from the /img route when no public URL is configured', async () => {
		const storage = getStorage(env, r2Settings(''));
		const { url } = await storage.put({
			suggestedKey: 'stickers/pack/abc.webp',
			body: new ArrayBuffer(8),
			contentType: 'image/webp',
			filename: 'abc.webp'
		});
		// Not a broken bare-key URL ("/abc.webp") — prefixed with the /img route.
		expect(url).toBe('/img/stickers/pack/abc.webp');
		// And it recognises that (absolutized) URL as its own for deletes.
		expect(storage.owns('https://site.example/img/stickers/pack/abc.webp')).toBe(true);
	});

	it('uses the configured CDN domain when a public URL is set', async () => {
		const storage = getStorage(env, r2Settings('https://cdn.example.com'));
		const { url } = await storage.put({
			suggestedKey: 'stickers/pack/abc.webp',
			body: new ArrayBuffer(8),
			contentType: 'image/webp',
			filename: 'abc.webp'
		});
		expect(url).toBe('https://cdn.example.com/stickers/pack/abc.webp');
	});
});
