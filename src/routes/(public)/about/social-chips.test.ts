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
	it('pairs every setting with its own platform', () => {
		// Six links, and the PAIRS matter as much as the list: swapping two
		// platforms renders the FurAffinity URL under the Twitter rules — and
		// announces it as Twitter — while every distinctness check stays green.
		expect(entries).toEqual([
			{ setting: 'twitterUrl', platform: 'twitter' },
			{ setting: 'telegramUrl', platform: 'telegram' },
			{ setting: 'blueskyUrl', platform: 'bluesky' },
			{ setting: 'furAffinityUrl', platform: 'furaffinity' },
			{ setting: 'furtrackUrl', platform: 'furtrack' },
			{ setting: 'instagramUrl', platform: 'instagram' }
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

	// That the page takes its labels from $lib/social-label rather than a local
	// helper is pinned once, for all four surfaces, in src/lib/social-label.test.ts.
});
