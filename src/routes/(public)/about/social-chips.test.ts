import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// /about renders one chip per social link, labelled with the derived handle. An
// owner who uses the same handle everywhere (common) gets several chips reading
// "@taro", and since the icon that distinguishes them visually is aria-hidden,
// a screen reader announces a list of identical links. Each chip therefore
// carries its platform name as visually-hidden text.
//
// Source scan: the chip list is inline in +page.svelte and the page pulls in
// $app/state and paraglide, so rendering it under this pure-TS vitest setup
// (see vitest.config.ts) would cost more than it proves.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

// The object literals inside the socialLinks array.
const entries = [
	...source.matchAll(/\{\s*url: settings\.(\w+),[^}]*?platform: '([^']+)'/g)
].map(([, setting, platform]) => ({ setting, platform }));

describe('/about social chips carry their platform name', () => {
	it('every chip in the list declares a platform', () => {
		// Six links: Twitter, Telegram, Bluesky, FurAffinity, FurTrack, Instagram.
		// A new chip added without a platform drops out of this match and fails.
		expect(entries.map((e) => e.setting)).toEqual([
			'twitterUrl',
			'telegramUrl',
			'blueskyUrl',
			'furAffinityUrl',
			'furtrackUrl',
			'instagramUrl'
		]);
	});

	it('platform keys are distinct, so no two chips can collide', () => {
		const platforms = entries.map((e) => e.platform);
		expect(new Set(platforms).size).toBe(platforms.length);
	});

	it('renders the platform name as visually-hidden text inside the chip', () => {
		expect(source).toMatch(/<span class="sr-only">\{link\.name\}<\/span>/);
		// The rule that actually hides it is global, in src/app.css.
	});

	it('does not double the name when the handle could not be derived', () => {
		// socialLabel falls back to the platform name for a pathless URL, which
		// would otherwise announce as "Twitter Twitter".
		expect(source).toMatch(/\{#if link\.hasHandle\}/);
	});

	it('takes its labels from the shared helper, not a local one', () => {
		// SONA-128: every surface that renders a social handle goes through
		// $lib/social-label, so /about, /connect and /share cannot drift apart.
		expect(source).toMatch(/from '\$lib\/social-label'/);
		expect(source).not.toMatch(/function handle\s*\(/);
	});
});
