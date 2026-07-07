// Which suggested hexes "Add all" should append to the palette: skips any hex
// already present (case-insensitive) and dedupes within the suggestions
// themselves. Returns the suggestions' original casing, in order.
export function mergeSuggestions(existingHexes: string[], suggestions: string[]): string[] {
	const seen = new Set(existingHexes.map((h) => h.toLowerCase()));
	const toAdd: string[] = [];
	for (const hex of suggestions) {
		const key = hex.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		toAdd.push(hex);
	}
	return toAdd;
}
