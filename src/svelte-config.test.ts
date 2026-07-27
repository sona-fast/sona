import { describe, it, expect } from 'vitest';
import config from '../svelte.config.js';

describe('svelte.config.js CSRF', () => {
	// SvelteKit's CSRF origin check is on by default and only relaxed by adding
	// trusted origins. An empty list is the strict default, pinned explicitly so a
	// later `['*']` (which disables CSRF protection on every admin action) can't
	// slip in silently (finding M4). `trustedOrigins` is the non-deprecated knob
	// that replaced `checkOrigin`.
	it('keeps CSRF strict — trustedOrigins is empty', () => {
		expect(config.kit?.csrf?.trustedOrigins).toEqual([]);
	});
});
