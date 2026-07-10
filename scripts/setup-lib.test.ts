import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeHttpsUrl } from '../src/lib/server/validate';
import {
	buildMigrationSql,
	buildSeedSql,
	sanitizeProjectName,
	isR2NotEnabled,
	ensureUrlScheme,
	ghSecretEligibility,
	parseDatabaseId,
	deriveRepoSlug,
	buildPagesConfigPayload,
	tokenResolves,
	hostFromDomain,
	dnsProbeBlocksSetup,
	imageResizingOutcome,
	cfApi
} from './setup-lib.ts';

describe('buildMigrationSql', () => {
	it('creates schema_migrations and records each file after its body, in order', () => {
		const sql = buildMigrationSql([
			{ name: '0000_a.sql', sql: 'CREATE TABLE a (id integer);' },
			{ name: '0001_b.sql', sql: 'CREATE TABLE b (id integer);' }
		]);
		expect(sql).toContain(
			'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);'
		);
		// Each migration body is followed by its own INSERT with the basename key.
		const aBody = sql.indexOf('CREATE TABLE a');
		const aInsert = sql.indexOf("VALUES ('0000_a.sql'");
		const bBody = sql.indexOf('CREATE TABLE b');
		const bInsert = sql.indexOf("VALUES ('0001_b.sql'");
		expect(aBody).toBeGreaterThanOrEqual(0);
		expect(aBody).toBeLessThan(aInsert);
		expect(aInsert).toBeLessThan(bBody);
		expect(bBody).toBeLessThan(bInsert);
	});

	it('uses INSERT OR IGNORE keyed by basename so re-running is idempotent', () => {
		const sql = buildMigrationSql([{ name: '0000_a.sql', sql: 'SELECT 1;' }]);
		expect(sql).toContain(
			"INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('0000_a.sql', datetime('now'));"
		);
	});

	it('trims trailing whitespace from each body', () => {
		const sql = buildMigrationSql([{ name: '0000_a.sql', sql: 'SELECT 1;\n\n  ' }]);
		expect(sql).toContain('SELECT 1;\nINSERT OR IGNORE');
	});

	it('emits only the create when there are no migrations', () => {
		const sql = buildMigrationSql([]);
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
		expect(sql).not.toContain('INSERT OR IGNORE');
	});

	it('escapes single quotes in a basename', () => {
		const sql = buildMigrationSql([{ name: "0000_o'brien.sql", sql: 'SELECT 1;' }]);
		expect(sql).toContain("VALUES ('0000_o''brien.sql'");
	});
});

describe('buildSeedSql', () => {
	it('always seeds storageProvider', () => {
		expect(buildSeedSql({ provider: 'uploadthing' })).toBe(
			"INSERT OR REPLACE INTO site_settings (key,value) VALUES ('storageProvider','uploadthing');"
		);
	});

	it('seeds siteUrl from the domain answer alongside storageProvider', () => {
		const sql = buildSeedSql({ provider: 'r2', siteUrl: 'https://taro.surf' });
		expect(sql).toContain("('storageProvider','r2')");
		expect(sql).toContain("('siteUrl','https://taro.surf')");
	});

	it('omits siteUrl when blank (left unset → app falls back to request origin)', () => {
		const sql = buildSeedSql({ provider: 'r2', siteUrl: '' });
		expect(sql).not.toContain('siteUrl');
	});

	it('seeds all provided values in order (provider, siteUrl, r2PublicUrl, primaryCharacter)', () => {
		const sql = buildSeedSql({
			provider: 'r2',
			siteUrl: 'https://taro.surf',
			r2PublicUrl: 'https://cdn.taro.surf',
			primaryCharacter: 'taro'
		});
		expect(sql).toBe(
			"INSERT OR REPLACE INTO site_settings (key,value) VALUES " +
				"('storageProvider','r2'), ('siteUrl','https://taro.surf'), " +
				"('r2PublicUrl','https://cdn.taro.surf'), ('primaryCharacter','taro');"
		);
	});

	it('escapes single quotes in seeded values', () => {
		const sql = buildSeedSql({ provider: 'r2', primaryCharacter: "o'brien" });
		expect(sql).toContain("('primaryCharacter','o''brien')");
	});

	// The CLI seed computes siteUrl as normalizeHttpsUrl(ensureUrlScheme(domain)) ?? ''
	// (setup.ts). A malformed or non-https domain must normalize to null so the seed
	// drops siteUrl entirely — rather than storing a value new URL() throws on later.
	it('omits siteUrl when the domain answer does not normalize to a valid https URL', () => {
		const malformed = normalizeHttpsUrl(ensureUrlScheme('bad domain!!'));
		expect(malformed).toBeNull();
		expect(buildSeedSql({ provider: 'r2', siteUrl: malformed ?? '' })).not.toContain('siteUrl');

		// A good domain normalizes and is seeded.
		const good = normalizeHttpsUrl(ensureUrlScheme('taro.surf'));
		expect(good).toBe('https://taro.surf');
		expect(buildSeedSql({ provider: 'r2', siteUrl: good ?? '' })).toContain(
			"('siteUrl','https://taro.surf')"
		);
	});
});

describe('sanitizeProjectName', () => {
	it('lowercases and turns dots, underscores, and spaces into hyphens', () => {
		expect(sanitizeProjectName('Sparky.Ink')).toBe('sparky-ink');
		expect(sanitizeProjectName('My Cool_Fork')).toBe('my-cool-fork');
	});

	it('drops characters that are not alphanumeric or hyphen', () => {
		expect(sanitizeProjectName('café#site!')).toBe('cafsite');
	});

	it('collapses and trims hyphens', () => {
		expect(sanitizeProjectName('--a..b__c--')).toBe('a-b-c');
	});

	it('caps length at 58 chars without a trailing hyphen', () => {
		const out = sanitizeProjectName('a'.repeat(60) + '-tail');
		expect(out.length).toBeLessThanOrEqual(58);
		expect(out.endsWith('-')).toBe(false);
	});

	it('falls back to sona when nothing usable remains', () => {
		expect(sanitizeProjectName('...')).toBe('sona');
		expect(sanitizeProjectName('')).toBe('sona');
	});
});

describe('isR2NotEnabled', () => {
	it('detects the 10042 error code', () => {
		expect(isR2NotEnabled('Failed [code: 10042]: R2 not enabled')).toBe(true);
	});

	it('detects an "enable R2" prose message', () => {
		expect(isR2NotEnabled('You need to enable R2 for this account.')).toBe(true);
	});

	it('does not flag a benign already-exists failure', () => {
		expect(isR2NotEnabled('A bucket with that name already exists')).toBe(false);
	});

	it('does not flag empty/success output', () => {
		expect(isR2NotEnabled('')).toBe(false);
		expect(isR2NotEnabled('Created bucket sona-images')).toBe(false);
	});
});

describe('ensureUrlScheme', () => {
	it('prepends https:// to a bare host (the cdn.<domain> default)', () => {
		expect(ensureUrlScheme('cdn.taro.surf')).toBe('https://cdn.taro.surf');
	});

	it('leaves an already-schemed URL untouched', () => {
		expect(ensureUrlScheme('https://cdn.taro.surf')).toBe('https://cdn.taro.surf');
		expect(ensureUrlScheme('http://cdn.taro.surf')).toBe('http://cdn.taro.surf');
	});

	it('keeps empty/whitespace input empty (set later)', () => {
		expect(ensureUrlScheme('')).toBe('');
		expect(ensureUrlScheme('   ')).toBe('');
	});

	it('trims surrounding whitespace', () => {
		expect(ensureUrlScheme('  cdn.taro.surf  ')).toBe('https://cdn.taro.surf');
	});
});

describe('ghSecretEligibility', () => {
	const ok = {
		ghInstalled: true,
		ghAuthenticated: true,
		hasGithubOrigin: true,
		apiToken: 'tok',
		accountId: 'acct'
	};

	it('is eligible when everything is present', () => {
		expect(ghSecretEligibility(ok)).toEqual({ eligible: true });
	});

	it('skips (with a reason) when gh is not installed', () => {
		const r = ghSecretEligibility({ ...ok, ghInstalled: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/not installed/);
	});

	it('skips when gh is not authenticated', () => {
		const r = ghSecretEligibility({ ...ok, ghAuthenticated: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/authenticated/);
	});

	it('skips when there is no GitHub origin', () => {
		const r = ghSecretEligibility({ ...ok, hasGithubOrigin: false });
		expect(r.eligible).toBe(false);
		expect(r.reason).toMatch(/origin/);
	});

	it('skips when the CLOUDFLARE_* env values are absent (wrangler login)', () => {
		expect(ghSecretEligibility({ ...ok, apiToken: undefined }).eligible).toBe(false);
		expect(ghSecretEligibility({ ...ok, accountId: '' }).eligible).toBe(false);
	});
});

describe('parseDatabaseId', () => {
	const id = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

	it('matches the current wrangler JSONC output shape', () => {
		// Captured from `wrangler d1 create` on current wrangler.
		const out = `✅ Successfully created DB 'my-db'

{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-db",
      "database_id": "${id}"
    }
  ]
}`;
		expect(parseDatabaseId(out)).toBe(id);
	});

	it('matches the legacy wrangler TOML output shape', () => {
		const out = `✅ Successfully created DB 'my-db'

[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "${id}"`;
		expect(parseDatabaseId(out)).toBe(id);
	});

	it('returns empty string when no id is present', () => {
		expect(parseDatabaseId('some unrelated output')).toBe('');
		expect(parseDatabaseId('')).toBe('');
	});
});

describe('deriveRepoSlug', () => {
	it('derives owner/repo from an https remote (with and without .git)', () => {
		expect(deriveRepoSlug('https://github.com/sona-fast/sona.git')).toBe('sona-fast/sona');
		expect(deriveRepoSlug('https://github.com/sona-fast/sona')).toBe('sona-fast/sona');
	});

	it('derives owner/repo from an scp-style ssh remote', () => {
		expect(deriveRepoSlug('git@github.com:sona-fast/sona.git')).toBe('sona-fast/sona');
		expect(deriveRepoSlug('git@github.com:sona-fast/sona')).toBe('sona-fast/sona');
	});

	it('derives owner/repo from an ssh:// remote', () => {
		expect(deriveRepoSlug('ssh://git@github.com/sona-fast/sona.git')).toBe('sona-fast/sona');
	});

	it('tolerates a trailing slash and surrounding whitespace', () => {
		expect(deriveRepoSlug('  https://github.com/owner/repo/  ')).toBe('owner/repo');
	});

	it('returns null for a non-GitHub or empty remote', () => {
		expect(deriveRepoSlug('https://gitlab.com/owner/repo.git')).toBeNull();
		expect(deriveRepoSlug('')).toBeNull();
	});
});

describe('buildPagesConfigPayload', () => {
	it('wires bindings, vars, and the nodejs_compat flag onto production + preview', () => {
		const payload = buildPagesConfigPayload({
			dbBinding: 'DB',
			dbId: 'db-123',
			r2Binding: 'IMAGES',
			bucket: 'my-images',
			envVars: { FURTRACK_MODE: 'mock' }
		});
		expect(payload).toEqual({
			deployment_configs: {
				production: {
					compatibility_date: '2025-04-01',
					compatibility_flags: ['nodejs_compat'],
					d1_databases: { DB: { id: 'db-123' } },
					r2_buckets: { IMAGES: { name: 'my-images' } },
					env_vars: { FURTRACK_MODE: { type: 'plain_text', value: 'mock' } }
				},
				// nodejs_compat on preview too so PR-preview deploys don't fail the
				// same way; a CI-first `git push` deploy needs it on the project since
				// wrangler.toml (which also carries it) is gitignored.
				preview: {
					compatibility_date: '2025-04-01',
					compatibility_flags: ['nodejs_compat']
				}
			}
		});
	});

	it('omits the R2 binding when no bucket exists (R2 not enabled) but keeps nodejs_compat', () => {
		const payload = buildPagesConfigPayload({
			dbBinding: 'DB',
			dbId: 'db-123',
			r2Binding: 'IMAGES',
			bucket: '',
			envVars: {}
		});
		const production = (payload.deployment_configs as { production: Record<string, unknown> })
			.production;
		expect(production).not.toHaveProperty('r2_buckets');
		expect(production.d1_databases).toEqual({ DB: { id: 'db-123' } });
		expect(production.compatibility_flags).toEqual(['nodejs_compat']);
		const preview = (payload.deployment_configs as { preview: Record<string, unknown> }).preview;
		expect(preview.compatibility_flags).toEqual(['nodejs_compat']);
	});
});

describe('tokenResolves', () => {
	it('is true for an authenticated whoami banner', () => {
		expect(
			tokenResolves("👋 You are logged in with an API Token, associated with the email 'x@y.z'!")
		).toBe(true);
	});

	it('is false when whoami reports no authentication', () => {
		expect(tokenResolves('You are not authenticated. Please run `wrangler login`.')).toBe(false);
		expect(tokenResolves('Authentication error [code: 10000]')).toBe(false);
	});

	it('is false for an expired OAuth login whose refresh fails under non-TTY', () => {
		// wrangler 4.81.1 prints this when an expired OAuth token cannot refresh
		// under execSync (no TTY). The word "logged in" appears in "Not logged in",
		// so the old fallback matched it and passed preflight on dead credentials.
		expect(tokenResolves('Getting User settings...\n✘ [ERROR] Not logged in.\n')).toBe(false);
	});

	it('is true for a User API Token that lacks User Details·Read (the README recipe)', () => {
		// wrangler's REAL banner for a token without User → User Details → Read: it
		// authenticates (exit 0) but can't read the email. Must NOT be a failure —
		// the old "unable to retrieve" marker false-aborted setup in a dead loop.
		expect(
			tokenResolves(
				'👋 You are logged in with an User API Token. Unable to retrieve email for this user. Are you missing the `User->User Details->Read` permission?'
			)
		).toBe(true);
	});
});

describe('dnsProbeBlocksSetup', () => {
	it('blocks on a 401 or 403 (token cannot manage DNS)', () => {
		expect(dnsProbeBlocksSetup({ ok: false, status: 401 })).toBe(true);
		expect(dnsProbeBlocksSetup({ ok: false, status: 403 })).toBe(true);
	});

	it('does not block when the probe succeeded', () => {
		expect(dnsProbeBlocksSetup({ ok: true, status: 200 })).toBe(false);
	});

	it('does not block on a transient 5xx or a network error (status 0)', () => {
		expect(dnsProbeBlocksSetup({ ok: false, status: 500 })).toBe(false);
		expect(dnsProbeBlocksSetup({ ok: false, status: 0 })).toBe(false);
	});
});

describe('imageResizingOutcome', () => {
	it('is true when the setting is already on (no PATCH needed)', () => {
		expect(imageResizingOutcome({ ok: true, result: { value: 'on' } }, false)).toBe(true);
	});

	it('is true when it was off and the enabling PATCH succeeded', () => {
		expect(imageResizingOutcome({ ok: true, result: { value: 'off' } }, true)).toBe(true);
	});

	it('is false when it was off and the enabling PATCH failed', () => {
		expect(imageResizingOutcome({ ok: true, result: { value: 'off' } }, false)).toBe(false);
	});

	it('is null (unknown) when the GET failed (token lacks Zone Settings·Read)', () => {
		expect(imageResizingOutcome({ ok: false }, false)).toBeNull();
	});
});

describe('cfApi', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const jsonRes = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

	it('is ok for a 200 with success:true, surfacing the result', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, { success: true, result: [{ id: 'z1' }] })));
		const r = await cfApi('tok', '/zones');
		expect(r.ok).toBe(true);
		expect(r.status).toBe(200);
		expect(r.result).toEqual([{ id: 'z1' }]);
	});

	it('is NOT ok for a 200 with success:false, surfacing the errors', async () => {
		// The regression guard: a broken success guard would report this as ok and
		// print "✔ attached bindings" while the PATCH actually failed.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonRes(200, { success: false, errors: [{ code: 10000, message: 'nope' }] }))
		);
		const r = await cfApi('tok', '/accounts/a/pages/projects/p', { method: 'PATCH', body: {} });
		expect(r.ok).toBe(false);
		expect(r.errors).toEqual([{ code: 10000, message: 'nope' }]);
	});

	it('is NOT ok for a 403 error body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonRes(403, { success: false, errors: [{ code: 9109 }] }))
		);
		const r = await cfApi('tok', '/zones/z/dns_records');
		expect(r.ok).toBe(false);
		expect(r.status).toBe(403);
	});

	it('is {ok:false,status:0} when fetch throws (network error)', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
		const r = await cfApi('tok', '/zones');
		expect(r.ok).toBe(false);
		expect(r.status).toBe(0);
	});

	it('falls back to res.ok when the body is not JSON', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }))
		);
		const r = await cfApi('tok', '/zones');
		// No parseable success flag ⇒ classified purely by the HTTP status.
		expect(r.ok).toBe(false);
		expect(r.status).toBe(502);
	});
});

describe('hostFromDomain', () => {
	it('strips scheme and path, lowercasing the host', () => {
		expect(hostFromDomain('https://Taro.Surf/gallery')).toBe('taro.surf');
		expect(hostFromDomain('taro.surf')).toBe('taro.surf');
		expect(hostFromDomain('  cdn.taro.surf  ')).toBe('cdn.taro.surf');
	});
});
