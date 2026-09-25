import { describe, it, expect } from 'vitest';
import {
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
	it('keeps the import and migration sentences from claiming an upload or a migration', () => {
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
