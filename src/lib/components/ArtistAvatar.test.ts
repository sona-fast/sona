import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pinned wiring guard for the avatar fallback ladder (R2-T6/R2-D3),
// same pattern as VrViewer.test.ts: cdn → raw → monogram is all silent-failure
// territory — a dropped handler just renders broken images or monograms.
const src = readFileSync(new URL('./ArtistAvatar.svelte', import.meta.url), 'utf8');

describe('ArtistAvatar fallback ladder (R2-T6)', () => {
	it('routes through the CDN transform only when the cdn prop opts in', () => {
		expect(src).toContain('cdn && !useRaw && avatarUrl ? cdnImage(avatarUrl, size * 2) : avatarUrl');
	});

	it('walks cdn → raw → monogram on runtime errors', () => {
		expect(src).toMatch(/if \(cdn && !useRaw\) useRaw = true;\s*\n\s*else failed = true;/);
		expect(src).toContain('onerror={onError}');
	});

	it('carries use:rawFallback for the pre-hydration SSR 403 (R2-D3)', () => {
		// An off-zone avatar (e.g. Bluesky CDN) 403s the transform BEFORE
		// hydration; onerror never fires, so the action's mount-time
		// complete/naturalWidth check must do the swap.
		expect(src).toContain('use:rawFallback={avatarUrl}');
	});

	it('resets the ladder when the avatarUrl changes (list rows reuse instances)', () => {
		expect(src).toMatch(/void avatarUrl;\s*\n\s*failed = false;\s*\n\s*useRaw = false;/);
	});
});

describe('VR detail credit rows opt in to cdn', () => {
	const page = readFileSync(
		new URL('../../routes/(public)/vr/[slug]/+page.svelte', import.meta.url),
		'utf8'
	);
	it('passes cdn on the credit-row ArtistAvatar (lazy is the component default)', () => {
		expect(page).toMatch(/<ArtistAvatar[^>]*avatarUrl=\{credit\.artistAvatar\}[^>]*cdn/);
	});
});

describe('lazy-by-default (the admin-artists squish spec pins the rendered attribute)', () => {
	it('defaults lazy to true so pre-existing call sites keep loading="lazy"', () => {
		expect(src).toContain('lazy = true');
	});
});
