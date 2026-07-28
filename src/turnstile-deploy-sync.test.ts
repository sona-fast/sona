import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the deploy.yml step that binds the admin-login Turnstile keys onto the
// Pages project. Same bug class as the Cloudflare-analytics guard next door
// (src/lib/server/cf-analytics-scope.test.ts): the app reads a value from the
// Worker env, and nothing binds it there, so the feature is silently absent and
// looks exactly like a fork that opted out.
//
// The login action enforces the challenge only when BOTH keys are present. The
// wizard writes them straight to Pages, which covers new forks only; every
// already-deployed fork gets them through this step, from a repo variable and a
// repo secret. If the step regresses, four provisioned forks quietly lose the
// bot check with no failing test and no error anywhere.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
const deployWorkflow = read('../.github/workflows/deploy.yml');

// The step body, isolated so assertions can't be satisfied by an unrelated step.
const step = (() => {
	const start = deployWorkflow.indexOf('- name: Sync TURNSTILE keys to Pages project');
	const rest = deployWorkflow.slice(start);
	const end = rest.indexOf('\n      - uses:');
	return end === -1 ? rest : rest.slice(0, end);
})();

describe('deploy.yml — Turnstile keys are bound onto Pages', () => {
	it('has the sync step at all', () => {
		expect(step).not.toBe('');
		expect(step).toContain('Sync TURNSTILE keys to Pages project');
	});

	it('binds the SITEKEY as a plain Pages env var', () => {
		// Public value — it renders into the login page, so plain_text is correct.
		expect(step).toContain('TURNSTILE_SITEKEY: {type: "plain_text", value: $v}');
		expect(step).toContain('deployment_configs');
	});

	it('binds the SECRET as a Pages secret, never a plain var', () => {
		expect(step).toContain('wrangler pages secret put TURNSTILE_SECRET');
		// The secret must never ride in the plain_text env_vars payload — that would
		// publish the siteverify key into the Pages project's readable config.
		expect(step).not.toMatch(/TURNSTILE_SECRET:\s*\{\s*type:\s*"plain_text"/);
	});

	it('sources the sitekey from vars and the secret from secrets (not swapped)', () => {
		// Swapping these is the leak: a secret in `vars` is readable by anyone with
		// repo read access, and a sitekey in `secrets` merely breaks the widget.
		expect(step).toMatch(/TURNSTILE_SITEKEY:\s*\$\{\{\s*vars\.TURNSTILE_SITEKEY\s*\}\}/);
		expect(step).toMatch(/TURNSTILE_SECRET:\s*\$\{\{\s*secrets\.TURNSTILE_SECRET\s*\}\}/);
	});

	it('skips quietly when neither key is set (fork opted out)', () => {
		expect(step).toMatch(/if \[ -z "\$TURNSTILE_SITEKEY" \] && \[ -z "\$TURNSTILE_SECRET" \]/);
		expect(step).toContain('exit 0');
	});

	it('FAILS the deploy when exactly one key is set', () => {
		// Half a config disables the control silently — the one outcome that must not
		// ship quietly. Enforcement needs both keys, so one key = no bot check.
		expect(step).toMatch(/if \[ -z "\$TURNSTILE_SITEKEY" \] \|\| \[ -z "\$TURNSTILE_SECRET" \]/);
		expect(step).toContain('::error::Turnstile is half-configured');
		expect(step).toContain('exit 1');
	});

	it('runs before the Pages deploy, since Pages secrets bind at deploy time', () => {
		const syncAt = deployWorkflow.indexOf('Sync TURNSTILE keys to Pages project');
		const deployAt = deployWorkflow.indexOf('command: pages deploy');
		expect(syncAt).toBeGreaterThan(-1);
		expect(deployAt).toBeGreaterThan(syncAt);
	});

	it('keeps the token out of the run: block, passing it through env', () => {
		expect(step).toContain('Authorization: Bearer ${CLOUDFLARE_API_TOKEN}');
		expect(step).not.toContain('Bearer ${{ secrets.CLOUDFLARE_API_TOKEN }}');
	});
});
