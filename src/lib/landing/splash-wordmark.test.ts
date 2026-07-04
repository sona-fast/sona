import { describe, it, expect } from 'vitest';
import { splashWordmark } from './index';

describe('splashWordmark', () => {
	it('prefers the owner name when set (persona name ≠ domain)', () => {
		expect(splashWordmark('Sunday', 'sheeb.net')).toBe('SUNDAY');
	});

	it('falls back to the site name with the domain suffix stripped', () => {
		expect(splashWordmark('', 'akito.dog')).toBe('AKITO');
	});

	it('keeps an owner name that matches the domain stem stable', () => {
		// akito.dog sets ownerName "Akito" — the headline must not change.
		expect(splashWordmark('Akito', 'akito.dog')).toBe('AKITO');
	});

	it('leaves a non-domain site name intact (just uppercased)', () => {
		expect(splashWordmark('', 'My Sona Site')).toBe('MY SONA SITE');
	});

	it('strips only the final domain-style suffix', () => {
		expect(splashWordmark('', 'www.sheeb.net')).toBe('WWW.SHEEB');
	});
});
