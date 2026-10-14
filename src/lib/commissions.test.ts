import { describe, it, expect } from 'vitest';
import { commissions } from '$lib/server/db/schema';
import { COMMISSION_STATUSES, COMMISSION_PAYMENTS } from './commissions';

// The client copy must match what the database accepts: a status the page offers
// but the schema doesn't know would be refused on save, and one the schema adds
// but the page lacks would never be selectable.
describe('commission ledger client values', () => {
	it('match the schema enums', () => {
		expect([...COMMISSION_STATUSES]).toEqual(commissions.status.enumValues);
		expect([...COMMISSION_PAYMENTS]).toEqual(commissions.payment.enumValues);
	});
});
