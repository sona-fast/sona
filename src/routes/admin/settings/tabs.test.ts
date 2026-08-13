import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveTabId, visibleTabIds, SETTINGS_TAB_IDS } from './tabs';

describe('resolveTabId — ?tab= deep-link resolution', () => {
	it('falls back to site with no param', () => {
		expect(resolveTabId(null, true)).toBe('site');
	});

	it('resolves every plain tab id', () => {
		for (const id of ['site', 'connections', 'storage', 'account'] as const) {
			expect(resolveTabId(id, false)).toBe(id);
		}
	});

	it('resolves observability only while the gate is on', () => {
		expect(resolveTabId('observability', true)).toBe('observability');
		expect(resolveTabId('observability', false)).toBe('site');
	});

	it('falls back to site on garbage', () => {
		expect(resolveTabId('bogus', true)).toBe('site');
		expect(resolveTabId('', true)).toBe('site');
	});
});

describe('visibleTabIds', () => {
	it('drops observability while its gate is off', () => {
		expect(visibleTabIds(true)).toEqual([...SETTINGS_TAB_IDS]);
		expect(visibleTabIds(false)).toEqual(SETTINGS_TAB_IDS.filter((id) => id !== 'observability'));
	});
});

// SONA-119: the tablist and the resolver both read SETTINGS_TAB_IDS, but the
// per-tab CSS can't — a Svelte <style> block is static. So the list lives in
// exactly two places and this asserts they agree; adding a tab without its
// hide-the-others rule (or with a typo in a section's data-tab) fails here
// rather than silently showing that tab's sections under every other tab.
describe('settings tab ids do not drift from the component', () => {
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

	it('has one hide rule per tab id, and no more', () => {
		const ruled = [...source.matchAll(/\.settings-tabs\[data-active-tab='([^']+)'\]/g)].map(
			(m) => m[1]
		);
		expect([...new Set(ruled)].sort()).toEqual([...SETTINGS_TAB_IDS].sort());
		expect(ruled).toHaveLength(SETTINGS_TAB_IDS.length);
	});

	it('tags every section with a known tab id', () => {
		const tagged = [...source.matchAll(/\bdata-tab="([^"{]+)"/g)].flatMap((m) => m[1].split(/\s+/));
		expect(tagged.length).toBeGreaterThan(0);
		expect([...new Set(tagged)].filter((id) => !SETTINGS_TAB_IDS.includes(id as never))).toEqual([]);
	});
});
