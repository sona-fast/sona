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

	it('renders the UT file count only, and never without the provider clause', () => {
		expect(statIdx).toBeGreaterThan(-1);
		expect(guard).toBeDefined();
		// Gated on BOTH utUsage presence AND the provider being uploadthing.
		expect(guard).toContain('data.utUsage');
		expect(guard).toContain("data.settings.storageProvider === 'uploadthing'");
	});

	it('hides the count on R2 even when utUsage is non-null (utUsage alone must not gate it)', () => {
		// A bare `{#if data.utUsage}` would show the stale count on a migrated R2
		// site — the provider clause is what prevents that.
		expect(guard).not.toBe('data.utUsage');
		expect(guard).toMatch(/storageProvider === 'uploadthing'/);
	});
});
