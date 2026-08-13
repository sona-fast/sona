import { describe, it, expect } from 'vitest';
import {
	supporterKeyValidUntil,
	supporterKeyDaysRemaining,
	viewerTimeZone
} from './supporter-key-expiry';

// Keys carry `exp` as end-of-day UTC, so this one covers through 2026-08-10 UTC.
const EXP = Date.UTC(2026, 7, 11, 0, 0, 0);
const DAY_MS = 86_400_000;

/** The zone the browser reports, as Intl sees it. */
const TOKYO = 'Asia/Tokyo'; // UTC+9, no DST
const LA = 'America/Los_Angeles'; // UTC-7 in August
const KIRITIMATI = 'Pacific/Kiritimati'; // UTC+14, the far edge
const MIDWAY = 'Pacific/Midway'; // UTC-11, the other one

/** Today's dotted date in `zone`, computed independently of the module under
 * test so the agreement check below isn't self-fulfilling. */
function todayIn(ms: number, zone: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	})
		.format(new Date(ms))
		.replaceAll('-', '.');
}

describe('supporterKeyValidUntil', () => {
	it('names the last covered day, not the exclusive exp instant', () => {
		expect(supporterKeyValidUntil(EXP, 'UTC')).toBe('2026.08.10');
	});

	it('reads that instant in the viewer zone', () => {
		// 2026-08-10T23:59:59Z is already the 11th in Tokyo and still the 10th in LA.
		expect(supporterKeyValidUntil(EXP, TOKYO)).toBe('2026.08.11');
		expect(supporterKeyValidUntil(EXP, LA)).toBe('2026.08.10');
	});
});

describe('supporterKeyDaysRemaining', () => {
	it('counts 1 on the last covered day and 0 once lapsed', () => {
		expect(supporterKeyDaysRemaining(EXP, Date.UTC(2026, 7, 10, 12), 'UTC')).toBe(1);
		expect(supporterKeyDaysRemaining(EXP, Date.UTC(2026, 7, 9, 12), 'UTC')).toBe(2);
		expect(supporterKeyDaysRemaining(EXP, EXP, 'UTC')).toBe(0);
	});

	it('matches the wall-clock delta it replaced, in UTC', () => {
		// The old server formula was ceil((exp - now) / DAY). Because exp lands on
		// midnight UTC exactly, calendar-day counting is identical there — so the
		// dismissal-cookie phase and the warn window did not move.
		for (let h = 0; h < 24 * 14; h++) {
			const now = EXP - h * 3_600_000;
			expect(supporterKeyDaysRemaining(EXP, now, 'UTC')).toBe(Math.ceil((EXP - now) / DAY_MS));
		}
	});

	it('counts calendar days in the viewer zone, not UTC', () => {
		// 2026-08-10T20:00Z is 2026-08-11 05:00 in Tokyo — the key's last covered
		// day there. The old wall-clock count said "1 day" while the UTC-rendered
		// date said 2026.08.10, i.e. yesterday to that operator.
		const now = Date.UTC(2026, 7, 10, 20);
		expect(supporterKeyDaysRemaining(EXP, now, TOKYO)).toBe(1);
		expect(supporterKeyValidUntil(EXP, TOKYO)).toBe('2026.08.11');
		expect(supporterKeyDaysRemaining(EXP, now, LA)).toBe(1);
		expect(supporterKeyValidUntil(EXP, LA)).toBe('2026.08.10');
	});
});

describe('viewerTimeZone', () => {
	it('takes a real IANA zone from the cookie', () => {
		expect(viewerTimeZone(TOKYO)).toBe(TOKYO);
	});

	it('falls back to UTC when the cookie is absent', () => {
		// No JS, or the operator's very first admin page view.
		expect(viewerTimeZone(undefined)).toBe('UTC');
		expect(viewerTimeZone('')).toBe('UTC');
	});

	it('falls back to UTC rather than throwing on a hostile cookie', () => {
		// The value is attacker-suppliable and Intl throws RangeError on an
		// unknown zone — unguarded, that would take down the whole admin layout.
		for (const junk of ['Not/AZone', '../../etc', 'UTC; DROP', '\u0000']) {
			expect(viewerTimeZone(junk)).toBe('UTC');
		}
	});
});

describe('the countdown and the date can never contradict', () => {
	// The whole point of SONA-119: wherever the operator is, "expires today"
	// appears if and only if the date printed beside it is today's local date.
	for (const zone of ['UTC', TOKYO, LA, KIRITIMATI, MIDWAY]) {
		it(`holds across the expiry boundary in ${zone}`, () => {
			const validUntil = supporterKeyValidUntil(EXP, zone);
			// Every half hour of the last four days before expiry.
			for (let step = 0; step < 4 * 48; step++) {
				const now = EXP - step * 1_800_000 - 1;
				const days = supporterKeyDaysRemaining(EXP, now, zone);
				expect(days).toBeGreaterThanOrEqual(1);
				expect(days === 1).toBe(validUntil === todayIn(now, zone));
			}
		});
	}
});
