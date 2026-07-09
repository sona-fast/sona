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

	it('note link keeps WCAG-AA contrast on the light admin theme', () => {
		expect(source('src/routes/admin/fursuit/+page.svelte')).toContain(
			":global([data-theme='light']) .unlocks a { color: #8A5A00; }"
		);
	});
});

// bug 1: Pages secrets bind at the NEXT DEPLOY, not on reload, so the
// observability setup dialog's post-`secret put` step must say redeploy (like
// the stickers/Resend modals), never "reload".
describe('observability dialog redeploy copy (bug 1)', () => {
	const en = messages('en');
	const ja = messages('ja');

	it('en step 3 says redeploy, never reload', () => {
		expect(en.admin_cf_setup_s3_title).toMatch(/redeploy/i);
		expect(en.admin_cf_setup_s3_title).not.toMatch(/reload/i);
		expect(en.admin_cf_setup_s3_text).not.toMatch(/reload/i);
	});

	it('ja step 3 says 再デプロイ, never 再読み込み', () => {
		expect(ja.admin_cf_setup_s3_title).toContain('再デプロイ');
		expect(ja.admin_cf_setup_s3_title).not.toContain('再読み込み');
		expect(ja.admin_cf_setup_s3_text).not.toContain('再読み込み');
	});
});

// bug 3: every dialog that instructs `wrangler pages secret put` must LEAD with
// the GitHub-Actions repo-secret path (deploy.yml re-puts repo secrets before
// each deploy, so the next deploy binds it automatically), keeping the wrangler
// command as a clearly-secondary escape hatch.
describe('setup dialogs lead with the GitHub Actions secret path (bug 3)', () => {
	const en = messages('en');
	const ja = messages('ja');

	it('en CI copy introduces the gh command (run from the fork, gh reads origin)', () => {
		// Lead sentence introduces the copyable command and explains why no
		// placeholder is needed (gh infers the repo from the origin remote).
		expect(en.admin_setup_secret_ci_pre).toMatch(/\bgh\b/);
		expect(en.admin_setup_secret_ci_pre).toContain('origin');
		expect(en.admin_cf_setup_s2_ci).toContain('origin');
	});

	it('en CI trailing copy keeps the auto-deploy reason and the web-UI fallback', () => {
		expect(en.admin_setup_secret_ci_post).toMatch(/deploy/i);
		expect(en.admin_setup_secret_ci_post).toContain('Secrets and variables');
		expect(en.admin_setup_secret_ci_post).toContain('Actions');
		expect(en.admin_cf_setup_s2_ci_post).toContain('Secrets and variables');
	});

	it('ja CI trailing copy keeps the GitHub UI path and mentions デプロイ', () => {
		expect(ja.admin_setup_secret_ci_post).toContain('Secrets and variables');
		expect(ja.admin_setup_secret_ci_post).toContain('デプロイ');
		expect(ja.admin_cf_setup_s2_ci_post).toContain('Secrets and variables');
	});

	// In every dialog: the CI lead precedes the escape-hatch marker, AND the
	// copyable `gh secret set` block is the FIRST code block — above the
	// `wrangler pages secret put` one.
	const DIALOGS = [
		{
			file: 'src/lib/components/CloudflareSetupDialog.svelte',
			ci: 'admin_cf_setup_s2_ci',
			escape: 'admin_cf_setup_s2_text',
			gh: 'gh secret set CLOUDFLARE_ANALYTICS_TOKEN'
		},
		{
			file: 'src/routes/admin/stickers/+page.svelte',
			ci: 'admin_setup_secret_ci_pre',
			escape: 'admin_stickers_setup_step2_a',
			gh: 'gh secret set TELEGRAM_BOT_TOKEN'
		},
		{
			file: 'src/routes/admin/settings/+page.svelte',
			ci: 'admin_setup_secret_ci_pre',
			escape: 'admin_resend_setup_s2_cli',
			gh: 'gh secret set RESEND_API_KEY'
		},
		{
			file: 'src/routes/admin/setup/+page.svelte',
			ci: 'admin_setup_secret_ci_pre',
			escape: 'admin_setup_blocked_set_pre',
			gh: 'gh secret set SETUP_TOKEN'
		}
	];

	for (const d of DIALOGS) {
		it(`${d.file} puts the gh command block before the wrangler one`, () => {
			const src = source(d.file);
			const ciAt = src.indexOf(d.ci);
			const escAt = src.indexOf(d.escape);
			expect(ciAt).toBeGreaterThanOrEqual(0);
			expect(escAt).toBeGreaterThan(ciAt);
			// gh secret set block exists and sits above the wrangler escape hatch
			const ghAt = src.indexOf(d.gh);
			const wranglerAt = src.indexOf('wrangler pages secret put');
			expect(ghAt).toBeGreaterThanOrEqual(0);
			expect(wranglerAt).toBeGreaterThan(ghAt);
		});
	}
});
