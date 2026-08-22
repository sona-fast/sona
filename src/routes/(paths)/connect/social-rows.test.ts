import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// /connect renders one link row per social, titled with the platform name and
// subtitled with the handle. Which setting feeds which platform decides both
// halves, and a swapped pair reads the FurAffinity URL under the Twitter rules
// while titling it "Twitter", so the PAIRS are pinned here.
//
// Source scan: the row list is inline in +page.svelte and the page pulls in
// $app/state and paraglide, so rendering it under this pure-TS vitest setup
// (see vitest.config.ts) would cost more than it proves.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

// The object literals inside the socials array.
const entries = [
	...source.matchAll(/platform: '([^']+)' as const,\s*url: data\.settings\.(\w+)/g)
].map(([, platform, setting]) => ({ platform, setting }));

describe('/connect social rows', () => {
	it('pairs every setting with its own platform', () => {
		expect(entries).toEqual([
			{ platform: 'bluesky', setting: 'blueskyUrl' },
			{ platform: 'telegram', setting: 'telegramUrl' },
			{ platform: 'furaffinity', setting: 'furAffinityUrl' },
			{ platform: 'twitter', setting: 'twitterUrl' },
			{ platform: 'instagram', setting: 'instagramUrl' }
		]);
	});

	it('leaves the subtitle off when no handle could be derived', () => {
		// The title is already the platform name, so socialLabel's fallback would
		// stack "Twitter" over "Twitter" — the row must show the title alone.
		// Pin the SHAPE, not the formatting: a subtitle that falls back to nothing,
		// derived from socialAtHandle (which can say "no handle", and hands back the
		// @handle already written the way rule 1 shows it) rather than socialLabel
		// (which always returns a string, so the row could never drop its subtitle).
		expect(source).toMatch(/subtitle:[^\n]*(\?[^\n]*:\s*undefined|\?\?\s*undefined)/);
		expect(source).toMatch(/socialAtHandle\s*\(/);
		expect(source).not.toMatch(/socialLabel\s*\(/);
	});
});

describe('/connect here-now block', () => {
	it('serves the avatar through the CDN transform, with the raw original behind it', () => {
		// It is a 60px slot; an untransformed original is a multi-MB download on the
		// convention wifi this page is read over. rawFallback covers the off-zone
		// hosts that 403 the transform.
		expect(source).toMatch(/src=\{cdnImage\(data\.settings\.adminAvatarUrl, 120\)\}/);
		expect(source).toMatch(/use:rawFallback=\{data\.settings\.adminAvatarUrl\}/);
		// Intrinsic size stays on the tag so the block does not shift as it loads.
		expect(source).toMatch(/class="here-avatar"[\s\S]*?width="60"\s*\n?\s*height="60"/);
	});

	it('opens with a heading, like every other section on the page', () => {
		// Without one, the block that leads the page during a con is unreachable by
		// heading navigation.
		expect(source).toMatch(/<h2 class="live-pill">\{m\.connect_here_now\(\)\}<\/h2>/);
	});
});

describe('/connect conventions section', () => {
	// The load lifts the running con OUT of data.conventions, so an operator whose
	// only row IS the live con leaves this list empty. Guarding the section on
	// nextCon alone cannot tell that case apart from having no cons at all, and
	// prints "no cons on the calendar right now" directly under the here-now block
	// naming the con the visitor is standing at.
	const guard = source.match(/const showCons = \$derived\((.+)\);/)?.[1];

	it('decides the section on the live con as well as the list', () => {
		// Pinned as source: the page pulls in $app/state and paraglide, so it does
		// not render under this pure-TS setup (same reason as the rows above).
		// Both terms, so both empty cases are distinguishable:
		//   live con + nothing upcoming  -> hidden, the here-now block has the event
		//   no live con + nothing upcoming -> shown, and the empty state is true
		expect(guard).toBe('Boolean(nextCon) || !liveCon');
	});

	it('hangs the whole section off that guard, heading included', () => {
		// A heading with nothing beneath it is its own small lie, so the guard wraps
		// the section rather than just the empty paragraph.
		expect(source).toMatch(
			/\{#if showCons\}\s*<hr class="divider" \/>\s*<section class="section">\s*<h2 class="section-label">\{m\.connect_cons\(\)\}<\/h2>/
		);
	});

	it('leaves the genuinely-empty message unchanged', () => {
		expect(source).toMatch(/\{:else\}\s*<p class="empty">\{m\.connect_no_cons\(\)\}<\/p>/);
	});
});
