import { describe, it, expect } from 'vitest';
import {
	buildStamps,
	hasAnyStamp,
	machineLine,
	mrzField,
	pastEventStamps,
	MAX_PAST_STAMPS,
	MRZ_WIDTH,
	type PassportConvention,
	type PassportCounts,
	type PassportStamps
} from './passport';
import { LANDING_LAYOUTS } from './index';

const NOW = new Date('2026-10-17T18:00:00Z');

const NO_COUNTS: PassportCounts = {
	pieces: null,
	artists: null,
	photos: null,
	photographers: null,
	stickers: null,
	packs: null,
	avatars: null,
	collections: null
};

function con(over: Partial<PassportConvention> & { id: number; startDate: string }): PassportConvention {
	return { name: `Con ${over.id}`, location: null, endDate: null, timezone: 'UTC', status: 'confirmed', ...over };
}

const NO_ABOUT = { links: false, conventions: false };

function build(over: Partial<Parameters<typeof buildStamps>[0]> = {}): PassportStamps {
	return buildStamps({ counts: NO_COUNTS, conventions: [], photos: [], about: NO_ABOUT, now: NOW, ...over });
}

const allHrefs = (s: PassportStamps) => [
	...(s.live ? [s.live.href] : []),
	...s.features.map((f) => f.href),
	...s.conventions.map((c) => c.href)
];

describe('passport feature stamps', () => {
	it('renders no stamp at all for an empty site', () => {
		const stamps = build();
		expect(stamps).toEqual({ live: null, features: [], conventions: [] });
		expect(hasAnyStamp(stamps)).toBe(false);
	});

	it('renders each feature stamp only when its feature has content, in page order', () => {
		const stamps = build({
			counts: { pieces: 112, artists: 31, photos: 46, photographers: 12, stickers: 72, packs: 3, avatars: 2, collections: 5 },
			about: { ...NO_ABOUT, links: true }
		});
		expect(stamps.features).toEqual([
			{ kind: 'gallery', href: '/gallery', counts: [112, 31] },
			{ kind: 'fursuit', href: '/gallery?view=fursuit', counts: [46, 12] },
			{ kind: 'stickers', href: '/stickers', counts: [72, 3] },
			{ kind: 'vr', href: '/vr', counts: [2] },
			{ kind: 'collections', href: '/collections', counts: [5] },
			{ kind: 'about', href: '/about', counts: [], about: 'links' }
		]);
	});

	it('hides a stamp whose count is zero or unknown, so no line ever reads zero', () => {
		const stamps = build({
			counts: { pieces: 0, artists: 0, photos: null, photographers: null, stickers: 0, packs: 1, avatars: 0, collections: null }
		});
		expect(stamps.features).toEqual([]);
		for (const f of build({ counts: { ...NO_COUNTS, pieces: 3, artists: 1, avatars: 1 } }).features) {
			expect(f.counts.every((n) => n > 0)).toBe(true);
		}
	});

	it('shows About for socials or a convention /about lists', () => {
		expect(build().features.map((f) => f.kind)).not.toContain('about');
		expect(build({ about: { ...NO_ABOUT, links: true } }).features.map((f) => f.kind)).toContain('about');
		const upcoming = build({ about: { ...NO_ABOUT, conventions: true } });
		expect(upcoming.features.map((f) => f.kind)).toEqual(['about']);
	});

	// /about filters by today's UTC date, so on a live con's last evening in its
	// own zone it can already have dropped the row that still reads Here now.
	// Only /about's own read may promise conventions there.
	it('never promises conventions on About from the live or next row alone', () => {
		const live = con({ id: 1, startDate: '2026-10-16', endDate: '2026-10-17', timezone: 'America/Los_Angeles' });
		const next = con({ id: 2, startDate: '2027-03-01' });
		const stamps = build({ conventions: [live, next], about: { ...NO_ABOUT, links: true } });
		expect(stamps.live).not.toBeNull();
		expect(stamps.features.find((f) => f.kind === 'about')?.about).toBe('links');
		expect(build({ conventions: [live, next] }).features.map((f) => f.kind)).not.toContain('about');
	});

	// The line names what /about has, so a site with socials alone never
	// promises conventions.
	it("picks the About stamp's line by what /about holds", () => {
		const line = (over: Partial<Parameters<typeof buildStamps>[0]>) =>
			build(over).features.find((f) => f.kind === 'about')?.about;
		expect(line({ about: { ...NO_ABOUT, links: true } })).toBe('links');
		expect(line({ about: { ...NO_ABOUT, conventions: true } })).toBe('conventions');
		expect(line({ about: { ...NO_ABOUT, links: true, conventions: true } })).toBe('both');
	});
});

describe('passport convention stamps', () => {
	it('leads with Here now for a confirmed convention running in its own zone, and leaves it out of the list', () => {
		const live = con({ id: 1, name: 'Cinder Valley Con', location: 'Reno, Nevada', startDate: '2026-10-16', endDate: '2026-10-19', timezone: 'America/Los_Angeles' });
		const next = con({ id: 2, name: 'Lakeshore Den', startDate: '2027-03-05' });
		const stamps = build({ conventions: [next, live] });
		expect(stamps.live).toEqual({ name: 'Cinder Valley Con', location: 'Reno, Nevada', until: '2026-10-19', href: '/connect' });
		expect(stamps.conventions).toEqual([{ kind: 'next', name: 'Lakeshore Den', startDate: '2027-03-05', href: '/connect' }]);
	});

	it('never reads a second convention running at the same time as Next', () => {
		const first = con({ id: 1, name: 'First Live', startDate: '2026-10-15', endDate: '2026-10-19' });
		const second = con({ id: 2, name: 'Second Live', startDate: '2026-10-16', endDate: '2026-10-18' });
		const later = con({ id: 3, name: 'Later Con', startDate: '2027-03-05' });
		const stamps = build({ conventions: [later, second, first] });
		expect(stamps.live?.name).toBe('First Live');
		expect(stamps.conventions).toEqual([{ kind: 'next', name: 'Later Con', startDate: '2027-03-05', href: '/connect' }]);
		// With nothing later, the overlapping one still never becomes Next.
		expect(build({ conventions: [second, first] }).conventions).toEqual([]);
	});

	// Intl.DateTimeFormat throws on an Invalid Date, so a malformed stored date
	// must reach the page as no date at all, never as a string it will format.
	it('treats a stored convention date that is not a bare calendar date as missing', () => {
		const live = con({ id: 1, name: 'Stamped Live', startDate: '2026-10-16T00:00:00Z', endDate: '2026-10-19T00:00:00Z' });
		const next = con({ id: 2, name: 'Slashed Next', startDate: '2027/03/05' });
		const stamps = build({ conventions: [live, next] });
		expect(stamps.live).toMatchObject({ name: 'Stamped Live', until: null });
		expect(stamps.conventions).toEqual([{ kind: 'next', name: 'Slashed Next', startDate: null, href: '/connect' }]);

		const tz = con({ id: 3, name: 'Timestamped Next', startDate: '2027-03-05T00:00:00Z' });
		expect(build({ conventions: [tz] }).conventions).toEqual([
			{ kind: 'next', name: 'Timestamped Next', startDate: null, href: '/connect' }
		]);
	});

	it('never gives a maybe or considering row Here now or Next', () => {
		const stamps = build({
			conventions: [
				con({ id: 1, startDate: '2026-10-16', endDate: '2026-10-19', status: 'maybe' }),
				con({ id: 2, startDate: '2027-01-01', status: 'considering' })
			]
		});
		expect(stamps.live).toBeNull();
		expect(stamps.conventions).toEqual([]);
	});

	it('takes the zone into account: a convention whose last day is over in its zone is not Next', () => {
		// 18:00 UTC on the 17th is already the 18th in Kiritimati (UTC+14).
		const ended = con({ id: 1, startDate: '2026-10-15', endDate: '2026-10-17', timezone: 'Pacific/Kiritimati' });
		expect(build({ conventions: [ended] }).conventions).toEqual([]);
	});

	// Past stamps come from the fursuit photos' own event values, never from past
	// rows in the conventions table: /connect and /about publish only upcoming and
	// live conventions, so a table-derived stamp would publish where the operator
	// has been.
	it('gives a confirmed past convention with no photos no stamp', () => {
		const past = con({ id: 1, name: 'Harbourfur', startDate: '2025-11-07', endDate: '2025-11-09' });
		const stamps = build({ conventions: [past] });
		expect(stamps.conventions).toEqual([]);
		expect(stamps.live).toBeNull();
	});

	it('builds past stamps from photo events: month and count from the photos, linked to the filtered fursuit view', () => {
		const stamps = build({
			photos: [
				{ event: 'Harbourfur 2025', takenAt: '2025-11-08' },
				{ event: 'Harbourfur 2025', takenAt: '2025-11-09T10:00:00Z' },
				{ event: 'Pinewood Howl 2025', takenAt: '2025-06-14' },
				{ event: '', takenAt: '2025-06-14' },
				{ takenAt: '2025-06-14' }
			]
		});
		expect(stamps.conventions).toEqual([
			{ kind: 'past', name: 'Harbourfur 2025', month: '2025-11', photos: 2, href: '/gallery?view=fursuit&event=Harbourfur%202025' },
			{ kind: 'past', name: 'Pinewood Howl 2025', month: '2025-06', photos: 1, href: '/gallery?view=fursuit&event=Pinewood%20Howl%202025' }
		]);
	});

	it('treats a photo taken_at that names no real date as undated', () => {
		const past = pastEventStamps([
			{ event: 'Zeroed Con', takenAt: '0000-00-00 00:00:00' },
			{ event: 'Month Thirteen', takenAt: '2025-13-05' },
			{ event: 'Real Con', takenAt: '2025-06-14' }
		]);
		expect(past.map((p) => [p.name, p.kind === 'past' ? p.month : undefined])).toEqual([
			['Real Con', '2025-06'],
			['Month Thirteen', null],
			['Zeroed Con', null]
		]);
	});

	// Date rolls an impossible day over into the next month instead of failing,
	// so only a round trip tells "2026-02-30" from a real date.
	it('treats an impossible day as undated and keeps a real leap day', () => {
		const month = (takenAt: string) => {
			const [stamp] = pastEventStamps([{ event: 'Con', takenAt }]);
			return stamp.kind === 'past' ? stamp.month : undefined;
		};
		expect(month('2026-02-30')).toBeNull();
		expect(month('2026-04-31')).toBeNull();
		expect(month('2025-02-29')).toBeNull();
		expect(month('2024-02-29')).toBe('2024-02');
		expect(month('2026-02')).toBe('2026-02');
		const next = (startDate: string) => build({ conventions: [con({ id: 1, startDate })] }).conventions[0];
		expect(next('2027-02-30')).toMatchObject({ kind: 'next', startDate: null });
		expect(next('2028-02-29')).toMatchObject({ kind: 'next', startDate: '2028-02-29' });
	});

	// The gallery's event filter compares the stored value exactly, so the
	// stamp groups and links by it; only an all-whitespace event is skipped.
	it('groups and links past stamps by the stored event value, trailing space included', () => {
		const past = pastEventStamps([
			{ event: 'Harbourfur 2025 ', takenAt: '2025-11-08' },
			{ event: 'Harbourfur 2025', takenAt: '2025-11-09' },
			{ event: '   ', takenAt: '2025-11-09' }
		]);
		expect(past).toEqual([
			{ kind: 'past', name: 'Harbourfur 2025', month: '2025-11', photos: 1, href: '/gallery?view=fursuit&event=Harbourfur%202025' },
			{ kind: 'past', name: 'Harbourfur 2025 ', month: '2025-11', photos: 1, href: '/gallery?view=fursuit&event=Harbourfur%202025%20' }
		]);
	});

	it('orders past events on the same date alphabetically', () => {
		const past = pastEventStamps([
			{ event: 'Maple Den', takenAt: '2025-05-01' },
			{ event: 'Aspen Howl', takenAt: '2025-05-01' },
			{ event: 'Cedar Con', takenAt: '2025-05-01' }
		]);
		expect(past.map((p) => p.name)).toEqual(['Aspen Howl', 'Cedar Con', 'Maple Den']);
	});

	// Photos tagged during the event would otherwise add a past stamp for the
	// convention that reads Here now: a running event shown as over, twice.
	it('leaves the live convention out of the past stamps, matched on the exact event name', () => {
		const live = con({ id: 1, name: 'Cinder Valley Con', startDate: '2026-10-16', endDate: '2026-10-19' });
		const stamps = build({
			conventions: [live],
			photos: [
				{ event: 'Cinder Valley Con', takenAt: '2026-10-17' },
				{ event: 'Cinder Valley Con', takenAt: '2026-10-16' },
				{ event: 'Harbourfur 2025', takenAt: '2025-11-08' }
			]
		});
		expect(stamps.live?.name).toBe('Cinder Valley Con');
		expect(stamps.conventions).toEqual([
			{ kind: 'past', name: 'Harbourfur 2025', month: '2025-11', photos: 1, href: '/gallery?view=fursuit&event=Harbourfur%202025' }
		]);
		// The cap still fills with other events.
		const many = Array.from({ length: MAX_PAST_STAMPS }, (_, i) => ({ event: `Con ${i}`, takenAt: `202${i}-05-01` }));
		const capped = pastEventStamps([{ event: 'Live', takenAt: '2030-01-01' }, ...many], 'Live');
		expect(capped.map((p) => p.name)).toEqual(many.map((p) => p.event).reverse());
	});

	it('puts Next before the past stamps', () => {
		const stamps = build({
			conventions: [con({ id: 1, name: 'Lakeshore Den', startDate: '2027-03-05' })],
			photos: [{ event: 'FWA 2026', takenAt: '2026-03-21' }]
		});
		expect(stamps.conventions.map((c) => c.kind)).toEqual(['next', 'past']);
	});

	it('keeps the six newest past events, newest first, undated ones last', () => {
		const photos = [
			{ event: 'Undated Con' },
			...Array.from({ length: 8 }, (_, i) => ({ event: `Con ${i}`, takenAt: `202${i}-05-01` }))
		];
		const past = pastEventStamps(photos);
		expect(past).toHaveLength(MAX_PAST_STAMPS);
		expect(past.map((p) => p.name)).toEqual(['Con 7', 'Con 6', 'Con 5', 'Con 4', 'Con 3', 'Con 2']);
		expect(pastEventStamps([{ event: 'Undated Con' }, { event: 'Dated', takenAt: '2020-01-01' }]).map((p) => p.name)).toEqual([
			'Dated',
			'Undated Con'
		]);
		expect(pastEventStamps([{ event: 'Undated Con' }])[0]).toMatchObject({ kind: 'past', month: null });
	});

	it('links every stamp it renders: the unlinked stamp never occurs', () => {
		const stamps = build({
			counts: { pieces: 1, artists: 1, photos: 3, photographers: 1, stickers: 1, packs: 1, avatars: 1, collections: 1 },
			about: { ...NO_ABOUT, links: true },
			conventions: [
				con({ id: 1, startDate: '2026-10-16', endDate: '2026-10-19' }),
				con({ id: 2, startDate: '2027-03-05' }),
				con({ id: 3, startDate: '2024-01-01' })
			],
			photos: [{ event: 'A', takenAt: '2025-01-01' }, { event: 'B' }, { event: '  ' }]
		});
		const hrefs = allHrefs(stamps);
		expect(hrefs.length).toBe(1 + 6 + 3);
		for (const href of hrefs) expect(href).toMatch(/^\/[a-z]/);
	});
});

describe('passport machine-readable line', () => {
	it('builds two 44-character rows from the host, name, species, pronouns and year', () => {
		const [a, b] = machineLine({ host: 'example.ink', name: 'Ashby', species: 'Red fox', pronouns: 'she/her', since: '2019' });
		expect(a).toBe('P<EXAMPLE<INK<<ASHBY'.padEnd(MRZ_WIDTH, '<'));
		expect(b).toBe('RED<FOX<<SHEHER<<2019'.padEnd(MRZ_WIDTH, '<'));
	});

	it('falls back to the host on the second row, and never carries a count', () => {
		const [, b] = machineLine({ host: 'example.ink', name: 'Ashby', species: '', pronouns: '', since: null });
		expect(b).toBe('EXAMPLE<INK'.padEnd(MRZ_WIDTH, '<'));
		expect(b).not.toMatch(/\d/);
	});

	it('clips a long row to 44 characters and drops characters outside A-Z and 0-9', () => {
		const [a] = machineLine({ host: 'a-very-long-hostname.example.com', name: 'Émile the Magnificent', species: '', pronouns: '', since: null });
		expect(a).toHaveLength(MRZ_WIDTH);
		expect(mrzField('Émile d’Arc')).toBe('EMILE<DARC');
		expect(mrzField('たろう')).toBe('');
	});
});

// The settings action and the setup wizard accept only ids in LANDING_LAYOUTS,
// so dropping this entry would silently coerce a saved 'passport' to mosaic.
describe('passport landing layout registry', () => {
	it('lists passport as a landing layout', () => {
		expect(LANDING_LAYOUTS.map((l) => l.id)).toContain('passport');
	});
});
