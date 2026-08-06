import { describe, it, expect } from 'vitest';
import { isConventionRunning, isLiveNow, dateInZone } from './convention-window';

// Tails of Summer 2026, the event this was built against: two days, UTC-7.
const TAILS = { startDate: '2026-08-08', endDate: '2026-08-09', timezone: 'America/Vancouver' };

describe('dateInZone', () => {
	it('reports the local calendar date, not the UTC one', () => {
		// 02:30 UTC on the 10th is still the evening of the 9th in Vancouver.
		const t = new Date('2026-08-10T02:30:00Z');
		expect(t.toISOString().slice(0, 10)).toBe('2026-08-10');
		expect(dateInZone(t, 'America/Vancouver')).toBe('2026-08-09');
	});

	it('returns null for a zone the runtime does not know', () => {
		expect(dateInZone(new Date('2026-08-08T12:00:00Z'), 'Not/AZone')).toBeNull();
	});
});

describe('isConventionRunning, with a timezone', () => {
	it('is running through the whole of the closing day', () => {
		// 19:00 on the 9th in Vancouver. Naive UTC has already rolled to the 10th
		// and would call the convention over while people are still there.
		const duringDeadDog = new Date('2026-08-10T02:00:00Z');
		expect(duringDeadDog.toISOString().slice(0, 10)).toBe('2026-08-10');
		expect(isConventionRunning(TAILS, duringDeadDog)).toBe(true);
	});

	it('is not running the evening before it opens', () => {
		// 18:00 on the 7th in Vancouver. Naive UTC is already the 8th and would
		// switch the banner on a day early.
		const nightBefore = new Date('2026-08-08T01:00:00Z');
		expect(nightBefore.toISOString().slice(0, 10)).toBe('2026-08-08');
		expect(isConventionRunning(TAILS, nightBefore)).toBe(false);
	});

	it('is running on the first day', () => {
		expect(isConventionRunning(TAILS, new Date('2026-08-08T17:00:00Z'))).toBe(true);
	});

	it('is not running once the closing day is over locally', () => {
		// 00:30 on the 10th in Vancouver.
		expect(isConventionRunning(TAILS, new Date('2026-08-10T07:30:00Z'))).toBe(false);
	});

	it('handles a single-day convention with no end date', () => {
		const oneDay = { startDate: '2026-08-08', endDate: null, timezone: 'America/Vancouver' };
		expect(isConventionRunning(oneDay, new Date('2026-08-08T20:00:00Z'))).toBe(true);
		expect(isConventionRunning(oneDay, new Date('2026-08-09T20:00:00Z'))).toBe(false);
	});

	it('works east of UTC too', () => {
		const jmof = { startDate: '2027-01-08', endDate: '2027-01-10', timezone: 'Asia/Tokyo' };
		// 22:00 UTC on the 7th is already the morning of the 8th in Tokyo.
		expect(isConventionRunning(jmof, new Date('2027-01-07T22:00:00Z'))).toBe(true);
	});
});

describe('isConventionRunning, without a timezone', () => {
	const noZone = { startDate: '2026-08-08', endDate: '2026-08-09', timezone: null };

	it('still covers the event itself', () => {
		expect(isConventionRunning(noZone, new Date('2026-08-08T12:00:00Z'))).toBe(true);
		expect(isConventionRunning(noZone, new Date('2026-08-09T12:00:00Z'))).toBe(true);
	});

	it('errs toward showing: a day of margin at each end', () => {
		expect(isConventionRunning(noZone, new Date('2026-08-07T12:00:00Z'))).toBe(true);
		expect(isConventionRunning(noZone, new Date('2026-08-10T12:00:00Z'))).toBe(true);
	});

	it('does not extend beyond the margin', () => {
		expect(isConventionRunning(noZone, new Date('2026-08-06T12:00:00Z'))).toBe(false);
		expect(isConventionRunning(noZone, new Date('2026-08-11T12:00:00Z'))).toBe(false);
	});

	it('treats an unrecognised zone string as no zone', () => {
		const bogus = { ...noZone, timezone: 'Mars/Olympus' };
		expect(isConventionRunning(bogus, new Date('2026-08-07T12:00:00Z'))).toBe(true);
	});
});

describe('isLiveNow', () => {
	it('is live for a confirmed convention that is running', () => {
		expect(isLiveNow({ ...TAILS, status: 'confirmed' }, new Date('2026-08-08T17:00:00Z'))).toBe(true);
	});

	it('is never live for a convention the operator only marked considering', () => {
		// The whole point of the status gate: a maybe must not assert presence.
		const now = new Date('2026-08-08T17:00:00Z');
		expect(isLiveNow({ ...TAILS, status: 'considering' }, now)).toBe(false);
		expect(isLiveNow({ ...TAILS, status: 'maybe' }, now)).toBe(false);
	});

	it('is not live for a confirmed convention that is not running', () => {
		expect(isLiveNow({ ...TAILS, status: 'confirmed' }, new Date('2026-09-01T12:00:00Z'))).toBe(
			false
		);
	});
});
