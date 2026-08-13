import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for decisions in +layout.svelte that no runtime assertion reaches
// (there is no component-test harness in this repo). Both encode a defect that
// review actually caught, so a revert fails here rather than in front of an
// operator.
const source = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

describe('admin layout — tz cookie (SONA-119)', () => {
	it('never invalidates loads while writing the cookie', () => {
		// invalidateAll() here swaps `data` mid-session, and the settings page
		// resyncs ~30 form fields whenever `data` changes — so it silently reverted
		// whatever the operator was typing, then saved the stale value. The zone is
		// allowed to land on the next navigation instead.
		//
		// Matched on the import rather than the name, so the comment explaining the
		// decision doesn't trip its own guard; the call needs the import.
		expect(source).not.toMatch(/import\s*\{[^}]*\binvalidateAll\b/);
	});

	it('writes the cookie from an effect, not a one-shot mount hook', () => {
		// This layout instance is reused across every admin navigation, so onMount
		// runs exactly once — on the sign-in page, the one place the write is
		// skipped. A mount-only write meant the cookie never appeared for the rest
		// of the session and every date silently stayed on UTC.
		expect(source).not.toMatch(/onMount\(/);
		expect(source).toMatch(/\$effect\(\(\) => \{[\s\S]*?document\.cookie = `tz=/);
	});

	it('scopes the cookie to the signed-in admin area', () => {
		// path=/admin keeps it off every public request; the exempt-route guard
		// keeps it off browsers that only ever reached the sign-in screen.
		expect(source).toMatch(/document\.cookie = `tz=\$\{encodeURIComponent\(zone\)\}; path=\/admin;/);
		expect(source).toMatch(/if \(isAdminAuthExempt\(\$page\.url\.pathname\)\) return;/);
	});
});
