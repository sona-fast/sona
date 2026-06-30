import { error } from '@sveltejs/kit';
import { constantTimeEqual } from './admin-auth';

type Env = App.Platform['env'];

/**
 * Authenticate a machine-to-machine cron request via `Authorization: Bearer
 * <CRON_SECRET>`. Throws 503 when no secret is configured (fail closed) and 401
 * on mismatch, using a constant-time comparison. Shared by the /api/cron/*
 * endpoints, which are exempt from the admin gate in hooks.
 */
export function requireCronSecret(request: Request, env: Env | undefined): void {
	const secret = env?.CRON_SECRET;
	if (!secret) error(503, 'Cron is not configured (no CRON_SECRET).');
	const auth = request.headers.get('authorization') ?? '';
	const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
	if (!constantTimeEqual(presented, secret)) error(401, 'Unauthorized');
}
