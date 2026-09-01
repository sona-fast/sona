import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';
import { UNSCRUBBABLE_MESSAGE, UNSCRUBBABLE_STICKER_MESSAGE } from '$lib/server/storage/scrub-metadata';

// SONA-170: /api/upload answers 422 when a file's metadata could not be
// stripped, and the fix is the operator's (re-export the file). Both upload
// clients used to swallow that: the upload page showed "Upload failed (422)"
// and the VR form blamed the connection. Source scan, per the
// con-card-toggles.test.ts precedent — neither client is mountable in this
// vitest setup (one is a route page, the other drives file inputs and canvas).

const uploadPage = readFileSync(
	new URL('../../routes/admin/upload/+page.svelte', import.meta.url),
	'utf8'
);
const vrForm = readFileSync(new URL('./VrAvatarForm.svelte', import.meta.url), 'utf8');

describe('the 422 upload refusal reaches the screen', () => {
	it('the upload page shows the unscrubbable message for 422 and keeps the status one otherwise', () => {
		expect(uploadPage).toContain('uploadRes.status === 422');
		expect(uploadPage).toContain('m.admin_upload_error_unscrubbable()');
		expect(uploadPage).toContain('m.admin_upload_failed_status({ status: uploadRes.status })');
	});

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
		// The sticker import's page names the item it failed on, so it says so.
		expect(UNSCRUBBABLE_STICKER_MESSAGE).toMatch(/sticker/);
		expect(UNSCRUBBABLE_STICKER_MESSAGE).toMatch(/metadata/);
	});

	it('both messages tell the operator what to do about it', () => {
		for (const message of [m.admin_upload_error_unscrubbable(), m.admin_vr_media_error_unscrubbable()]) {
			expect(message).toMatch(/metadata/i);
			expect(message).toMatch(/export/i);
		}
	});
});
