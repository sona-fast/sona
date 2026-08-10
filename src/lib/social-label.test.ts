import { describe, it, expect } from 'vitest';
import { atHandleFromUrl, handleFromUrl, handleSegment } from './social-label';

describe('handleSegment', () => {
	it('returns the last non-empty path segment', () => {
		expect(handleSegment('https://www.instagram.com/sona.e2e.example')).toBe('sona.e2e.example');
	});

	it('ignores a trailing slash', () => {
		expect(handleSegment('https://www.instagram.com/sona.e2e.example/')).toBe('sona.e2e.example');
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

	it('decodes a percent-encoded handle', () => {
		expect(handleSegment('https://www.instagram.com/tar%C3%B6')).toBe('tarö');
	});

	it('keeps the raw segment on a malformed escape', () => {
		expect(handleSegment('https://www.instagram.com/tar%ZZ')).toBe('tar%ZZ');
	});
});

describe('handleFromUrl', () => {
	it('returns the handle when present', () => {
		expect(handleFromUrl('https://t.me/sona.e2e.example', 'Telegram')).toBe('sona.e2e.example');
	});

	it('falls back to the platform name when no handle exists', () => {
		expect(handleFromUrl('https://t.me/', 'Telegram')).toBe('Telegram');
		expect(handleFromUrl(undefined, 'Telegram')).toBe('Telegram');
	});
});

describe('atHandleFromUrl', () => {
	it('prefixes @ when a handle is present', () => {
		expect(atHandleFromUrl('https://www.instagram.com/sona.e2e.example', 'Instagram')).toBe('@sona.e2e.example');
	});

	it('falls back to the bare platform name for a pathless URL', () => {
		expect(atHandleFromUrl('https://twitter.com/', 'Twitter')).toBe('Twitter');
	});

	it('keeps the @ on a handle equal to the platform name', () => {
		// Regression: the old fallback comparison (handle === fallback) stripped
		// the @ from a real handle that collides with the platform name.
		expect(atHandleFromUrl('https://www.instagram.com/Instagram', 'Instagram')).toBe('@Instagram');
	});

	it('decodes a percent-encoded handle before prefixing', () => {
		expect(atHandleFromUrl('https://www.instagram.com/tar%C3%B6', 'Instagram')).toBe('@tarö');
	});

	it('falls back for an unparseable string', () => {
		expect(atHandleFromUrl('not a url', 'Twitter')).toBe('Twitter');
	});

	it('falls back for undefined', () => {
		expect(atHandleFromUrl(undefined, 'Twitter')).toBe('Twitter');
	});
});
