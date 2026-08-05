import { describe, it, expect } from 'vitest';
import { atHandleFromUrl, handleFromUrl, handleSegment } from './social-label';

describe('handleSegment', () => {
	it('returns the last non-empty path segment', () => {
		expect(handleSegment('https://www.instagram.com/taro')).toBe('taro');
	});

	it('ignores a trailing slash', () => {
		expect(handleSegment('https://www.instagram.com/taro/')).toBe('taro');
	});

	it('returns null for a pathless URL', () => {
		expect(handleSegment('https://twitter.com/')).toBeNull();
	});

	it('returns null for an unparseable string', () => {
		expect(handleSegment('not a url')).toBeNull();
	});

	it('returns null for undefined', () => {
		expect(handleSegment(undefined)).toBeNull();
	});
});

describe('handleFromUrl', () => {
	it('returns the handle when present', () => {
		expect(handleFromUrl('https://t.me/taro', 'Telegram')).toBe('taro');
	});

	it('falls back to the platform name when no handle exists', () => {
		expect(handleFromUrl('https://t.me/', 'Telegram')).toBe('Telegram');
		expect(handleFromUrl(undefined, 'Telegram')).toBe('Telegram');
	});
});

describe('atHandleFromUrl', () => {
	it('prefixes @ when a handle is present', () => {
		expect(atHandleFromUrl('https://www.instagram.com/taro', 'Instagram')).toBe('@taro');
	});

	it('falls back to the bare platform name for a pathless URL', () => {
		expect(atHandleFromUrl('https://twitter.com/', 'Twitter')).toBe('Twitter');
	});

	it('keeps the @ on a handle equal to the platform name', () => {
		// Regression: the old fallback comparison (handle === fallback) stripped
		// the @ from a real handle that collides with the platform name.
		expect(atHandleFromUrl('https://www.instagram.com/Instagram', 'Instagram')).toBe('@Instagram');
	});

	it('falls back for an unparseable string', () => {
		expect(atHandleFromUrl('not a url', 'Twitter')).toBe('Twitter');
	});

	it('falls back for undefined', () => {
		expect(atHandleFromUrl(undefined, 'Twitter')).toBe('Twitter');
	});
});
