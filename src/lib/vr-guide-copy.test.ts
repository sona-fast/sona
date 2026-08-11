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

describe('VR guide blendshape step', () => {
	it.each(['en', 'ja'])('%s keeps the measured before/after sizes', (locale) => {
		const all = guideEntries(locale)
			.map(([, value]) => value)
			.join('\n');
		expect(all).toContain('147.85');
		expect(all).toContain('7.28');
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
