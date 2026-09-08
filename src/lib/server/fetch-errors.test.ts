import { describe, expect, it } from 'vitest';
import { errorLabel, timeoutSignal } from './fetch-errors';

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

describe('timeoutSignal', () => {
	it('aborts when the caller\'s signal aborts, well before the timeout', () => {
		const controller = new AbortController();
		const signal = timeoutSignal(60_000, controller.signal);
		expect(signal.aborted).toBe(false);
		controller.abort();
		expect(signal.aborted).toBe(true);
	});

	it('aborts from the timeout side while the caller\'s signal is still live', async () => {
		const signal = timeoutSignal(5, new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).name).toBe('TimeoutError');
	});
});
