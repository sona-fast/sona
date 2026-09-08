import { describe, expect, it } from 'vitest';
import { errorLabel } from './fetch-errors';

describe('errorLabel', () => {
	it('reduces a parse failure to its name and keeps everything else readable', () => {
		// Every fail-soft catch in entail.ts and twitter-media.ts logs through
		// this. A SyntaxError's message quotes the body that failed to parse.
		let parseError: unknown;
		try {
			JSON.parse('<html>secret-body');
		} catch (e) {
			parseError = e;
		}
		expect(errorLabel(parseError)).toBe('SyntaxError');
		expect(errorLabel(new Error('TimeoutError'))).toBe('TimeoutError');
		expect(errorLabel('plain string')).toBe('plain string');
		expect(errorLabel(42)).toBe('42');
	});
});
