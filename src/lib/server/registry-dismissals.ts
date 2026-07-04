// Local acknowledgement of rejected registry submissions. The registry keeps the
// rejected record forever, so without this a rejected badge would re-surface on
// every admin load. We persist the dismissed submission ids in site_settings
// (JSON number array) and filter them out — a local dismissal, never a delete.

/** Parse the stored JSON array into a set of submission ids (tolerant of garbage). */
export function parseDismissed(raw: string | null | undefined): Set<number> {
	if (!raw) return new Set();
	try {
		const arr = JSON.parse(raw);
		return new Set(Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []);
	} catch {
		return new Set();
	}
}

/** Add a dismissed id, returning the capped list to persist (newest kept). */
export function addDismissed(current: Set<number>, id: number, cap = 500): number[] {
	const next = new Set(current);
	next.add(id);
	return [...next].slice(-cap);
}
