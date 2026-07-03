import { describe, it, expect } from 'vitest';
import { furtrackUserAgent, fetchCharacterPhotos } from './furtrack';

// FurTrack must be able to trace outbound traffic (and any abuse) back to the
// specific fork making the calls. These tests pin two things: the User-Agent
// builder embeds the fork's identity from site settings, and the client actually
// sends that identifying User-Agent on its outbound requests.

describe('furtrackUserAgent', () => {
	it('embeds site name, FurTrack profile, and owner from settings', () => {
		const ua = furtrackUserAgent({
			siteName: 'Sparky.ink',
			ownerName: 'Sparky',
			furtrackUrl: 'https://www.furtrack.com/user/sparky'
		});
		// Keeps the Mozilla-style shell FurTrack requires, and identifies this fork.
		expect(ua).toMatch(/^Mozilla\/5\.0 \(compatible;/);
		expect(ua).toContain('Sona-Fursuit/');
		expect(ua).toContain('Sparky.ink');
		expect(ua).toContain('https://www.furtrack.com/user/sparky');
		expect(ua).toContain('Sparky');
	});

	it('omits unset identity fields but stays non-empty and product-tagged', () => {
		const ua = furtrackUserAgent({ siteName: 'Sona', ownerName: '', furtrackUrl: '' });
		expect(ua).toContain('Sona-Fursuit/');
		expect(ua).toContain('Sona');
		expect(ua).not.toContain('+'); // no profile URL when furtrackUrl is empty
	});

	it('falls back to a non-empty User-Agent when no settings are given', () => {
		expect(furtrackUserAgent()).toBeTruthy();
		expect(furtrackUserAgent({ siteName: '', ownerName: '', furtrackUrl: '' })).toBeTruthy();
	});
});

describe('fetchCharacterPhotos (live) User-Agent', () => {
	it('sends the identifying User-Agent on outbound FurTrack requests', async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fakeFetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
			// Empty index → no per-post subrequests; the index call alone proves the header.
			return new Response(JSON.stringify({ posts: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as typeof fetch;

		const userAgent = furtrackUserAgent({
			siteName: 'Sparky.ink',
			ownerName: 'Sparky',
			furtrackUrl: 'https://www.furtrack.com/user/sparky'
		});
		await fetchCharacterPhotos({ FURTRACK_MODE: 'live' }, 'sparky', fakeFetch, {
			includeAll: true,
			userAgent
		});

		expect(calls.length).toBeGreaterThan(0);
		const sentUa = calls[0].headers['User-Agent'];
		expect(sentUa).toBeTruthy();
		expect(sentUa).toBe(userAgent);
		expect(sentUa).toContain('Sparky.ink');
	});
});
