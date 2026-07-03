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
