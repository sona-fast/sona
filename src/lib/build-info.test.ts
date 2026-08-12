import { describe, it, expect } from 'vitest';
import { buildReceipt } from './build-info';

describe('buildReceipt', () => {
	const SHA = '6ff8a8a0c2b54d01ec549773b5a7d7c3a6fe1234';

	it('renders a short SHA linked into the building repo tree', () => {
		const r = buildReceipt(SHA, 'https://github.com/someone/sona');
		expect(r).toEqual({
			short: '6ff8a8a',
			url: `https://github.com/someone/sona/tree/${SHA}`
		});
	});

	// A fork can build from a repo we can't know at author time; with no repo
	// URL the stamp must still render, unlinked — never a guessed upstream link
	// that 404s on fork-only commits.
	it('renders unlinked when the repo URL is unknown', () => {
		expect(buildReceipt(SHA, '')).toEqual({ short: '6ff8a8a', url: '' });
	});

	it('strips a trailing slash from the repo URL', () => {
		expect(buildReceipt(SHA, 'https://github.com/someone/sona/')?.url).toBe(
			`https://github.com/someone/sona/tree/${SHA}`
		);
	});

	// Local dev and test builds bake in '' — no stamp at all rather than a
	// broken or misleading one.
	it('returns null for an empty or malformed SHA', () => {
		expect(buildReceipt('', 'https://github.com/x/y')).toBeNull();
		expect(buildReceipt('not-a-sha', 'https://github.com/x/y')).toBeNull();
		expect(buildReceipt('abc12', '')).toBeNull();
	});
});
