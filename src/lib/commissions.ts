// Client-safe copies of the commission ledger's stored values (SONA-236). The
// canonical arrays live in $lib/server/db/schema.ts; a test pins these to them,
// so pages can use the values without importing the server schema.
export const COMMISSION_STATUSES = [
	'applied',
	'waitlisted',
	'not_picked',
	'accepted',
	'in_progress',
	'delivered',
	'cancelled'
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const COMMISSION_PAYMENTS = ['unpaid', 'deposit', 'paid', 'refunded'] as const;
export type CommissionPayment = (typeof COMMISSION_PAYMENTS)[number];

