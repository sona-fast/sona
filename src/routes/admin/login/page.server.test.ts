import { describe, it, expect } from 'vitest';
import { load } from './+page.server';

// The load only maps `?reset=1` (set by the /admin/reset redirect) to a flag the
// page shows a success banner for; an unauthenticated visit does no DB work.
function loadEvent(search: string) {
	return {
		locals: {},
		url: new URL(`https://taro.surf/admin/login${search}`)
	} as never;
}

describe('login load', () => {
	it('maps ?reset=1 to { resetSuccess: true }', async () => {
		expect(await load(loadEvent('?reset=1'))).toEqual({ resetSuccess: true });
	});

	it('is not a success without the reset flag', async () => {
		expect(await load(loadEvent(''))).toEqual({ resetSuccess: false });
	});
});
