/**
 * A realistically minted supporter-key expiry: midnight UTC `days` calendar days
 * out, which is what the issuer signs (end-of-day UTC) and what makes the
 * countdown read exactly `days`. Shared because a fractional-day offset instead
 * lands mid-day, and calendar-day counting then makes the expected number depend
 * on the hour the suite happens to run at (SONA-119).
 */
export function expInDays(days: number): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}
