import { describe, it, expect } from 'vitest';
import { resolveTabId } from './tabs';

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
