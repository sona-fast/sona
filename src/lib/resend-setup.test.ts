import { describe, it, expect } from 'vitest';
import { resendSetupProgress } from './resend-setup';

describe('resendSetupProgress', () => {
	it('counts neither required step when nothing is configured', () => {
		expect(resendSetupProgress({ resendKeySet: false, adminEmailSet: false })).toEqual({
			done: 0,
			total: 2,
			ready: false
		});
	});

	it('counts one when only the API key is set', () => {
		expect(resendSetupProgress({ resendKeySet: true, adminEmailSet: false })).toEqual({
			done: 1,
			total: 2,
			ready: false
		});
	});

	it('counts one when only the recovery email is set', () => {
		expect(resendSetupProgress({ resendKeySet: false, adminEmailSet: true })).toEqual({
			done: 1,
			total: 2,
			ready: false
		});
	});

	it('is ready only when both required steps are done', () => {
		expect(resendSetupProgress({ resendKeySet: true, adminEmailSet: true })).toEqual({
			done: 2,
			total: 2,
			ready: true
		});
	});
});
