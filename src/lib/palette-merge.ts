// Palette size cap (owner decision, #55): enforced in the settings UI, the
// ref-sheet picker, and the server-side save path alike. Client-safe module —
// importable from both browser code and +page.server.ts.
export const MAX_SONA_COLORS = 10;

// Which suggested hexes "Add all" should append to the palette: skips any hex
// already present (case-insensitive) and dedupes within the suggestions
// themselves. Returns the suggestions' original casing, in order. `limit`
// caps how many are returned (the palette's remaining capacity).
export function mergeSuggestions(
	existingHexes: string[],
	suggestions: string[],
	limit = Infinity
): string[] {
	const seen = new Set(existingHexes.map((h) => h.toLowerCase()));
	const toAdd: string[] = [];
	for (const hex of suggestions) {
		if (toAdd.length >= limit) break;
		const key = hex.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		toAdd.push(hex);
	}
	return toAdd;
}

// Case-insensitive palette membership — the single-pick dedupe check ("New
// color" picks and suggestion pills use this; overwriting an existing slot
// stays unrestricted).
export function paletteHas(existingHexes: string[], hex: string): boolean {
	const key = hex.toLowerCase();
	return existingHexes.some((h) => h.toLowerCase() === key);
}
