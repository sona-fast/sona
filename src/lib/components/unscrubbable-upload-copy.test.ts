import { describe, it, expect } from 'vitest';
import * as m from '$lib/paraglide/messages';
import {
	UNSCRUBBABLE_MESSAGE,
	UNSCRUBBABLE_IMPORT_MESSAGE,
	UNSCRUBBABLE_MIGRATE_MESSAGE
} from '$lib/server/storage/scrub-metadata';

// SONA-170: /api/upload answers 422 when a file's metadata could not be
// stripped, and the fix is the operator's (re-export the file). All three
// upload clients (the upload page, the VR media picker and the sticker pack
// form) are driven end to end by tests/e2e/upload.spec.ts, which uploads a
// refused file through each and asserts the rendered message. What this file
// pins is the copy contract those flows share with the server.

describe('the 422 upload refusal copy', () => {
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
