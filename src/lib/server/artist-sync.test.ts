import { describe, it, expect } from 'vitest';
import { pickRefreshedAvatar } from './artist-sync';

const BSKY_OLD = 'https://cdn.bsky.app/img/avatar/plain/did:a/OLD@jpeg';
const BSKY_NEW = 'https://cdn.bsky.app/img/avatar/plain/did:a/NEW@jpeg';
const SELF_HOSTED = 'https://cdn.example.com/avatars/1.png';

describe('pickRefreshedAvatar', () => {
	it('fills an empty local avatar from the registry', () => {
		expect(pickRefreshedAvatar(null, BSKY_NEW)).toBe(BSKY_NEW);
		expect(pickRefreshedAvatar('', BSKY_NEW)).toBe(BSKY_NEW);
	});

	it('replaces a stale bsky-derived local avatar when the registry differs', () => {
		expect(pickRefreshedAvatar(BSKY_OLD, BSKY_NEW)).toBe(BSKY_NEW);
	});

	it('keeps a hand-set / self-hosted local avatar untouched', () => {
		expect(pickRefreshedAvatar(SELF_HOSTED, BSKY_NEW)).toBe(SELF_HOSTED);
	});

	it('keeps the local avatar when the registry has none (never wipes)', () => {
		expect(pickRefreshedAvatar(BSKY_OLD, null)).toBe(BSKY_OLD);
	});

	it('is a no-op when the bsky avatar is already current', () => {
		expect(pickRefreshedAvatar(BSKY_NEW, BSKY_NEW)).toBe(BSKY_NEW);
	});
});
