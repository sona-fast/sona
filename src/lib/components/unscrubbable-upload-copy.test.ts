import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';
import {
	UNSCRUBBABLE_MESSAGE,
	UNSCRUBBABLE_IMPORT_MESSAGE,
	UNSCRUBBABLE_MIGRATE_MESSAGE
} from '$lib/server/storage/scrub-metadata';

// SONA-170: /api/upload answers 422 when a file's metadata could not be
// stripped, and the fix is the operator's (re-export the file). Both upload
// clients used to swallow that: the upload page showed "Upload failed (422)"
// and the VR form blamed the connection. The upload page is covered end to end
// by tests/e2e/upload.spec.ts; the VR form is a source scan, per the
// con-card-toggles.test.ts precedent, because it drives file inputs and a
// canvas and is not mountable in this vitest setup.

const vrForm = readFileSync(new URL('./VrAvatarForm.svelte', import.meta.url), 'utf8');

describe('the 422 upload refusal reaches the screen', () => {
	it('the VR media picker maps 422 to its own reason and renders it', () => {
		expect(vrForm).toContain('res.status === 422');
		expect(vrForm).toContain("'unscrubbable'");
		expect(vrForm).toContain('m.admin_vr_media_error_unscrubbable()');
	});

	it('the server-side sentence is the same one the upload page shows', () => {
		// /api/upload's 422 body and the import rows use one exported constant, so
		// a wording change lands on every surface at once — an operator reading
		// the import result and one reading the upload tile see the same fix.
		expect(UNSCRUBBABLE_MESSAGE).toBe(m.admin_upload_error_unscrubbable());
		// An imported photo is not the operator's file to re-export, so that
		// import's sentence says what happened and stops there.
		expect(UNSCRUBBABLE_IMPORT_MESSAGE).not.toMatch(/upload/i);
		// The migration constant is shared with the sticker re-key, which
		// migrates nothing and re-stores media the operator never uploaded, so
		// its sentence may claim neither.
		expect(UNSCRUBBABLE_MIGRATE_MESSAGE).not.toMatch(/migrat/i);
		expect(UNSCRUBBABLE_MIGRATE_MESSAGE).not.toMatch(/upload/i);
	});
});
