import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// /share's Telegram row is subtitled with a sentence built AROUND the handle
// ("Send directly to @taro — fastest way"), so with no handle derivable there is
// no sentence to write and the row goes out with its title alone. Reverting the
// subtitle to the unconditional message renders the sentence with a hole in it.
//
// Source scan, matching /connect's social-rows.test.ts: the row is inline in
// +page.svelte and the page pulls in $app/state and paraglide, so rendering it
// under this pure-TS vitest setup (see vitest.config.ts) would cost more than it
// proves.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/share Telegram row', () => {
	it('drops the handle sentence when no handle could be derived', () => {
		// The SHAPE, not the formatting: a conditional subtitle whose fallback is
		// no subtitle at all.
		expect(source).toMatch(/subtitle=\{[^\n]*\?[^\n]*:\s*undefined\}/);
	});

	it('derives that handle through the shared module', () => {
		// socialHandle, not socialLabel: only the former can say "no handle", which
		// is what the conditional above turns on.
		expect(source).toMatch(/socialHandle\(['"]telegram['"]/);
		expect(source).not.toMatch(/socialLabel\s*\(/);
	});
});
