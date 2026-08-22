// Thin client for the cons.fyi public data feed — the master list of furry
// conventions. We only use it to populate the admin convention picker; the
// public site reads cons from our own D1 table (a picked con is copied in).
// See the cons.fyi repo: data is a JSONL stream of events, one per line.

export interface ConsFyiEvent {
	id: string;
	name: string;
	url: string;
	startDate: string;
	endDate: string;
	venue?: string;
	/** Best-effort "City, ST" derived from the event's full address. */
	location: string;
	/** IANA zone of the event, e.g. 'America/Denver'. Present on every row of the
	 * feed we have seen, but treated as optional so a row missing it still parses. */
	timezone?: string;
}

const FEED_URL = 'https://data.cons.fyi/current.jsonl';
const TTL_MS = 60 * 60 * 1000; // 1h — the feed changes slowly.

// cons.fyi runs an atproto labeler: marking a con as "going" applies that con's
// label to your Bluesky account. We read those labels to sync your schedule.
const CONSFYI_LABELER_DID = 'did:plc:7s5echp3dzm2y5kxfe3mwzon';
const APPVIEW = 'https://public.api.bsky.app';

async function fetchJson(url: string): Promise<any | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const resp = await fetch(url, { signal: controller.signal });
		if (!resp.ok) return null;
		return await resp.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

// Per-isolate memo so we don't refetch 100+ lines on every admin page load.
let cache: { at: number; events: ConsFyiEvent[] } | null = null;

/** Pull a clean "City, ST" (or "City, Country") out of a cons.fyi address. */
function deriveLocation(address?: string, venue?: string): string {
	if (!address) return venue ?? '';
	// US form: "..., City, ST 12345, Country"
	const us = address.match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{4,}/);
	if (us) return `${us[1].trim()}, ${us[2]}`;
	const parts = address
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length >= 2) return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
	return venue ?? address;
}

/** An IANA zone name and nothing else. The zone the feed hands us is stored on
 *  the convention row and then fed to Intl to decide whether a con is running
 *  now, so it is worth rejecting a junk value from a third party here.
 *
 *  Asking Intl rather than matching a shape, because Intl is what consumes the
 *  stored value: a shape check both accepts names Intl cannot resolve
 *  (`Foo/Bar`) and rejects single-segment names that are real zones (`UTC`,
 *  `Japan`). Those are the two answers that matter and a regex gets both wrong.
 *  Unresolvable zones are not fatal downstream — `dateInZone` catches and the
 *  window widens — but a con with a real zone should take the exact path. */
function ianaZone(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') return undefined;
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: value });
		return value;
	} catch {
		return undefined;
	}
}

/** Fetch + parse the feed (cached). Returns [] on any failure so the admin
 * page degrades to manual entry rather than erroring. */
export async function fetchConsFyiEvents(): Promise<ConsFyiEvent[]> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.events;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const resp = await fetch(`${FEED_URL}?${Date.now()}`, { signal: controller.signal });
		if (!resp.ok) throw new Error(`cons.fyi feed ${resp.status}`);
		const text = await resp.text();

		const events: ConsFyiEvent[] = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line);
				if (!e.id || !e.name || !e.startDate) continue;
				events.push({
					id: String(e.id),
					name: String(e.name),
					url: typeof e.url === 'string' ? e.url : '',
					startDate: String(e.startDate),
					endDate: typeof e.endDate === 'string' ? e.endDate : String(e.startDate),
					venue: typeof e.venue === 'string' ? e.venue : undefined,
					location: deriveLocation(e.address, e.venue),
					timezone: ianaZone(e.timezone)
				});
			} catch {
				// Skip malformed lines.
			}
		}
		events.sort((a, b) => a.startDate.localeCompare(b.startDate));
		cache = { at: Date.now(), events };
		return events;
	} catch {
		return cache?.events ?? [];
	} finally {
		clearTimeout(timeout);
	}
}

/** Look up a single feed event by its cons.fyi id. */
export async function findConsFyiEvent(id: string): Promise<ConsFyiEvent | undefined> {
	return (await fetchConsFyiEvents()).find((e) => e.id === id);
}

/** Extract a Bluesky handle (or did) from a profile URL/handle setting. */
export function blueskyHandle(urlOrHandle: string): string | null {
	if (!urlOrHandle) return null;
	const v = urlOrHandle.trim();
	if (v.startsWith('did:')) return v;
	try {
		const u = new URL(v);
		const seg = u.pathname.split('/').filter(Boolean).pop();
		return seg ?? u.hostname;
	} catch {
		return v.replace(/^@/, '') || null;
	}
}

async function resolveHandleToDid(handle: string): Promise<string | null> {
	if (handle.startsWith('did:')) return handle;
	const data = await fetchJson(
		`${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
	);
	return data?.did ?? null;
}

// Map of label identifier -> cons.fyi event id, from the labeler's definitions.
let labelMapCache: { at: number; map: Record<string, string> } | null = null;

async function fetchLabelIdentifierToEventId(): Promise<Record<string, string>> {
	if (labelMapCache && Date.now() - labelMapCache.at < TTL_MS) return labelMapCache.map;
	const data = await fetchJson(
		`${APPVIEW}/xrpc/app.bsky.labeler.getServices?dids=${CONSFYI_LABELER_DID}&detailed=true`
	);
	const defs = data?.views?.[0]?.policies?.labelValueDefinitions ?? [];
	const map: Record<string, string> = {};
	for (const def of defs) {
		if (def?.identifier && def?.fbl_eventId) map[def.identifier] = def.fbl_eventId;
	}
	if (Object.keys(map).length) labelMapCache = { at: Date.now(), map };
	return map;
}

/** The label values (identifiers) currently applied to a DID by the cons.fyi
 * labeler, with negations resolved. */
async function fetchActiveLabelVals(did: string): Promise<string[]> {
	const active = new Set<string>();
	let cursor = '';
	for (let page = 0; page < 10; page++) {
		const url =
			`${APPVIEW}/xrpc/com.atproto.label.queryLabels` +
			`?uriPatterns=${encodeURIComponent(did)}&sources=${CONSFYI_LABELER_DID}&limit=250` +
			(cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
		const data = await fetchJson(url);
		if (!data) break;
		for (const l of data.labels ?? []) {
			if (l?.val == null) continue;
			if (l.neg) active.delete(l.val);
			else active.add(l.val);
		}
		if (!data.cursor) break;
		cursor = data.cursor;
	}
	return [...active];
}

/** Resolve the conventions a Bluesky account has marked "going" on cons.fyi
 * into full feed events. Returns [] if the handle can't be resolved or nothing
 * is marked. */
export async function fetchAttendingEvents(handleOrUrl: string): Promise<ConsFyiEvent[]> {
	const handle = blueskyHandle(handleOrUrl);
	if (!handle) return [];
	const did = await resolveHandleToDid(handle);
	if (!did) return [];

	const [vals, map, events] = await Promise.all([
		fetchActiveLabelVals(did),
		fetchLabelIdentifierToEventId(),
		fetchConsFyiEvents()
	]);

	const wantIds = new Set(vals.map((v) => map[v]).filter(Boolean));
	return events.filter((e) => wantIds.has(e.id));
}
