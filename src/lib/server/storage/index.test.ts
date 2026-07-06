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
		// It recognises its own root-relative URL for deletes.
		expect(storage.owns('/img/stickers/pack/abc.webp')).toBe(true);
		// SECURITY: an ABSOLUTE off-origin URL whose path merely starts with /img/
		// is NOT ours — matching it would let an attacker-hosted URL pass the
		// self-hosted gate and be fetched by the public download route (SSRF).
		expect(storage.owns('https://attacker.example/img/stickers/pack/abc.webp')).toBe(false);
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

describe('R2 deleteOrphans age gate + dryRun', () => {
	const HOUR = 60 * 60 * 1000;

	function makeBucket() {
		return {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({
				objects: [
					{ key: 'referenced.png', uploaded: new Date(Date.now() - 10 * HOUR) },
					{ key: 'old-orphan.png', uploaded: new Date(Date.now() - 10 * HOUR) },
					{ key: 'young-orphan.png', uploaded: new Date() }
				],
				truncated: false
			}))
		};
	}

	it('deletes only orphans older than the gate; referenced and young objects survive', async () => {
		const bucket = makeBucket();
		const storage = getStorage({ IMAGES: bucket } as unknown as Env, r2Settings('https://cdn.example.com'));
		const deleted = await storage.deleteOrphans(['https://cdn.example.com/referenced.png'], {
			olderThan: new Date(Date.now() - HOUR)
		});
		expect(deleted).toBe(1);
		expect(bucket.delete).toHaveBeenCalledTimes(1);
		expect(bucket.delete).toHaveBeenCalledWith(['old-orphan.png']);
	});

	it('deletes every orphan when no olderThan is given', async () => {
		const bucket = makeBucket();
		const storage = getStorage({ IMAGES: bucket } as unknown as Env, r2Settings('https://cdn.example.com'));
		const deleted = await storage.deleteOrphans(['https://cdn.example.com/referenced.png']);
		expect(deleted).toBe(2);
		expect(bucket.delete).toHaveBeenCalledWith(['old-orphan.png', 'young-orphan.png']);
	});

	it('dryRun counts without deleting', async () => {
		const bucket = makeBucket();
		const storage = getStorage({ IMAGES: bucket } as unknown as Env, r2Settings('https://cdn.example.com'));
		const count = await storage.deleteOrphans(['https://cdn.example.com/referenced.png'], {
			olderThan: new Date(Date.now() - HOUR),
			dryRun: true
		});
		expect(count).toBe(1);
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});

// REGRESSION (data loss): DB URLs are absolutized against whatever base was
// active AT UPLOAD TIME (/api/upload turns '/img/<key>' into an absolute URL),
// but the keep set used to be derived ONLY from the CURRENT base. With
// r2PublicUrl unset (serving via /img) or changed after uploads, no referenced
// URL mapped to a key → empty keep set → the cron deleted every referenced
// object older than the gate. The keep set must be base-agnostic.
describe('R2 deleteOrphans keep set is base-agnostic', () => {
	const HOUR = 60 * 60 * 1000;
	const old = new Date(Date.now() - 10 * HOUR);

	function makeBucket() {
		return {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({
				objects: [
					{ key: 'artwork/x.png', uploaded: old },
					{ key: 'true-orphan.png', uploaded: old }
				],
				truncated: false
			}))
		};
	}

	it('keeps an absolute /img URL when serving via the /img route (no r2PublicUrl)', async () => {
		const bucket = makeBucket();
		const storage = getStorage({ IMAGES: bucket } as unknown as Env, r2Settings(''));
		const deleted = await storage.deleteOrphans(['https://site.example/img/artwork/x.png'], {
			olderThan: new Date(Date.now() - HOUR)
		});
		// The referenced object survives; only the true orphan is deleted.
		expect(deleted).toBe(1);
		expect(bucket.delete).toHaveBeenCalledWith(['true-orphan.png']);
	});

	it('keeps a URL uploaded under an OLD base after r2PublicUrl changes', async () => {
		const bucket = makeBucket();
		const storage = getStorage({ IMAGES: bucket } as unknown as Env, r2Settings('https://cdn.example.com'));
		const deleted = await storage.deleteOrphans(['https://site.example/img/artwork/x.png'], {
			olderThan: new Date(Date.now() - HOUR)
		});
		expect(deleted).toBe(1);
		expect(bucket.delete).toHaveBeenCalledWith(['true-orphan.png']);
	});
});
