import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// consfyi.ts memoizes the parsed feed in a module-level cache, so each test
// re-imports the module fresh (after resetModules) to start from an empty cache.
// The feed is a JSONL stream — one JSON event per line — fetched over global
// `fetch`, which we stub per test. Fixtures are inline so this file ports to
// sparky/akito untouched.

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Stub global fetch to return `body` (a JSONL string) with the given status. */
function stubFeed(body: string, { ok = true, status = 200 } = {}) {
	const fetchMock = vi.fn(async () => ({
		ok,
		status,
		text: async () => body
	}));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** Stub global fetch to reject, simulating an unreachable feed. */
function stubUnreachable() {
	const fetchMock = vi.fn(async () => {
		throw new Error('network down');
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

describe('fetchConsFyiEvents', () => {
	it('parses a representative feed and sorts by start date', async () => {
		stubFeed(
			jsonl(
				{ id: 'b', name: 'Later Con', startDate: '2026-11-01', endDate: '2026-11-03' },
				{ id: 'a', name: 'Earlier Con', startDate: '2026-09-10', endDate: '2026-09-12' }
			)
		);
		const { fetchConsFyiEvents } = await import('./consfyi');
		const events = await fetchConsFyiEvents();
		expect(events.map((e) => e.id)).toEqual(['a', 'b']);
		expect(events[0]).toMatchObject({ name: 'Earlier Con', startDate: '2026-09-10', endDate: '2026-09-12' });
	});

	it('skips malformed JSON lines and entries missing required fields', async () => {
		stubFeed(
			[
				'', // blank line
				'{ not valid json', // unparseable
				JSON.stringify({ name: 'No id', startDate: '2026-09-10' }), // missing id
				JSON.stringify({ id: 'x', startDate: '2026-09-10' }), // missing name
				JSON.stringify({ id: 'y', name: 'No date' }), // missing startDate
				JSON.stringify({ id: 'ok', name: 'Good Con', startDate: '2026-09-10' })
			].join('\n')
		);
		const { fetchConsFyiEvents } = await import('./consfyi');
		const events = await fetchConsFyiEvents();
		expect(events.map((e) => e.id)).toEqual(['ok']);
	});

	it('defaults endDate to startDate when absent', async () => {
		stubFeed(jsonl({ id: 'a', name: 'One Day', startDate: '2026-09-10' }));
		const { fetchConsFyiEvents } = await import('./consfyi');
		const [event] = await fetchConsFyiEvents();
		expect(event.endDate).toBe('2026-09-10');
	});

	it('derives "City, ST" from a US address, and falls back otherwise', async () => {
		stubFeed(
			jsonl(
				{
					id: 'us',
					name: 'US Con',
					startDate: '2026-09-10',
					address: '2301 S Dr Martin Luther King Jr Dr, Milwaukee, WI 53215, USA'
				},
				{
					id: 'intl',
					name: 'Intl Con',
					startDate: '2026-10-10',
					address: 'Some Hall, Tokyo, Japan'
				},
				{ id: 'venue', name: 'Venue Only', startDate: '2026-11-10', venue: 'The Big Hall' }
			)
		);
		const { fetchConsFyiEvents } = await import('./consfyi');
		const byId = Object.fromEntries((await fetchConsFyiEvents()).map((e) => [e.id, e.location]));
		expect(byId.us).toBe('Milwaukee, WI');
		expect(byId.intl).toBe('Tokyo, Japan');
		expect(byId.venue).toBe('The Big Hall');
	});

	it('returns [] (no throw) when the feed responds non-OK', async () => {
		stubFeed('', { ok: false, status: 503 });
		const { fetchConsFyiEvents } = await import('./consfyi');
		await expect(fetchConsFyiEvents()).resolves.toEqual([]);
	});

	it('returns [] (no throw) when the feed is unreachable', async () => {
		stubUnreachable();
		const { fetchConsFyiEvents } = await import('./consfyi');
		await expect(fetchConsFyiEvents()).resolves.toEqual([]);
	});

	it('memoizes within the TTL: a second call does not refetch', async () => {
		const fetchMock = stubFeed(jsonl({ id: 'a', name: 'Cached Con', startDate: '2026-09-10' }));
		const { fetchConsFyiEvents } = await import('./consfyi');
		const first = await fetchConsFyiEvents();
		const second = await fetchConsFyiEvents();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});
});

describe('findConsFyiEvent (admin picker sourceId lookup)', () => {
	it('finds a feed event by its cons.fyi id', async () => {
		stubFeed(
			jsonl(
				{ id: 'mff', name: 'Midwest FurFest', startDate: '2026-12-03' },
				{ id: 'ac', name: 'Anthrocon', startDate: '2026-07-02' }
			)
		);
		const { findConsFyiEvent } = await import('./consfyi');
		expect(await findConsFyiEvent('mff')).toMatchObject({ name: 'Midwest FurFest' });
	});

	it('returns undefined for an id no longer in the feed', async () => {
		stubFeed(jsonl({ id: 'ac', name: 'Anthrocon', startDate: '2026-07-02' }));
		const { findConsFyiEvent } = await import('./consfyi');
		expect(await findConsFyiEvent('gone')).toBeUndefined();
	});
});

describe('blueskyHandle', () => {
	it('extracts the handle from a profile URL', async () => {
		const { blueskyHandle } = await import('./consfyi');
		expect(blueskyHandle('https://bsky.app/profile/alice.bsky.social')).toBe('alice.bsky.social');
	});

	it('passes a DID through unchanged', async () => {
		const { blueskyHandle } = await import('./consfyi');
		expect(blueskyHandle('did:plc:7s5echp3dzm2y5kxfe3mwzon')).toBe('did:plc:7s5echp3dzm2y5kxfe3mwzon');
	});

	it('strips a leading @ from a bare handle', async () => {
		const { blueskyHandle } = await import('./consfyi');
		expect(blueskyHandle('@alice.bsky.social')).toBe('alice.bsky.social');
		expect(blueskyHandle('alice.bsky.social')).toBe('alice.bsky.social');
	});

	it('returns null for empty or whitespace-only input', async () => {
		const { blueskyHandle } = await import('./consfyi');
		expect(blueskyHandle('')).toBeNull();
		expect(blueskyHandle('   ')).toBeNull();
	});
});
