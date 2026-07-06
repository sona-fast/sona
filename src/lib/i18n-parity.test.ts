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
