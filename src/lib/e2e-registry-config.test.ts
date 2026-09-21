import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { E2E_REGISTRY_URL, E2E_WRANGLER_CONFIG_REGISTRY } from '../../tests/e2e/paths';

// The registry-sync e2e server reads REGISTRY_URL from its wrangler config, and
// the fetch interceptor preloaded into that server reads the same host from
// SONA_E2E_REGISTRY_URL (playwright.config.ts passes E2E_REGISTRY_URL). Wrangler
// vars cannot reference the TypeScript constant, so the two are written twice;
// if they drift, the sync would send the throwaway key to whatever the config
// names, which for a dropped line is the real registry.
describe('the registry e2e config and the interceptor agree on the host', () => {
	const toml = readFileSync(E2E_WRANGLER_CONFIG_REGISTRY, 'utf8');

	it('names the same registry URL', () => {
		expect(toml).toMatch(new RegExp(`^REGISTRY_URL = "${E2E_REGISTRY_URL}"$`, 'm'));
	});

	it('turns the registry on with a throwaway key', () => {
		expect(toml).toMatch(/^REGISTRY_API_KEY = "e2e-[a-z-]+"$/m);
	});
});
