// Admin credential + first-run setup logic.
//
// The admin password is stored as a PBKDF2 hash in site_settings
// (`adminPasswordHash`) — NOT in the client-exposed SiteSettings object, and not
// as a plaintext secret. Older deployments that still set the ADMIN_PASSWORD env
// secret keep working: login accepts it once and auto-migrates to the hash.
//
// `setupComplete` (site_settings) + the presence of a credential drive the
// first-run wizard gate in hooks.server.ts.

import { inArray } from 'drizzle-orm';
import { siteSettings } from './db/schema';
import { getRawSetting, setRawSetting } from './settings';
import type { Database } from './db';

// --- PBKDF2 (Web Crypto; available on Workers and Node 20+) -----------------

// Cloudflare Workers' Web Crypto caps PBKDF2 at 100k iterations and throws above
// it (NotSupportedError), so we can't use OWASP's 210k floor on that runtime — it
// fails every password hash in production. 100k is the max Workers allows (and the
// prior OWASP floor). Verify reads the iteration count from the stored hash, so
// this only affects newly-created hashes; existing hashes keep verifying.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toB64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function fromB64(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password) as BufferSource,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
		key,
		HASH_BYTES * 8
	);
	return new Uint8Array(bits);
}

/** Returns an encoded hash string: `pbkdf2$sha256$<iters>$<saltB64>$<hashB64>`. */
export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/**
 * Hash (SHA-256 hex) for admin session tokens stored at rest, so a leaked DB /
 * backup doesn't yield usable cookies. Tokens are high-entropy random UUIDs, so a
 * plain digest (not slow PBKDF2) is appropriate. The cookie holds the raw token;
 * the sessions table holds its hash.
 */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
	return r === 0;
}

/** Verify a password against an encoded hash produced by hashPassword(). */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
	const iterations = Number(parts[2]);
	if (!Number.isInteger(iterations) || iterations < 1) return false;
	let salt: Uint8Array, expected: Uint8Array;
	try {
		salt = fromB64(parts[3]);
		expected = fromB64(parts[4]);
	} catch {
		return false;
	}
	const actual = await pbkdf2(password, salt, iterations);
	return timingSafeEqual(actual, expected);
}

/** Constant-time string comparison (for tokens / legacy passwords). */
export function constantTimeEqual(a: string, b: string): boolean {
	const ae = new TextEncoder().encode(a);
	const be = new TextEncoder().encode(b);
	return timingSafeEqual(ae, be);
}

// Raw site_settings access (bypasses the client-facing SiteSettings) reuses the
// helpers in settings.ts — adminPasswordHash/setupComplete are never mapped into
// the SiteSettings object, so they never reach page data.

/** Store a new admin password (hashed). Used by the wizard and Settings. */
export async function setAdminPassword(db: Database, password: string): Promise<void> {
	await setRawSetting(db, 'adminPasswordHash', await hashPassword(password));
}

export async function markSetupComplete(db: Database): Promise<void> {
	await setRawSetting(db, 'setupComplete', 'true');
}

type Env = App.Platform['env'];

/**
 * Verify an admin login attempt.
 * - If a DB hash exists, that's authoritative.
 * - Else if the legacy ADMIN_PASSWORD env is set, accept a constant-time match
 *   and opportunistically migrate it to a stored hash.
 * - Otherwise no credential is configured → reject.
 */
export async function verifyAdminPassword(
	db: Database,
	env: Env | undefined,
	password: string
): Promise<boolean> {
	const hash = await getRawSetting(db, 'adminPasswordHash');
	if (hash) return verifyPasswordHash(password, hash);

	const legacy = env?.ADMIN_PASSWORD;
	if (legacy) {
		const ok = constantTimeEqual(password, legacy);
		if (ok) {
			// Auto-migrate: persist a hash so future logins don't depend on the env
			// secret (and so isSetupComplete sees a stored credential).
			try {
				await setAdminPassword(db, password);
			} catch {
				// Non-fatal: login still succeeds; migration retries next time.
			}
		}
		return ok;
	}
	return false;
}

// --- first-run setup state --------------------------------------------------

// Once an isolate observes a completed setup it caches that — setup completion is
// monotonic, so we never need to re-query after the first positive. Before setup
// (fresh install, no traffic) we query each request, which is fine.
let setupCompleteCache = false;

/**
 * Setup state, as three cases rather than two. The third one is the point: a
 * failed read is NOT evidence that no credential exists.
 *
 * - 'complete'   — a stored hash, an explicit setupComplete flag, or a legacy
 *                  ADMIN_PASSWORD env. Existing deployments are never forced
 *                  back through the wizard.
 * - 'incomplete' — the read SUCCEEDED and found neither. A genuinely unclaimed
 *                  fork.
 * - 'unknown'    — the read failed. We know nothing.
 */
export type SetupState = 'complete' | 'incomplete' | 'unknown';

/**
 * Read the setup state. Callers decide what to do with 'unknown' — see the gate
 * in hooks.server.ts.
 *
 * This used to return a boolean and collapse 'unknown' into false, which meant a
 * transient D1 error on a cold isolate was indistinguishable from "nobody has
 * claimed this site yet" — and the gate redirected every route on a live public
 * site to the setup wizard until one read succeeded (SONA-186, observed on a
 * fork 2026-08-13). The three-way answer exists so that mistake can't be
 * expressed here again.
 */
export async function getSetupState(db: Database, env: Env | undefined): Promise<SetupState> {
	if (setupCompleteCache) return 'complete';
	if (env?.ADMIN_PASSWORD) {
		setupCompleteCache = true;
		return 'complete';
	}
	try {
		const rows = await db
			.select()
			.from(siteSettings)
			.where(inArray(siteSettings.key, ['setupComplete', 'adminPasswordHash']));
		const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		const done = map.setupComplete === 'true' || !!map.adminPasswordHash;
		// Latch on the way out of a SUCCESSFUL read only. Setup completion is
		// monotonic, so a positive never needs re-querying; 'unknown' is never
		// cached, so the site recovers on the first read that works.
		if (done) setupCompleteCache = true;
		return done ? 'complete' : 'incomplete';
	} catch (e) {
		// The only trace this leaves. A degraded-but-serving site returns 200s, so
		// the error-rate rollup (which counts 5xx) and the metrics batch (which
		// writes to this same unreachable DB) both stay silent — Workers logs are
		// the one channel that survives a D1 outage.
		console.warn('setup-state read failed; serving public routes, gating /admin:', e);
		return 'unknown';
	}
}

/** Test-only: reset the per-isolate setup cache. */
export function __resetSetupCache(): void {
	setupCompleteCache = false;
}

// --- login throttle (best-effort, per-isolate) ------------------------------
//
// Cloudflare spreads requests across many isolates, so this only blunts rapid
// brute-force bursts that land on one isolate — it is NOT a hard global limit.
// A robust cross-isolate limiter (KV/Durable Object) is a future hardening step.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const attempts = new Map<string, { fails: number; resetAt: number }>();

/** @returns null if allowed, else seconds to wait before retrying. */
export function loginThrottleCheck(ip: string, now: number): number | null {
	const rec = attempts.get(ip);
	if (!rec) return null;
	if (now >= rec.resetAt) {
		attempts.delete(ip);
		return null;
	}
	if (rec.fails >= MAX_FAILURES) return Math.ceil((rec.resetAt - now) / 1000);
	return null;
}

export function loginThrottleFailure(ip: string, now: number): void {
	const rec = attempts.get(ip);
	if (!rec || now >= rec.resetAt) {
		attempts.set(ip, { fails: 1, resetAt: now + WINDOW_MS });
	} else {
		rec.fails += 1;
	}
}

export function loginThrottleReset(ip: string): void {
	attempts.delete(ip);
}
