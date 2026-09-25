import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pin for a decision in +layout.svelte that no runtime assertion reaches
// (there is no component-test harness in this repo). It encodes a defect that
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
});
