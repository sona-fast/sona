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

function build(over: Partial<Parameters<typeof buildStamps>[0]> = {}): PassportStamps {
	return buildStamps({ counts: NO_COUNTS, conventions: [], photos: [], aboutExtras: false, now: NOW, ...over });
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
			aboutExtras: true
		});
		expect(stamps.features).toEqual([
			{ kind: 'gallery', href: '/gallery', counts: [112, 31] },
			{ kind: 'fursuit', href: '/gallery?view=fursuit', counts: [46, 12] },
			{ kind: 'stickers', href: '/stickers', counts: [72, 3] },
			{ kind: 'vr', href: '/vr', counts: [2] },
			{ kind: 'collections', href: '/collections', counts: [5] },
			{ kind: 'about', href: '/about', counts: [] }
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

	it('shows About for socials or sona details, or for an upcoming or live convention', () => {
		expect(build().features.map((f) => f.kind)).not.toContain('about');
		expect(build({ aboutExtras: true }).features.map((f) => f.kind)).toContain('about');
		const upcoming = build({ conventions: [con({ id: 1, startDate: '2027-03-01' })] });
		expect(upcoming.features.map((f) => f.kind)).toEqual(['about']);
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
			aboutExtras: true,
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
