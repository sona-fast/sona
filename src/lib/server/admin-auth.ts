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

const PBKDF2_ITERATIONS = 210_000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256
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
 * A site is "set up" once it has an admin credential. We treat the presence of a
 * stored hash, an explicit setupComplete flag, OR a legacy ADMIN_PASSWORD env as
 * complete — so existing deployments are never forced back through the wizard.
 * On a DB read error we report NOT complete (fail toward the wizard, never toward
 * an open/unauthenticated admin).
 */
export async function isSetupComplete(db: Database, env: Env | undefined): Promise<boolean> {
	if (setupCompleteCache) return true;
	if (env?.ADMIN_PASSWORD) {
		setupCompleteCache = true;
		return true;
	}
	try {
		const rows = await db
			.select()
			.from(siteSettings)
			.where(inArray(siteSettings.key, ['setupComplete', 'adminPasswordHash']));
		const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		const done = map.setupComplete === 'true' || !!map.adminPasswordHash;
		if (done) setupCompleteCache = true;
		return done;
	} catch {
		return false;
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
