// Server-only keyword→emoji lookup powering free-text sticker search ("heart" →
// 💜❤️🧡…). Telegram only gives us the emoji glyph per sticker, never a name, so we
// map search words to glyphs here and then filter sticker_emojis by the resulting
// set. A pasted glyph is matched directly by the caller; this handles word queries.
//
// emojilib maps glyph → keyword[] (e.g. "😀": ["grinning_face","face","smile"]).
// We invert it once per isolate into keyword-token → Set<glyph>.

import emojilib from 'emojilib';

const data = emojilib as unknown as Record<string, string[]>;

/**
 * Whether a string contains an emoji glyph (rather than plain search words). Uses
 * Extended_Pictographic so text-presentation emoji (❤️ ☺️ ✌️ ⚡ ✈️) and every
 * chip-rail glyph count — `Emoji_Presentation` alone misses VS16 text-default
 * emoji, which silently broke the "most-used" chips (e.g. ❤️) before this.
 */
export function containsEmoji(s: string): boolean {
	return /\p{Extended_Pictographic}/u.test(s);
}

let index: Map<string, Set<string>> | null = null;

function buildIndex(): Map<string, Set<string>> {
	const idx = new Map<string, Set<string>>();
	for (const [glyph, keywords] of Object.entries(data)) {
		for (const kw of keywords) {
			// Keywords come as "grinning_face" / ":D" — split on non-alphanumerics so
			// "grinning_face" indexes under both "grinning" and "face".
			for (const token of kw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
				let set = idx.get(token);
				if (!set) idx.set(token, (set = new Set()));
				set.add(glyph);
			}
		}
	}
	return idx;
}

/**
 * Emoji glyphs matching a free-text query. Returns [] for an empty query or no
 * match. Matches each query word against keyword tokens by prefix (so "heart"
 * hits "heart", "hearts", "heartbeat"); multi-word queries intersect.
 */
export function emojiForKeyword(query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	if (!index) index = buildIndex();

	const words = q.split(/[^a-z0-9]+/).filter(Boolean);
	if (words.length === 0) return [];

	let result: Set<string> | null = null;
	for (const word of words) {
		const matches = new Set<string>();
		for (const [token, glyphs] of index) {
			if (token.startsWith(word)) for (const g of glyphs) matches.add(g);
		}
		// Intersect across words so "red heart" narrows rather than widens.
		if (result === null) {
			result = matches;
		} else {
			const prev: Set<string> = result;
			result = new Set([...matches].filter((g) => prev.has(g)));
		}
		if (result.size === 0) break;
	}
	return result ? [...result] : [];
}
