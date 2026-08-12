import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards message-catalogue parity: every key must exist in BOTH locales. A key
// added to one locale but not the other (the classic i18n regression) fails here.
function keysOf(locale: string): string[] {
	const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	return Object.keys(json).filter((k) => k !== '$schema');
}

function rawOf(locale: string): string {
	const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	return readFileSync(path, 'utf8');
}

describe('message catalogue parity', () => {
	const en = keysOf('en');
	const ja = keysOf('ja');

	it('has the same keys in en and ja', () => {
		const enSet = new Set(en);
		const jaSet = new Set(ja);
		expect(en.filter((k) => !jaSet.has(k))).toEqual([]);
		expect(ja.filter((k) => !enSet.has(k))).toEqual([]);
	});
});

// Parameter parity: matching KEYS are not enough. If a translation pass drops a
// {placeholder} from a ja value, paraglide compiles a zero-parameter ja variant
// and the interpolated value silently disappears from the JA UI, with no build
// error and no failing key-parity check. The catalogue starts at zero
// mismatches, so this is enforced across every key rather than a watch-list.
//
// Covers plain strings AND paraglide variant/plural values, whose en side is an
// array of { declarations, selectors, match } objects while the ja side is
// usually a plain string. Both are flattened to their string leaves (the match
// values; selector/declaration metadata carries no user-facing text) and the
// UNION of each locale's placeholders is compared — the en 'one'/'other'
// variants use the same {count} the single ja string must keep.
describe('message parameter parity', () => {
	function leaves(value: unknown): string[] {
		if (typeof value === 'string') return [value];
		if (Array.isArray(value)) return value.flatMap(leaves);
		if (value && typeof value === 'object') {
			const match = (value as { match?: unknown }).match;
			return match && typeof match === 'object' ? Object.values(match).flatMap(leaves) : [];
		}
		return [];
	}
	const params = (value: unknown) =>
		[...new Set(leaves(value).flatMap((leaf) => leaf.match(/\{[^{}]+\}/g) ?? []))].sort();

	it('every key uses the same {placeholders} in en and ja', () => {
		const en = JSON.parse(rawOf('en')) as Record<string, unknown>;
		const ja = JSON.parse(rawOf('ja')) as Record<string, unknown>;
		for (const [key, enValue] of Object.entries(en)) {
			// Missing keys are the key-parity test's job, not this one's.
			if (key === '$schema' || !(key in ja)) continue;
			expect(params(ja[key]), key).toEqual(params(enValue));
		}
	});
});

// Terminology guard (sona#45): the JA UI always calls Telegram/chat sticker
// content ステッカー, never スタンプ. Every スタンプ occurrence in the catalogue was
// sticker-domain, so the whole file must stay free of it. If a non-sticker
// feature ever legitimately needs スタンプ, SCOPE this check to the sticker-domain
// key prefixes (stickers_, admin_stickers_, admin_pack_, admin_import_,
// nav_stickers, …) — do not delete it.
describe('ja terminology', () => {
	it('never uses スタンプ for sticker content', () => {
		// Parse (decodes any \uXXXX escapes) + NFKC (folds half-width kana) so the
		// guard catches スタンプ however it is encoded.
		const values = Object.values(JSON.parse(rawOf('ja')) as Record<string, string>)
			.join('\n')
			.normalize('NFKC');
		expect(values).not.toContain('スタンプ');
	});
});

// The Commissioned Date hint (#182) must exist in both locales (the parity
// check above covers that) AND actually render under the date input on both
// forms that set the field — a hint dropped from one form regresses silently
// otherwise.
describe('commissioned date hint wiring (#182)', () => {
	const pages = [
		'../routes/admin/upload/+page.svelte',
		'../routes/admin/images/[id]/edit/+page.svelte'
	];

	it('both locales carry the hint key', () => {
		for (const locale of ['en', 'ja']) {
			const json = JSON.parse(rawOf(locale)) as Record<string, string>;
			expect(json.admin_hint_commissioned_date, `${locale} hint`).toBeTruthy();
		}
	});

	it('upload and edit forms render the hint under the date field', () => {
		for (const rel of pages) {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
			expect(src, rel).toContain('m.admin_hint_commissioned_date()');
		}
	});
});

// The sticker download caption is assembled from three keys around an inline
// link; the "_before" part ends with a load-bearing trailing space. Formatters
// and translation tools silently trim trailing whitespace, which would render
// "from thepack page" — so guard it explicitly.
describe('sticker caption spacing', () => {
	it('en stickers_dl_caption_before keeps its trailing space', () => {
		const en = JSON.parse(rawOf('en')) as Record<string, string>;
		expect(en.stickers_dl_caption_before.endsWith(' ')).toBe(true);
	});
});
