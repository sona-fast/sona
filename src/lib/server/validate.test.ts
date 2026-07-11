import { describe, it, expect } from 'vitest';
import { normalizeHttpsUrl } from './validate';

describe('normalizeHttpsUrl', () => {
	it('keeps a valid absolute https URL', () => {
		expect(normalizeHttpsUrl('https://taro.surf')).toBe('https://taro.surf');
	});

	it('strips a trailing slash', () => {
		expect(normalizeHttpsUrl('https://taro.surf/')).toBe('https://taro.surf');
		expect(normalizeHttpsUrl('https://taro.surf/path/')).toBe('https://taro.surf/path');
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeHttpsUrl('  https://taro.surf  ')).toBe('https://taro.surf');
	});

	it('rejects a non-https (http) URL', () => {
		expect(normalizeHttpsUrl('http://taro.surf')).toBeNull();
	});

	it('rejects a bare host with no scheme', () => {
		expect(normalizeHttpsUrl('taro.surf')).toBeNull();
	});

	it('rejects a malformed URL', () => {
		// e.g. the value ensureUrlScheme('bad domain!!') produces before validation.
		expect(normalizeHttpsUrl('https://bad domain!!')).toBeNull();
	});

	it('returns null for empty / whitespace / nullish input', () => {
		expect(normalizeHttpsUrl('')).toBeNull();
		expect(normalizeHttpsUrl('   ')).toBeNull();
		expect(normalizeHttpsUrl(null)).toBeNull();
		expect(normalizeHttpsUrl(undefined)).toBeNull();
	});
});
