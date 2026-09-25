import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// VR export-guide copy pins (SONA-162), read from the message files on disk:
// the step-4 size limit keeps its {max} placeholder, marker-carrying messages
// render through the rich() snippet, and en and ja agree on placeholders.
function messages(locale: string): Record<string, string> {
	const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, 'utf8'));
}

// Every admin_vr_guide_* catalogue entry (all plain strings).
function guideEntries(locale: string): [string, string][] {
	return Object.entries(messages(locale)).filter(
		([key, value]) => key.startsWith('admin_vr_guide_') && typeof value === 'string'
	);
}

// The guide page component itself: its markup decides which messages go
// through the marker-rendering snippet.
const pageSource = readFileSync(
	fileURLToPath(new URL('../routes/admin/vr/guide/+page.svelte', import.meta.url)),
	'utf8'
);

describe('VR guide size-limit interpolation', () => {
	// The step-4 limit is interpolated from MAX_VR_MODEL_BYTES at render time —
	// a locale string that loses its {max} placeholder would silently hardcode
	// (or drop) the cap.
	it.each(['en', 'ja'])('%s step4_p2 carries the {max} placeholder', (locale) => {
		expect(messages(locale).admin_vr_guide_step4_p2).toContain('{max}');
	});
});

describe('VR guide inline markers reach the rich renderer', () => {
	// Any message carrying `…` or **…** markers must be rendered through the
	// rich() snippet — plain {m.key()} would print the markers literally.
	const rendered = new Set(
		[...pageSource.matchAll(/@render rich\(m\.(\w+)\(\)\)/g)].map((match) => match[1])
	);
	it.each(['en', 'ja'])('%s marker-carrying keys are in the rich() set', (locale) => {
		for (const [key, value] of guideEntries(locale)) {
			if (value.includes('`') || value.includes('**') || /\[[^\]]+\]\(https:/.test(value)) {
				expect(rendered.has(key), key).toBe(true);
			}
		}
	});

	it('the UniVRM releases link survives in both locales', () => {
		for (const locale of ['en', 'ja']) {
			const value = Object.fromEntries(guideEntries(locale)).admin_vr_guide_before_univrm;
			expect(value).toContain('](https://github.com/vrm-c/UniVRM/releases)');
		}
	});
});

describe('VR guide placeholder parity', () => {
	// A {placeholder} present in one locale but not the other renders the raw
	// token (or drops the value) for that locale's readers.
	function tokens(value: string): string[] {
		return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
	}
	it('en and ja agree on every guide key', () => {
		const en = messages('en');
		const ja = messages('ja');
		for (const [key, value] of guideEntries('en')) {
			expect(tokens(ja[key] ?? ''), key).toEqual(tokens(value));
		}
	});
});
