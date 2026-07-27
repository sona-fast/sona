import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the bug class where the setup instructions name a Cloudflare permission
// that cannot run the query we actually send. getCloudflareEdge() queries
// `viewer { zones { httpRequests1dGroups } }` — a ZONE-scoped dataset, which needs
// `Zone · Analytics · Read`. The modal used to say `Account · Account Analytics ·
// Read`; that token authenticates fine and is then refused:
//
//   Actor '…' does not have permission 'com.cloudflare.api.account.zone.analytics.read'
//   for zone <zoneTag>
//
// Two bugs shipped together and hid each other. deploy.yml never bound the secrets
// into the Worker, so getCloudflareEdge() short-circuited to 'not-configured' and the
// panel simply never rendered — which is also what a fork that never opted in looks
// like. The query was therefore never sent, so Cloudflare's authz error (which the
// UI *does* surface, verbatim) never had a chance to appear. Fixing only the copy, or
// only the plumbing, would have left the panel dark with no diagnostic either way.
//
// These assertions fail if the query scope and the documented permission drift apart
// again, or if a secret the code reads stops being bound before the deploy.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

const source = read('./observability.ts');
const en = JSON.parse(read('../../../messages/en.json')) as Record<string, string>;
const ja = JSON.parse(read('../../../messages/ja.json')) as Record<string, string>;
const settingsPage = read('../../routes/admin/settings/+page.svelte');
const deployWorkflow = read('../../../.github/workflows/deploy.yml');

describe('Cloudflare edge analytics — documented scope matches the query', () => {
	it('the query is zone-scoped, which is what makes Zone · Analytics · Read the right permission', () => {
		expect(source).toMatch(/viewer\s*\{\s*zones\(/);
		expect(source).toContain('httpRequests1dGroups');
	});

	it.each([
		['en', en],
		['ja', ja]
	])('%s setup copy names the zone permission, never the account one', (_locale, messages) => {
		expect(messages.admin_cf_setup_s1_scope).toBe('Zone · Analytics · Read');
		expect(messages.admin_cf_setup_callout).toContain('Zone Analytics Read');

		// The account-scoped permission cannot satisfy a zone-scoped query. If this
		// string reappears anywhere in the setup flow, the instructions are wrong.
		for (const [key, value] of Object.entries(messages)) {
			if (key.startsWith('admin_cf_setup') || key.includes('obs_hint')) {
				expect(value).not.toMatch(/Account Analytics/i);
			}
		}
	});

	it('the settings hint hardcodes the same permission as the modal', () => {
		// This <code> block sits outside the i18n system, so it drifts silently.
		expect(settingsPage).toContain('<code>Zone Analytics: Read</code>');
		expect(settingsPage).not.toMatch(/Account Analytics/i);
	});
});

describe('Cloudflare edge analytics — deploy binds every secret the code reads', () => {
	// getCloudflareEdge() returns 'not-configured' unless ALL THREE are present in the
	// Worker env. CLOUDFLARE_ACCOUNT_ID being a repo secret is not enough: repo secrets
	// authenticate the deploy, they are not bound into the running Worker.
	const required = ['CLOUDFLARE_ANALYTICS_TOKEN', 'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_ACCOUNT_ID'];

	it.each(required)('%s is read by getCloudflareEdge and put as a Pages secret', (name) => {
		expect(source).toContain(`env?.${name}`);
		expect(deployWorkflow).toContain(`npx wrangler pages secret put ${name}`);
	});

	it('the secrets are put before the deploy step, because Pages secrets bind at deploy time', () => {
		const lastPut = Math.max(
			...required.map((n) => deployWorkflow.indexOf(`npx wrangler pages secret put ${n}`))
		);
		// Match the action prefix, not a specific ref — the action is SHA-pinned (M2).
		const deployStep = deployWorkflow.indexOf('cloudflare/wrangler-action@');
		expect(lastPut).toBeGreaterThan(-1);
		expect(lastPut).toBeLessThan(deployStep);
	});
});
