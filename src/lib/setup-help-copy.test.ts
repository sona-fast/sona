import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// sona#35 copy nits: the config-gated warn banners describe features a fresh
// fork simply hasn't configured yet, so they read "not set up yet" (未設定)
// rather than the more alarming "disabled" / "turned off" (無効).
function messages(locale: string): Record<string, string> {
	const path = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
	return JSON.parse(readFileSync(path, 'utf8'));
}

function source(rel: string): string {
	return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
}

const UNCONFIGURED_BANNER_KEYS = [
	'admin_fursuit_disabled_pre',
	'admin_stickers_disabled_pre',
	'admin_import_disabled_pre'
];

describe('unconfigured-feature banner copy (sona#35)', () => {
	const en = messages('en');
	const ja = messages('ja');

	it('en reads "isn\'t set up yet", not "disabled"/"turned off"', () => {
		for (const key of UNCONFIGURED_BANNER_KEYS) {
			expect(en[key]).toContain("isn't set up yet");
			expect(en[key]).not.toMatch(/is disabled|turned off/);
		}
	});

	it('ja reads 未設定, not 無効', () => {
		for (const key of UNCONFIGURED_BANNER_KEYS) {
			expect(ja[key]).toContain('未設定');
			expect(ja[key]).not.toContain('無効');
		}
	});
});

describe('featured-character deep link (sona#35)', () => {
	it('FurTrack setup note links to the primary-character anchor Settings exposes', () => {
		expect(source('src/routes/admin/settings/+page.svelte')).toContain('id="primary-character"');
		expect(source('src/routes/admin/fursuit/+page.svelte')).toContain(
			'href="/admin/settings#primary-character"'
		);
	});
});
