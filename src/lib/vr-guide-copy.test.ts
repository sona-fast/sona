import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// VR export-guide copy pins (SONA-162), same disk-read shape as
// vr-admin-copy.test.ts: the guide's load-bearing claims came out of a
// verified end-to-end export, so a rewrite that drops the measured numbers,
// the cull-mode warning, or the can't-download-from-VRChat callout — or that
// re-introduces the debunked texture-shrinking advice — must fail here.
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

// The guide page component itself: the locale-identical measured sizes live
// there as constants (not catalogue entries), and its markup decides which
// messages go through the marker-rendering snippet.
const pageSource = readFileSync(
	fileURLToPath(new URL('../routes/admin/vr/guide/+page.svelte', import.meta.url)),
	'utf8'
);

describe('VR guide blendshape step', () => {
	it('the component keeps the measured before/after sizes', () => {
		expect(pageSource).toContain('147.85 MB');
		expect(pageSource).toContain('7.28 MB');
		expect(pageSource).toContain('~5 MB');
	});
});

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
			if (value.includes('`') || value.includes('**')) {
				expect(rendered.has(key), key).toBe(true);
			}
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

describe('VR guide cull-mode warning', () => {
	it('en tells the reader to match each material cull mode', () => {
		expect(messages('en').admin_vr_guide_step5_p2.toLowerCase()).toContain('cull');
	});
	it('ja warns about カリング', () => {
		expect(messages('ja').admin_vr_guide_step5_p2).toContain('カリング');
	});
});

describe('VR guide download callout', () => {
	it('states an uploaded VRChat avatar cannot be downloaded back', () => {
		expect(messages('en').admin_vr_guide_callout_no_download).toContain("can't download");
		expect(messages('ja').admin_vr_guide_callout_no_download).toContain('ダウンロードできません');
	});
});

describe('VR guide never re-introduces texture-shrinking advice', () => {
	// Same debunked-advice guard as admin_vr_error_too_large in
	// vr-admin-copy.test.ts, widened to every guide key.
	it('en guide keys stay free of it', () => {
		for (const [key, value] of guideEntries('en')) {
			expect(value, key).not.toContain('reducing texture sizes');
		}
	});
	it('ja guide keys stay free of it', () => {
		for (const [key, value] of guideEntries('ja')) {
			expect(value, key).not.toContain('テクスチャサイズを下げ');
		}
	});
});
