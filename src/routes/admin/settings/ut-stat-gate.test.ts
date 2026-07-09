import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the UploadThing file-count stat gate against the page source (same
// spirit as lcp-image.test.ts / featured-markup.test.ts). +page.server.ts
// populates `utUsage` whenever UPLOADTHING_TOKEN exists REGARDLESS of provider,
// so the `storageProvider === 'uploadthing'` clause is the only thing hiding a
// stale UT file count on a site that has migrated UT -> R2 (the real sparky.ink
// situation). Drop that clause and the count reappears on R2, with no other test
// noticing — so it is pinned here.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('settings UploadThing file-count stat gate', () => {
	// The {#if ...} that immediately precedes the file-count value is its guard.
	const statIdx = pageSrc.indexOf('data.utUsage.filesUploaded');
	const guards = [...pageSrc.slice(0, statIdx).matchAll(/\{#if ([^}]*)\}/g)];
	const guard = guards.at(-1)?.[1];

	it('gates the count on utUsage AND the uploadthing provider (conjunction is load-bearing)', () => {
		expect(statIdx).toBeGreaterThan(-1);
		expect(guard).toBeDefined();
		const joined = guard!.replace(/\s+/g, ' ');

		// Both clauses must be present...
		expect(joined).toContain('data.utUsage');
		expect(joined).toContain("data.settings.storageProvider === 'uploadthing'");

		// ...and joined by `&&`. The conjunction is the load-bearing part: on a
		// migrated R2 site utUsage is still truthy, so a `||` or `??` join would
		// short-circuit true and show the stale UT file count again. Asserted by
		// operator rather than by a fixed clause order, so reordering the two
		// clauses — which changes nothing — does not fail this test.
		expect(joined).toContain('&&');
		expect(joined).not.toMatch(/\|\||\?\?/);
	});
});
