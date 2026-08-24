import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeHttpsUrl } from '../src/lib/server/validate';
import { readFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
	buildMigrationSql,
	buildSeedSql,
	sanitizeProjectName,
	isValidResourceName,
	isValidDatabaseName,
	isValidBucketName,
	derivedResourceName,
	askResourceName,
	writePrivateTempSql,
	removeTempSqlDir,
	runWith,
	isValidDatabaseId,
	askUntilValid,
	isR2NotEnabled,
	bucketCreateSucceeded,
	ensureUrlScheme,
	ghSecretEligibility,
	parseDatabaseId,
	deriveRepoSlug,
	buildPagesConfigPayload,
	tokenResolves,
	hostFromDomain,
	zoneNameCandidates,
	dnsProbeBlocksSetup,
	imageResizingOutcome,
	imageResizingIsOn,
	ciWiringEntries,
	cfApi,
	cfErrorSummary,
	securitySummaryLines,
	zoneLookupWarnLines,
	storageSummaryLines,
	telegramSummaryLine,
	resendSecretWarnLines,
	setupTokenLines,
	provisioningNoteLine,
	pagesPatchConfirmsSitekey,
	cdnAttachmentLines,
	type CfApiResult,
	type SecuritySummaryInput
} from './setup-lib.ts';
import { applyDownloadRateLimit, SCOPE_HINT as WAF_SCOPE_HINT } from './waf-lib.ts';
import { provisionTurnstileWidget, SCOPE_HINT as TURNSTILE_SCOPE_HINT } from './turnstile-lib.ts';

// setup.ts self-executes, so the contracts below read its source instead of
// importing it. One copy, shared by every `setup.ts ↔` describe in this file.
const setupSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.ts'), 'utf8');

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

	// The seed is SQL-escaped, never shell-escaped, so it is handed to wrangler in a
	// file (setup.ts) rather than on a command line. The characters a shell would
	// have eaten must survive into the SQL byte for byte — `$x` expanded to nothing,
	// the backticks ran a subshell, and the double quote ended the argument early,
	// all while the execute still exited 0.
	it('keeps shell metacharacters in a value intact', () => {
		const character = 'taro $x `id` "quoted" \\slash';
		const sql = buildSeedSql({ provider: 'r2', primaryCharacter: character });
		expect(sql).toContain(`('primaryCharacter','${character}')`);
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

describe('isValidResourceName', () => {
	it('accepts the names sanitizeProjectName produces', () => {
		for (const raw of ['Sparky.Ink', 'My Cool_Fork', 'café#site!', '--a..b__c--', '']) {
			expect(isValidResourceName(sanitizeProjectName(raw)), raw).toBe(true);
		}
		expect(isValidResourceName('taro-surf-images')).toBe(true);
		expect(isValidResourceName('sona2')).toBe(true);
	});

	// These are the answers that reached wrangler through a shell string: `my$site`
	// arrived as `my`, and a quoted or spaced name split into several arguments —
	// while wrangler.toml recorded the raw answer, so the bucket and the IMAGES
	// binding named different things and setup still printed success.
	it('rejects an answer carrying anything a shell would act on', () => {
		for (const bad of [
			'my$bucket',
			'my`id`bucket',
			'my"bucket"',
			"my'bucket'",
			'my bucket',
			'my;bucket',
			'my\\bucket',
			'my/bucket',
			'../escape'
		]) {
			expect(isValidResourceName(bad), bad).toBe(false);
		}
	});

	// The prompt trims, but the validator is the thing being trusted: a caller that
	// skipped the trim must not get a name with a newline glued to it past `$`.
	it('rejects an answer with a trailing newline', () => {
		expect(isValidResourceName('taro-surf\n')).toBe(false);
		expect(isValidDatabaseName('sona_db\n')).toBe(false);
		expect(isValidDatabaseId('3f8b0c62-1d4e\n')).toBe(false);
	});

	it('rejects empty, uppercase, and edge-hyphenated names, and anything over 58 chars', () => {
		expect(isValidResourceName('')).toBe(false);
		expect(isValidResourceName('MyBucket')).toBe(false);
		expect(isValidResourceName('-lead')).toBe(false);
		expect(isValidResourceName('trail-')).toBe(false);
		expect(isValidResourceName('a'.repeat(58))).toBe(true);
		expect(isValidResourceName('a'.repeat(59))).toBe(false);
	});
});

describe('derivedResourceName', () => {
	it('appends the suffix to an ordinary project name', () => {
		expect(derivedResourceName('taro-surf', 'db')).toBe('taro-surf-db');
		expect(derivedResourceName('taro-surf', 'images')).toBe('taro-surf-images');
	});

	// A 58-char project name is legal, but `<it>-images` is not — so setup would
	// have offered a default it then rejected, fatal on a run with no TTY.
	it('truncates so a derived default always passes the validator', () => {
		const long = 'a'.repeat(58);
		expect(isValidResourceName(long)).toBe(true);
		for (const suffix of ['db', 'images']) {
			const derived = derivedResourceName(long, suffix);
			expect(isValidResourceName(derived), derived).toBe(true);
			expect(derived.endsWith(`-${suffix}`), derived).toBe(true);
		}
	});

	// The docstring promises a valid name for any suffix, not just the two setup
	// passes, so the return is clamped as well as the stem.
	it('stays valid even when the suffix alone is over-long', () => {
		const derived = derivedResourceName('taro-surf', 'x'.repeat(80));
		expect(derived.length).toBeLessThanOrEqual(58);
		expect(isValidResourceName(derived), derived).toBe(true);
	});

	it('does not leave a doubled hyphen where it cut', () => {
		const project = `${'a'.repeat(50)}-${'b'.repeat(7)}`;
		expect(derivedResourceName(project, 'images')).toBe(`${'a'.repeat(50)}-images`);
	});
});

describe('askResourceName', () => {
	it('re-asks until the answer is usable, and returns that answer', async () => {
		const answers = ['my$bucket', 'my bucket', 'taro-surf-images'];
		const rejected: string[] = [];
		let asks = 0;
		const got = await askResourceName('R2 bucket name', 'taro-surf-images', {
			ask: async () => {
				asks++;
				return answers.shift()!;
			},
			isInteractive: true,
			onReject: (a) => rejected.push(a)
		});
		expect(got).toBe('taro-surf-images');
		expect(asks).toBe(3);
		expect(rejected).toEqual(['my$bucket', 'my bucket']);
	});

	// Without a TTY there is no second answer to give, so re-asking would spin
	// forever on the same piped line.
	it('gives up after exactly one ask when the run is not interactive', async () => {
		let asks = 0;
		const got = await askResourceName('R2 bucket name', 'taro-surf-images', {
			ask: async () => {
				asks++;
				return 'my$bucket';
			},
			isInteractive: false
		});
		expect(got).toBeNull();
		expect(asks).toBe(1);
	});

	it('takes a good first answer without rejecting anything', async () => {
		const rejected: string[] = [];
		const got = await askResourceName('D1 database name', 'taro-surf-db', {
			ask: async (_q, def) => def,
			isInteractive: false,
			onReject: (a) => rejected.push(a)
		});
		expect(got).toBe('taro-surf-db');
		expect(rejected).toEqual([]);
	});
});

describe('runWith', () => {
	// The two runners in setup.ts differ only in how they spawn; everything that
	// decides what a caller SEES lives here, and dropping the opts argument on
	// either delegation silently disables all three of these.
	const spawnOk = (out: string) => {
		const seen: unknown[] = [];
		return {
			seen,
			spawn: (stdio: unknown) => {
				seen.push(stdio);
				return out;
			}
		};
	};

	it('hands back what the command printed when capturing', () => {
		const { spawn, seen } = spawnOk('database_id = "abc"');
		expect(runWith(spawn, { capture: true })).toBe('database_id = "abc"');
		// Capturing means piped stdio — inherited output would leave the caller
		// nothing to parse, which is how the dbId auto-detect breaks.
		expect(seen).toEqual(['pipe']);
	});

	it('returns an empty string when the command printed nothing', () => {
		expect(runWith(() => null, {})).toBe('');
	});

	it('inherits stdio by default, and ignores stdin when asked', () => {
		const a = spawnOk('');
		runWith(a.spawn, {});
		expect(a.seen).toEqual([['inherit', 'inherit', 'inherit']]);

		const b = spawnOk('');
		runWith(b.spawn, { stdin: 'ignore' });
		// wrangler's "Ok to proceed?" never fires without a stdin to read from.
		expect(b.seen).toEqual([['ignore', 'inherit', 'inherit']]);
	});

	it('on a tolerated failure returns the output and reports it once', () => {
		let failures = 0;
		const out = runWith(
			() => {
				throw Object.assign(new Error('exit 1'), { stdout: 'partial ', stderr: 'code: 10042' });
			},
			{ allowFail: true, onFail: () => failures++ }
		);
		// Both streams, in order: isR2NotEnabled sniffs this text for the 10042 code.
		expect(out).toBe('partial code: 10042');
		// Once, not twice: r2CreateOk is flipped here, and the summary reports what
		// actually landed from it.
		expect(failures).toBe(1);
	});

	it('tolerates a failure that printed nothing at all', () => {
		let failures = 0;
		expect(runWith(() => {
			throw new Error('spawn failed');
		}, { allowFail: true, onFail: () => failures++ })).toBe('');
		expect(failures).toBe(1);
	});

	it('rethrows when the failure is not tolerated', () => {
		let failures = 0;
		expect(() =>
			runWith(
				() => {
					throw new Error('exit 1');
				},
				{ onFail: () => failures++ }
			)
		).toThrow('exit 1');
		// onFail records a TOLERATED failure; an aborting one is not that.
		expect(failures).toBe(0);
	});
});

describe('isValidDatabaseId', () => {
	it('accepts what parseDatabaseId itself extracts', () => {
		const parsed = parseDatabaseId('database_id = "3f8b0c62-1d4e-4a90-8f1b-9c2d0e5a7b31"');
		expect(parsed).not.toBeNull();
		expect(isValidDatabaseId(parsed!)).toBe(true);
	});

	// The pasted id is written into wrangler.toml verbatim, so an answer that can
	// close the string and open a new key would inject arbitrary config.
	it('rejects anything that could rewrite the generated TOML', () => {
		for (const bad of [
			'',
			'short',
			'abc"\ndatabase_name = "other"',
			'3f8b0c62 1d4e',
			'not-hex-zzzzzzzz',
			'$(id)',
			'--------'
		]) {
			expect(isValidDatabaseId(bad), bad).toBe(false);
		}
	});
});

describe('askUntilValid', () => {
	// askResourceName is one binding of this loop; the pasted database_id is the
	// other, and it accepts a blank answer as "I don't have one".
	it('re-asks on a rejected answer and returns the first accepted one', async () => {
		const answers = ['nope!', '3f8b0c62-1d4e-4a90-8f1b-9c2d0e5a7b31'];
		const rejected: string[] = [];
		const got = await askUntilValid('database_id', '', (a) => a === '' || isValidDatabaseId(a), {
			ask: async () => answers.shift()!,
			isInteractive: true,
			onReject: (a) => rejected.push(a)
		});
		expect(got).toBe('3f8b0c62-1d4e-4a90-8f1b-9c2d0e5a7b31');
		expect(rejected).toEqual(['nope!']);
	});

	// Blank is how an operator says "wrangler printed no id and I don't have one";
	// the predicate lets it through so the existing no-id abort is what stops setup.
	it('accepts a blank answer for the pasted database_id, without rejecting it', async () => {
		const rejected: string[] = [];
		let asks = 0;
		const got = await askUntilValid('database_id', '', (a) => a === '' || isValidDatabaseId(a), {
			ask: async () => {
				asks++;
				return '';
			},
			isInteractive: true,
			onReject: (a) => rejected.push(a)
		});
		expect(got).toBe('');
		expect(asks).toBe(1);
		expect(rejected).toEqual([]);
	});

	it('gives up after exactly one ask when the run is not interactive', async () => {
		let asks = 0;
		const got = await askUntilValid('database_id', '', isValidDatabaseId, {
			ask: async () => {
				asks++;
				return 'nope!';
			},
			isInteractive: false
		});
		expect(got).toBeNull();
		expect(asks).toBe(1);
	});
});

describe('removeTempSqlDir', () => {
	it('removes the directory and the SQL inside it', () => {
		const { dir, path } = writePrivateTempSql('SELECT 1;', 'sona-test-');
		removeTempSqlDir(dir);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	// The SQL has already run by the time this is called; a directory someone else
	// removed first is not a reason to fail the command that succeeded.
	it('does not throw when the directory is already gone', () => {
		const { dir } = writePrivateTempSql('SELECT 1;', 'sona-test-');
		removeTempSqlDir(dir);
		expect(() => removeTempSqlDir(dir)).not.toThrow();
	});
});

describe('writePrivateTempSql', () => {
	// The seed and the migration script both carry operator data, and the reset
	// file carries a password hash: none of them may sit world-readable in /tmp.
	it('writes the SQL into a 0700 dir as a 0600 file', () => {
		const sql = "INSERT OR REPLACE INTO site_settings (key,value) VALUES ('adminPasswordHash','x');\n";
		const { dir, path } = writePrivateTempSql(sql, 'sona-test-');

		try {
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, 'utf8')).toBe(sql);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The caller learns the directory exists only by getting it back, so a failed
	// write must not leave one behind for nobody to clean up.
	it('leaves no directory behind when the write fails', () => {
		const dirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('sona-atomic-'));
		const before = dirs();
		// A real write failure, no mocking: node refuses to write a plain object, and
		// it refuses it at the same call the caller's ENOSPC or EACCES would hit.
		expect(() => writePrivateTempSql({} as unknown as string, 'sona-atomic-')).toThrow();
		// Compared against what was already there, so a stray directory from another
		// run can't decide this test either way.
		expect(dirs()).toEqual(before);
	});

	it('gives each call its own directory', () => {
		const a = writePrivateTempSql('SELECT 1;', 'sona-test-');
		const b = writePrivateTempSql('SELECT 2;', 'sona-test-');
		try {
			expect(a.dir).not.toBe(b.dir);
			expect(readFileSync(a.path, 'utf8')).toBe('SELECT 1;');
		} finally {
			rmSync(a.dir, { recursive: true, force: true });
			rmSync(b.dir, { recursive: true, force: true });
		}
	});
});

describe('isValidBucketName', () => {
	// R2's bounds are 3 to 63, not Pages' 1 to 58. The old shared rule let a
	// two-character answer through to fail at create, and refused a long name that
	// an earlier run had already created.
	it('accepts the range R2 actually allows, at both ends', () => {
		expect(isValidBucketName('a'.repeat(3))).toBe(true);
		expect(isValidBucketName('a'.repeat(63))).toBe(true);
		expect(isValidBucketName(`${'taro-surf-'.repeat(5)}images`)).toBe(true);
		expect(isValidBucketName('taro-surf-images')).toBe(true);
	});

	it('accepts the default setup derives, so the offered answer is always usable', () => {
		expect(isValidBucketName(derivedResourceName('a'.repeat(58), 'images'))).toBe(true);
	});

	it('rejects a name shorter or longer than R2 takes', () => {
		expect(isValidBucketName('ab')).toBe(false);
		expect(isValidBucketName('a'.repeat(64))).toBe(false);
	});

	it('keeps the Pages character set: no uppercase, edge hyphens, or punctuation', () => {
		for (const bad of ['MyBucket', '-lead-ok', 'trail-', 'my$bucket', 'my bucket', 'my_bucket']) {
			expect(isValidBucketName(bad), bad).toBe(false);
		}
	});
});

describe('isValidDatabaseName', () => {
	// D1 is looser than Pages/R2 on purpose: `wrangler d1 create` is allowed to
	// fail, and the paste-the-id prompt exists so a re-run can point at a database
	// that already exists — quite possibly one named in a style Pages would reject.
	it('accepts the styles an existing D1 database may already use', () => {
		expect(isValidDatabaseName('sona_db')).toBe(true);
		expect(isValidDatabaseName('Sona-DB')).toBe(true);
		expect(isValidDatabaseName('taro-surf-db')).toBe(true);
		expect(isValidDatabaseName('db2')).toBe(true);
	});

	it('accepts the default setup derives, so the offered answer is always usable', () => {
		expect(isValidDatabaseName(derivedResourceName('a'.repeat(58), 'db'))).toBe(true);
	});

	it('rejects a leading hyphen, which wrangler would read as a flag', () => {
		expect(isValidDatabaseName('-leading')).toBe(false);
	});

	it('rejects anything a shell or an argv parser would treat as more than a name', () => {
		for (const bad of ['my$db', 'my db', 'my"db', "my'db", 'my;db', 'my/db', '', 'a'.repeat(65)]) {
			expect(isValidDatabaseName(bad), bad).toBe(false);
		}
		expect(isValidDatabaseName('a'.repeat(64))).toBe(true);
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

describe('bucketCreateSucceeded', () => {
	it('is true for a clean create', () => {
		expect(bucketCreateSucceeded('Created bucket sona-images', true)).toBe(true);
	});

	// The re-run case: wrangler exits non-zero, but the bucket is there, so setup
	// must not report the R2 backend as broken.
	it('treats an already-exists failure as the bucket being in place', () => {
		expect(bucketCreateSucceeded('A bucket with that name already exists', false)).toBe(true);
		expect(bucketCreateSucceeded('Failed [code: 10004]', false)).toBe(true);
	});

	// The failure that prompted this: a token without Account → Workers R2
	// Storage: Edit carries none of isR2NotEnabled's markers, so sniffing the text
	// read it as success and setup bound a bucket that does not exist.
	it('is false for a permission failure and for R2 not being enabled', () => {
		expect(bucketCreateSucceeded('Authentication error [code: 10000]', false)).toBe(false);
		expect(bucketCreateSucceeded('Failed [code: 10042]: R2 not enabled', false)).toBe(false);
		expect(bucketCreateSucceeded('', false)).toBe(false);
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

	it('matches the current wrangler JSONC output shape (verbatim transcript)', () => {
		// Verbatim `wrangler d1 create` transcript: the ✅ preamble carries a region
		// suffix and the JSONC block advises pasting into wrangler.toml. Kept literal
		// so a future wrangler formatting tweak that breaks the parse shows up here.
		const out = `🌀 Creating DB 'my-db'
✅ Successfully created DB 'my-db' in region ENAM
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "${id}"

Configure this D1 database in your Worker's wrangler.toml as a binding:

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

	it('does not mis-grab a preview_database_id key (boundary guard)', () => {
		// A future wrangler line pairing preview_database_id BEFORE database_id must
		// not shadow the real id: the `_` boundary guard skips the preview key.
		const previewId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const out = `[[d1_databases]]
binding = "DB"
preview_database_id = "${previewId}"
database_id = "${id}"`;
		expect(parseDatabaseId(out)).toBe(id);
		// And a block with ONLY a preview key yields nothing (no false positive).
		expect(parseDatabaseId(`preview_database_id = "${previewId}"`)).toBe('');
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

	it('returns null for lookalike hosts (anchored github.com match)', () => {
		// The host must be exactly github.com, sitting right after a scheme `//`,
		// an ssh @, or the string start — not a substring of another hostname.
		expect(deriveRepoSlug('https://evilgithub.com/owner/repo.git')).toBeNull();
		expect(deriveRepoSlug('https://github.com.evil.com/owner/repo')).toBeNull();
		expect(deriveRepoSlug('git@notgithub.com:owner/repo.git')).toBeNull();
	});

	it('returns null when github.com is only in the PATH of another host', () => {
		// A single path slash must NOT satisfy the anchor, or a hostile origin
		// (github.com as a path segment) would mis-target the derived gh command.
		expect(deriveRepoSlug('https://evil.com/github.com/a/b')).toBeNull();
	});

	it('returns null when github.com is smuggled into a path via // or @', () => {
		// The host is anchored at the URL authority, so github.com appearing later
		// in the path — even right after a `//` or an `@` — is not the host and
		// must not derive an attacker-controlled slug.
		expect(deriveRepoSlug('https://mirror.example.com/x@github.com/attacker/sona')).toBeNull();
		expect(deriveRepoSlug('https://evil.com//github.com/attacker/sona')).toBeNull();
		expect(deriveRepoSlug('git@evil.com/x@github.com:attacker/sona')).toBeNull();
	});
});

describe('buildPagesConfigPayload', () => {
	it('wires bindings, vars, and the nodejs_compat flag onto production + preview', () => {
		const payload = buildPagesConfigPayload({
			dbId: 'db-123',
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
			dbId: 'db-123',
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

describe('zoneNameCandidates', () => {
	it('yields a subdomain then its registrable parent, most specific first', () => {
		expect(zoneNameCandidates('sona.example.com')).toEqual(['sona.example.com', 'example.com']);
		expect(zoneNameCandidates('a.b.example.com')).toEqual([
			'a.b.example.com',
			'b.example.com',
			'example.com'
		]);
	});

	it('yields just the host when it is already two labels', () => {
		expect(zoneNameCandidates('example.com')).toEqual(['example.com']);
	});

	it('stops at two labels (never queries a bare TLD)', () => {
		expect(zoneNameCandidates('sona.example.com')).not.toContain('com');
	});

	it('handles a single label and empty input', () => {
		expect(zoneNameCandidates('localhost')).toEqual(['localhost']);
		expect(zoneNameCandidates('')).toEqual([]);
	});
});

describe('imageResizingIsOn', () => {
	it('is true only when the zone setting value is "on"', () => {
		expect(imageResizingIsOn({ result: { value: 'on' } })).toBe(true);
		expect(imageResizingIsOn({ result: { value: 'off' } })).toBe(false);
		expect(imageResizingIsOn({ result: undefined })).toBe(false);
		expect(imageResizingIsOn({})).toBe(false);
	});
});

describe('ciWiringEntries', () => {
	const input = {
		apiToken: 'tok',
		accountId: 'acct',
		cronSecret: 'cron',
		setupToken: 'setup',
		project: 'my-proj',
		dbName: 'my-db',
		siteUrl: 'https://my.site',
		furtrackMode: 'off'
	};

	it('ALWAYS includes FURTRACK_MODE as a variable, even when off (stale-value guard)', () => {
		// The live→off re-run bug: if FURTRACK_MODE is skipped when off, deploy.yml
		// keeps re-PATCHing a stale 'live'. Writing 'off' explicitly neutralizes it.
		const furtrack = ciWiringEntries(input).find((e) => e.name === 'FURTRACK_MODE');
		expect(furtrack).toEqual({ kind: 'variable', name: 'FURTRACK_MODE', value: 'off' });
	});

	it('carries the live/mock mode through when enabled', () => {
		expect(
			ciWiringEntries({ ...input, furtrackMode: 'live' }).find((e) => e.name === 'FURTRACK_MODE')
				?.value
		).toBe('live');
	});

	it('wires four secrets and four variables with their values', () => {
		const entries = ciWiringEntries(input);
		const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
		expect(byName['CLOUDFLARE_API_TOKEN']).toEqual({
			kind: 'secret',
			name: 'CLOUDFLARE_API_TOKEN',
			value: 'tok'
		});
		expect(byName['SETUP_TOKEN']).toEqual({ kind: 'secret', name: 'SETUP_TOKEN', value: 'setup' });
		expect(byName['SITE_URL']).toEqual({
			kind: 'variable',
			name: 'SITE_URL',
			value: 'https://my.site'
		});
		expect(entries.filter((e) => e.kind === 'secret')).toHaveLength(4);
		expect(entries.filter((e) => e.kind === 'variable')).toHaveLength(4);
	});
});

describe('ciWiringEntries ↔ workflow YAML contract', () => {
	// Every secret/variable setup wires must be consumed by a workflow as
	// secrets.<NAME> / vars.<NAME>. A rename on either side would otherwise no-op
	// silently — the exact #51 bug class this test exists to catch.
	const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
	const yaml = readdirSync(workflowsDir)
		.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
		.map((f) => readFileSync(join(workflowsDir, f), 'utf8'))
		.join('\n');
	const entries = ciWiringEntries({
		apiToken: 'x',
		accountId: 'x',
		cronSecret: 'x',
		setupToken: 'x',
		project: 'x',
		dbName: 'x',
		siteUrl: 'x',
		furtrackMode: 'off'
	});

	it.each(entries)('$name is referenced as a workflow $kind', ({ kind, name }) => {
		const ref = kind === 'secret' ? `secrets.${name}` : `vars.${name}`;
		expect(yaml).toContain(ref);
	});
});

describe('securitySummaryLines', () => {
	const turnstileWarning = '  • Admin-login bot check: NOT set.';

	const sum = (over: Partial<SecuritySummaryInput>) =>
		securitySummaryLines({
			host: 'taro.surf',
			downloadRateLimit: null,
			downloadRateLimitDetail: null,
			turnstileStatus: null,
			turnstileDetail: null,
			turnstileWired: false,
			...over
		});

	/**
	 * waf-lib's REAL error detail for the given stubbed API outcomes. The summary
	 * tests below must exercise wording waf-lib actually emits — a hand-typed
	 * fixture once asserted against phrasing waf-lib never produced, making the
	 * "does not blame token scope" test vacuously green.
	 */
	async function realRateLimitDetail(routes: Record<string, CfApiResult>): Promise<string> {
		const res = await applyDownloadRateLimit(
			'test-token',
			'taro.surf',
			async (_token, path, init: { method?: string } = {}) =>
				routes[`${init.method ?? 'GET'} ${path}`] ?? { ok: false, status: 500 }
		);
		expect(res.status).toBe('error');
		return res.detail;
	}

	it('prints the Turnstile warning for EVERY rate-limit outcome (regression: a missing brace once nested it inside the applied branch)', () => {
		for (const rl of [null, 'exists', 'error', 'created', 'updated'] as const) {
			const lines = sum({ downloadRateLimit: rl, turnstileStatus: 'error', turnstileWired: true });
			expect(lines, `downloadRateLimit=${rl}`).toContain(turnstileWarning);
		}
	});

	it('reports an applied rate limit and a created Turnstile widget together', () => {
		const lines = sum({ downloadRateLimit: 'created', turnstileStatus: 'created', turnstileWired: true });
		expect(lines.join('\n')).toContain('Public-endpoint rate limit: applied to the taro.surf zone');
		expect(lines.join('\n')).toContain('Admin-login bot check: Turnstile created for taro.surf.');
	});

	it('repeats waf-lib’s failure reason and the retry command for a rate-limit error', async () => {
		// The real no-zone-access detail: the zone query succeeds but returns [].
		const detail = await realRateLimitDetail({
			'GET /zones?name=taro.surf': { ok: true, status: 200, result: [] }
		});
		expect(detail).toContain('no taro.surf zone was found on this Cloudflare account');
		const text = sum({ downloadRateLimit: 'error', downloadRateLimitDetail: detail }).join('\n');
		// The reason line carries the real detail and ends in a period.
		expect(text).toContain(`Reason: ${detail}.`);
		// The connective line between the reason and the retry command.
		expect(text).toContain('When that is fixed, run:');
		expect(text).toContain('npm run apply-download-ratelimit -- taro.surf');
	});

	it('does not blame token scope for a non-permission rate-limit failure', async () => {
		// The real write-failure detail: zone resolves, no ruleset yet, PUT 500s.
		const detail = await realRateLimitDetail({
			'GET /zones?name=taro.surf': { ok: true, status: 200, result: [{ id: 'z1' }] },
			'GET /zones/z1/rulesets/phases/http_ratelimit/entrypoint': { ok: false, status: 404 },
			'PUT /zones/z1/rulesets/phases/http_ratelimit/entrypoint': { ok: false, status: 500 }
		});
		// Pin the branch, not just the status: the stub 500s any unmatched route,
		// so path drift would silently reroute this to the zone query.
		expect(detail).toContain('failed to write');
		expect(detail).toContain('HTTP 500');
		const text = sum({ downloadRateLimit: 'error', downloadRateLimitDetail: detail }).join('\n');
		expect(text).toContain(detail);
		expect(text).not.toContain('token needs');
		expect(text).toContain('npm run apply-download-ratelimit -- taro.surf');
	});

	it('falls back to a generic failure line when no detail survived', () => {
		const text = sum({ downloadRateLimit: 'error' }).join('\n');
		expect(text).toContain('Public-endpoint rate limit: NOT set.');
		expect(text).toContain('Reason: none reported.');
		expect(text).toContain('When that is fixed, run:');
		expect(text).not.toContain('token needs');
	});

	it('repeats turnstile-lib’s real failure reason for a Turnstile error', async () => {
		// The real no-scope detail: the widget list 403s.
		const res = await provisionTurnstileWidget(
			'test-token',
			'acct1',
			'taro.surf',
			async () => ({ ok: false, status: 403 })
		);
		expect(res.status).toBe('error');
		expect(res.detail).toContain('token needs');
		const text = sum({ turnstileStatus: 'error', turnstileDetail: res.detail }).join('\n');
		expect(text).toContain('Admin-login bot check: NOT set.');
		expect(text).toContain(`Reason: ${res.detail}.`);
		expect(text).toContain('When that is fixed, re-run setup to protect /admin/login.');
	});

	it('does not blame token scope for a non-permission Turnstile failure', async () => {
		// The real transient detail: the widget list 500s.
		const res = await provisionTurnstileWidget(
			'test-token',
			'acct1',
			'taro.surf',
			async () => ({ ok: false, status: 500 })
		);
		expect(res.status).toBe('error');
		const text = sum({ turnstileStatus: 'error', turnstileDetail: res.detail }).join('\n');
		expect(text).toContain(`Reason: ${res.detail}.`);
		expect(text).not.toContain('token needs');
	});

	it('falls back to a generic Turnstile failure line when no detail survived', () => {
		const text = sum({ turnstileStatus: 'error' }).join('\n');
		expect(text).toContain('Admin-login bot check: NOT set.');
		expect(text).toContain('Reason: none reported.');
	});

	it('reports NO bot check when the widget provisioned but the wiring failed', () => {
		// The login check fails open without the sitekey var + secret, so a
		// provisioned widget with failed wiring must never read as enforced.
		for (const status of ['created', 'exists'] as const) {
			const text = sum({ downloadRateLimit: 'exists', turnstileStatus: status }).join('\n');
			expect(text).toContain('NOT confirm the TURNSTILE_SITEKEY');
			expect(text).toContain('/admin/login has NO bot check');
			// Honest on re-runs: the claim is scoped to this run / first runs.
			expect(text).toContain('this run');
			expect(text).toContain('first run');
			expect(text).not.toContain('enforced once deployed');
		}
	});

	it('never prints the enforced claim unless the wiring landed', () => {
		const wired = sum({ turnstileStatus: 'created', turnstileWired: true }).join('\n');
		expect(wired).toContain('enforced once deployed');
		const unwired = sum({ turnstileStatus: 'created' }).join('\n');
		expect(unwired).not.toContain('enforced once deployed');
	});

	it('names the RESOLVED parent zone in the applied line for a subdomain host', () => {
		const text = sum({
			host: 'sona.taro.surf',
			downloadRateLimit: 'created',
			zoneName: 'taro.surf'
		}).join('\n');
		expect(text).toContain('applied to the taro.surf zone');
		expect(text).not.toContain('applied to the sona.taro.surf zone');
	});

	it('stays silent about pre-existing rate limits and unattempted Turnstile', () => {
		expect(sum({ downloadRateLimit: 'exists' })).toEqual([]);
		expect(sum({})).toEqual([]);
	});
});

describe('zoneLookupWarnLines', () => {
	const warn = (status: number, errors?: unknown) => zoneLookupWarnLines('taro.surf', status, errors).join('\n');

	it('says the API did not respond on a thrown fetch, never "HTTP 0"', () => {
		const text = warn(0);
		expect(text).toContain('the Cloudflare API did not respond');
		expect(text).not.toContain('HTTP 0');
		expect(text).not.toContain('Zone → Zone: Read');
	});

	it('names Zone → Zone: Read only on a 401/403', () => {
		for (const status of [401, 403]) {
			const text = warn(status, [{ code: 9109, message: 'Unauthorized' }]);
			expect(text).toContain(`(HTTP ${status})`);
			expect(text).toContain('token needs Zone → Zone: Read');
			expect(text).toContain('the API said 9109: Unauthorized');
		}
	});

	it('repeats the API reason on a 2xx whose body said success:false', () => {
		const text = warn(200, [{ code: 1001, message: 'nope' }]);
		expect(text).toContain('the API reported failure (1001: nope)');
		expect(text).not.toContain('Zone → Zone: Read');
	});

	it('repeats the API reason on a non-2xx that carried one, without guessing a scope', () => {
		// The bug this replaced computed the reason only for a 2xx, so a 400/404/500
		// that carried one dropped it — exactly the statuses an operator can least
		// explain on their own.
		for (const status of [400, 404, 500]) {
			const text = warn(status, [{ code: 1002, message: 'boom' }]);
			expect(text).toContain(`(HTTP ${status})`);
			expect(text).toContain('the API said 1002: boom');
			expect(text).not.toContain('Zone → Zone: Read');
		}
	});

	it('prints just the status when the failure carried no reason', () => {
		const text = warn(500);
		expect(text).toContain('(HTTP 500)');
		expect(text).not.toContain('the API said');
	});

	it('names the failed candidate and keeps the skip + retry wording in every arm', () => {
		for (const status of [0, 403, 200, 500]) {
			const text = warn(status, [{ code: 1, message: 'x' }]);
			expect(text).toContain('Zone lookup failed for taro.surf');
			expect(text).toContain('— skipping the DNS / image-transform preflight.');
			expect(text).toContain('Re-run setup to retry the preflight.');
		}
	});
});

describe('storageSummaryLines', () => {
	const base = { bucket: 'taro-images', project: 'taro' };

	it('reports R2 as set up, and NOT READY when R2 is not enabled', () => {
		expect(
			storageSummaryLines({
				...base,
				provider: 'r2',
				r2Missing: false,
				bucketReady: true,
				uploadThingTokenSet: false
			})
		).toEqual(['Storage backend: Cloudflare R2 (set up).']);
		const missing = storageSummaryLines({
			...base,
			provider: 'r2',
			r2Missing: true,
			bucketReady: false,
			uploadThingTokenSet: false
		}).join('\n');
		expect(missing).toContain('NOT READY (R2 is not enabled on this account)');
		expect(missing).toContain('npx wrangler r2 bucket create taro-images');
	});

	// "R2 is not enabled" is one of several ways the create fails. A token without
	// Account → Workers R2 Storage: Edit carries none of that error's markers, and
	// claiming "(set up)" there binds a bucket that does not exist.
	it('reports R2 as NOT READY when the bucket create failed for any other reason', () => {
		const failed = storageSummaryLines({
			...base,
			provider: 'r2',
			r2Missing: false,
			bucketReady: false,
			uploadThingTokenSet: false
		}).join('\n');
		expect(failed).toContain('NOT READY (the taro-images bucket was not created)');
		expect(failed).toContain('npx wrangler r2 bucket create taro-images');
		expect(failed).not.toContain('(set up)');
	});

	it('only calls UploadThing set up when the token secret actually landed', () => {
		expect(
			storageSummaryLines({
				...base,
				provider: 'uploadthing',
				r2Missing: false,
				bucketReady: false,
				uploadThingTokenSet: true
			})
		).toEqual(['Storage backend: UploadThing (set up).']);
		const unset = storageSummaryLines({
			...base,
			provider: 'uploadthing',
			r2Missing: false,
			bucketReady: false,
			uploadThingTokenSet: false
		}).join('\n');
		expect(unset).toContain('NOT READY (the UPLOADTHING_TOKEN secret is not set)');
		expect(unset).toContain('--project-name taro');
	});
});

describe('resendSecretWarnLines', () => {
	it('stays silent when every supplied Resend secret landed', () => {
		expect(resendSecretWarnLines([], 'taro-surf')).toEqual([]);
	});

	// A failed put here surfaces months later as a dead password-reset link, so the
	// names and the command to fix them have to be said at setup time.
	it('names each failed secret and the command that sets it', () => {
		const text = resendSecretWarnLines(['RESEND_API_KEY', 'RESEND_FROM'], 'taro-surf').join('\n');
		expect(text).toContain('RESEND_API_KEY, RESEND_FROM');
		expect(text).toContain('Password-reset email stays off');
		expect(text).toContain('npx wrangler pages secret put RESEND_API_KEY --project-name taro-surf');
		expect(text).toContain('npx wrangler pages secret put RESEND_FROM --project-name taro-surf');
	});
});

describe('setup.ts ↔ Resend secret contract', () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.ts'), 'utf8');
	// main() isn't importable, so pin at source level that both puts are checked
	// rather than fired and forgotten, the way they were before.

	it('records a failed Resend put instead of discarding the result', () => {
		expect(src).toMatch(/!putSecret\('RESEND_API_KEY'/);
		expect(src).toMatch(/!putSecret\('RESEND_FROM'/);
		expect(src).toMatch(/resendSecretWarnLines\(resendFailed/);
	});
});

describe('telegramSummaryLine', () => {
	it('claims the bot token is set only when the put succeeded', () => {
		expect(telegramSummaryLine(false, false)).toContain('not configured');
		expect(telegramSummaryLine(true, true)).toContain('enabled (bot token set)');
		const failed = telegramSummaryLine(true, false);
		expect(failed).toContain('did NOT get set');
		expect(failed).not.toContain('(bot token set)');
	});
});

describe('setupTokenLines', () => {
	const input = { setupToken: 'abc123', project: 'taro' };

	it('hands over the token when the secret landed', () => {
		const text = setupTokenLines({ ...input, setupTokenSet: true }).join('\n');
		expect(text).toContain('SETUP_TOKEN = abc123');
		expect(text).toContain('enter it in the wizard');
		expect(text).not.toContain('did NOT get set');
	});

	it('says the wizard will reject it, and how to set it, when the put failed', () => {
		const text = setupTokenLines({ ...input, setupTokenSet: false }).join('\n');
		expect(text).toContain('did NOT get set');
		expect(text).toContain('npx wrangler pages secret put SETUP_TOKEN --project-name taro');
		// Still print the value — it is the token the operator will need after fixing.
		expect(text).toContain('SETUP_TOKEN = abc123');
	});
});

describe('provisioningNoteLine', () => {
	it('asserts each half only when its write landed', () => {
		expect(provisioningNoteLine(true, true)).toBe(
			'  (CRON_SECRET set for the cron jobs; storageProvider seeded.)'
		);
		expect(provisioningNoteLine(false, true)).toContain('CRON_SECRET NOT set');
		expect(provisioningNoteLine(true, false)).toContain('storageProvider NOT seeded');
		const both = provisioningNoteLine(false, false);
		expect(both).toContain('CRON_SECRET NOT set');
		expect(both).toContain('storageProvider NOT seeded');
	});
});

describe('setup.ts ↔ securitySummaryLines call-site contract', () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.ts'), 'utf8');
	// main() is not importable (it drives live Cloudflare state), so pin the
	// wiring at the source level: turnstileWired must be composed from the real
	// PATCH result and the real secret-put result — forcing a literal here once
	// survived the entire suite while reintroducing the very over-claim the
	// helper exists to prevent.

	// The whole securitySummaryLines({...}) call, so property assertions below
	// can't accidentally match unrelated code elsewhere in setup.ts.
	const summaryCall = src.match(/securitySummaryLines\(\{[\s\S]*?\}\)/)?.[0] ?? '';

	it('passes pagesConfigOk && turnstileSecretSet, not a literal', () => {
		expect(summaryCall).toMatch(/turnstileWired:\s*pagesConfigOk && turnstileSecretSet/);
	});

	it('passes the resolved zone name so subdomain summaries name the real zone', () => {
		expect(summaryCall).toMatch(/zoneName:\s*resolvedZoneName/);
	});

	it('assigns each detail from the provisioning result, not a literal', () => {
		expect(src).toMatch(/downloadRateLimitDetail\s*=\s*rateLimit\.detail/);
		expect(src).toMatch(/turnstileDetail\s*=\s*ts\.detail/);
	});

	// Shorthand properties are the variables themselves — a hardcoded
	// `host: 'x'` or `turnstileStatus: null` (the SONA-189 bug shape) breaks
	// the trailing-comma match.
	it.each(['host', 'downloadRateLimit', 'downloadRateLimitDetail', 'turnstileStatus', 'turnstileDetail'])(
		'%s is passed as call-site shorthand',
		(prop) => {
			expect(summaryCall).toMatch(new RegExp(`\\b${prop},`));
		}
	);

	it('both zone-lookup warn sites repeat the API reason', () => {
		// main()s are not importable, so pin the wiring at source level: the
		// resolveZone consumers must thread the errors body into a summarizer.
		// setup's arms are unit-tested directly via zoneLookupWarnLines below.
		expect(src).toContain('zoneLookupWarnLines(');
		expect(src).toContain('zoneLookupErrors');
		const connectSrc = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'connect-domains.ts'),
			'utf8'
		);
		expect(connectSrc).toContain('cfErrorSummary(errors)');
	});

	it('never stringifies a raw cfApi errors body into the console', () => {
		// The Pages-binding and connect-domains warns once printed
		// JSON.stringify(res.errors), which can echo account/project identifiers —
		// both must go through failureDetail, which reads only the allowlisted
		// code+message pairs (and lets the status decide whether a scope is named).
		const connectSrc = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'connect-domains.ts'),
			'utf8'
		);
		for (const source of [src, connectSrc]) {
			expect(source).not.toMatch(/JSON\.stringify\(res\.errors/);
		}
		expect(src).toContain('failureDetail(res, PAGES_SCOPE_HINT)');
	});

	it('stops rather than wire an empty D1 database_id', () => {
		// A failed `wrangler d1 create` plus an empty paste used to flow on and
		// print ✔ lines for bindings pointing at no database.
		expect(src).toMatch(/if \(!dbId\) \{[\s\S]*?process\.exitCode = 1;/);
	});

	it('reports secret puts from their results, not from what it tried to write', () => {
		expect(src).toMatch(/const setupTokenSet = putSecret\('SETUP_TOKEN'/);
		expect(src).toMatch(/const cronSecretSet = putSecret\('CRON_SECRET'/);
		expect(src).toContain('telegramSummaryLine(Boolean(telegramBotToken), telegramTokenSet)');
		// The seed's own result, from the execute's exit — not a literal true.
		expect(src).toContain('provisioningNoteLine(cronSecretSet, seedOk)');
	});

	// Shorthand or nothing: `uploadThingTokenSet: true` satisfies a bare
	// toContain of the name, and that literal is exactly the over-claim these
	// helpers exist to prevent.
	it('passes the storage summary the real results as shorthand', () => {
		const storageCall = src.match(/storageSummaryLines\(\{[\s\S]*?\}\)/)?.[0] ?? '';
		expect(storageCall).not.toBe('');
		for (const prop of ['bucketReady', 'uploadThingTokenSet', 'r2Missing']) {
			expect(storageCall).toMatch(new RegExp(`\\b${prop},`));
		}
	});

	// The R2 "(set up)" claim: derived from the create's own outcome, never from
	// the absence of the not-enabled error text.
	it('derives bucketReady from the bucket create outcome', () => {
		expect(src).toMatch(/const bucketReady = bucketCreateSucceeded\(r2Out, r2CreateOk\)/);
	});

	// Same shape as the securitySummaryLines pin: hardcoding setupTokenSet: true
	// here prints the token as if the wizard would take it, and survived the suite.
	it('passes the setup-token block the real put result as shorthand', () => {
		const tokenCall = src.match(/setupTokenLines\(\{[\s\S]*?\}\)/)?.[0] ?? '';
		expect(tokenCall).not.toBe('');
		expect(tokenCall).toMatch(/\bsetupTokenSet[,}]/);
	});

	it('no middot scope names remain anywhere an operator sees one', () => {
		// The arrow form (Account → Turnstile: Edit) is the ruling; this guard fails
		// on any middot (·) reintroduced in the CLIs or the operator docs. Comments
		// are in scope too now that they use the arrow form, so the whole file is
		// scanned — connect-domains-lib's skip glyph is the one allowance.
		const here = dirname(fileURLToPath(import.meta.url));

		// The resolved constants themselves, not just their use sites.
		expect(WAF_SCOPE_HINT).not.toContain('·');
		expect(TURNSTILE_SCOPE_HINT).not.toContain('·');

		for (const file of [
			'setup.ts',
			'setup-lib.ts',
			'connect-domains.ts',
			'connect-domains-lib.ts',
			'apply-download-ratelimit.ts',
			'waf-lib.ts',
			'turnstile-lib.ts'
		]) {
			const source = readFileSync(join(here, file), 'utf8').replaceAll("skip: '·'", '');
			expect(source, `${file}`).not.toContain('·');
		}

		// Positive canaries so the scan can't pass on a file that lost its recipe.
		expect(readFileSync(join(here, 'setup.ts'), 'utf8')).toContain('Zone → Zone: Read');
		expect(readFileSync(join(here, 'apply-download-ratelimit.ts'), 'utf8')).toContain(
			'Zone → WAF: Edit'
		);

		// README and UPDATING.md: every line outside code fences.
		for (const doc of ['README.md', 'UPDATING.md']) {
			const text = readFileSync(join(here, '..', doc), 'utf8');
			let inFence = false;
			const prose = text
				.split('\n')
				.filter((l) => {
					if (/^\s*```/.test(l)) {
						inFence = !inFence;
						return false;
					}
					return !inFence;
				})
				.join('\n');
			// Positive canaries so an empty or mis-parsed doc can't pass vacuously.
			if (doc === 'README.md') expect(prose).toContain('| Scope | Why |');
			if (doc === 'UPDATING.md') expect(prose).toContain('Zone → WAF: Edit');
			expect(prose, `${doc} prose`).not.toContain('·');
		}
	});

	it('the token recipe names Turnstile’s scope via the shared constant', () => {
		expect(src).toMatch(/\$\{TURNSTILE_SCOPE_HINT\}/);
	});

	it('assigns pagesConfigOk from the Pages PATCH result, read-back confirmed', () => {
		expect(src).toMatch(/pagesPatchConfirmsSitekey\(res\.result, turnstileSitekey\)/);
	});
});

describe('cfErrorSummary', () => {
	it('prints each error as code: message, joined', () => {
		expect(
			cfErrorSummary([
				{ code: 8000000, message: 'An unknown error occurred' },
				{ code: 10000, message: 'Authentication error' }
			])
		).toBe('8000000: An unknown error occurred; 10000: Authentication error');
	});

	it('redacts everything but code + message (no stringified bodies)', () => {
		const summary = cfErrorSummary([
			{ code: 10000, message: 'Authentication error', detail: { account_id: 'acct-id-must-not-leak' } }
		]);
		expect(summary).toBe('10000: Authentication error');
		expect(summary).not.toContain('acct-id-must-not-leak');
	});

	it('handles messages without a numeric code', () => {
		expect(cfErrorSummary([{ message: 'plain message' }])).toBe('plain message');
	});

	it('yields empty for undefined, non-arrays, and junk entries', () => {
		expect(cfErrorSummary(undefined)).toBe('');
		expect(cfErrorSummary('a string body')).toBe('');
		expect(cfErrorSummary({ message: 'not an array' })).toBe('');
		expect(cfErrorSummary([null, 'junk', {}])).toBe('');
	});

	it('drops code-only and empty-message entries (no dangling "10000: ")', () => {
		expect(cfErrorSummary([{ code: 10000 }])).toBe('');
		expect(cfErrorSummary([{ code: 10000, message: '' }])).toBe('');
		expect(cfErrorSummary([{ code: 10000 }, { code: 7003, message: 'kept' }])).toBe('7003: kept');
	});

	it('collapses whitespace so a multi-line message stays one printable line', () => {
		expect(cfErrorSummary([{ code: 7003, message: 'line one\n\t line two' }])).toBe(
			'7003: line one line two'
		);
	});

	it('caps an over-long message so pasteable output stays readable', () => {
		const long = 'x'.repeat(500);
		const summary = cfErrorSummary([{ code: 7003, message: long }]);
		expect(summary.length).toBeLessThan(230);
		expect(summary).toContain('7003: ');
		expect(summary.endsWith('…')).toBe(true);
	});

	it('scrubs path-shaped object ids out of the message (code 7003 echoes them)', () => {
		const zoneId = 'a'.repeat(32);
		const summary = cfErrorSummary([
			{
				code: 7003,
				message: `Could not route to /zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint, perhaps your object identifier is invalid?`
			}
		]);
		expect(summary).not.toContain(zoneId);
		expect(summary).toContain('/zones/<id>/rulesets');
		expect(summary).toContain('7003: Could not route');
	});

	it('scrubs ANY 32-hex path segment: uppercase, nested, and boundary-punctuated', () => {
		const upper = 'ABCDEF0123456789ABCDEF0123456789';
		const zid = 'b'.repeat(32);
		const rid = 'c'.repeat(32);
		const ruleId = 'd'.repeat(32);
		const summary = cfErrorSummary([
			{ code: 1, message: `bad account /accounts/${upper}.` },
			{ code: 2, message: `no rule at /zones/${zid}/rulesets/${rid}/rules/${ruleId}, sorry` }
		]);
		for (const id of [upper, zid, rid, ruleId]) expect(summary).not.toContain(id);
		// Ids straddling '.', ',', '/', and end-of-string all scrub.
		expect(summary).toContain('1: bad account /accounts/<id>.');
		expect(summary).toContain('2: no rule at /zones/<id>/rulesets/<id>/rules/<id>, sorry');
	});

	it('scrubs ids that are not path segments: assigned, quoted, parenthesized', () => {
		const acct = 'e'.repeat(32);
		const zid = 'f'.repeat(32);
		const rid = '0'.repeat(32);
		const summary = cfErrorSummary([
			{ code: 1, message: `account_id=${acct} is not authorized` },
			{ code: 2, message: `zone "${zid}" not found` },
			{ code: 3, message: `ruleset (${rid}) is missing` }
		]);
		for (const id of [acct, zid, rid]) expect(summary).not.toContain(id);
		expect(summary).toContain('1: account_id=<id> is not authorized');
		expect(summary).toContain('2: zone "<id>" not found');
		expect(summary).toContain('3: ruleset (<id>) is missing');
	});

	// A zero-width joiner inside an id used to become a space, splitting the run
	// into two halves that no longer matched the 32-hex pattern — so the id
	// printed. Deleting format chars keeps the run intact and the scrub working.
	it('scrubs an id even when a zero-width char sits inside it', () => {
		const zid = 'a'.repeat(32);
		const split = `${zid.slice(0, 10)}\u200b${zid.slice(10)}`;
		const summary = cfErrorSummary([{ code: 1, message: `zone ${split} not found` }]);
		expect(summary).toBe('1: zone <id> not found');
	});

	// \b treats '_' as a word char, so an id butted against an underscore never
	// hit a word boundary and slipped through unscrubbed.
	it('scrubs an id sitting next to an underscore', () => {
		const zid = 'b'.repeat(32);
		const summary = cfErrorSummary([{ code: 1, message: `key zone_${zid}_v2 rejected` }]);
		expect(summary).not.toContain(zid);
		expect(summary).toBe('1: key zone_<id>_v2 rejected');
	});

	it('leaves shorter hex runs alone (only a full 32-hex id is an object id)', () => {
		const summary = cfErrorSummary([
			{ code: 1, message: 'checksum abcdef01 and prefix abcdef0123456789 are fine' }
		]);
		expect(summary).toBe('1: checksum abcdef01 and prefix abcdef0123456789 are fine');
	});

	it('strips control/format chars (ANSI escapes) before printing', () => {
		const summary = cfErrorSummary([{ code: 7003, message: '\u001b[31mred\u001b[0m\u200b alert' }]);
		expect(summary).not.toContain('\u001b');
		expect(summary).not.toContain('\u200b');
		expect(summary).toContain('alert');
	});

	it('caps by code point so an emoji at the boundary is never split', () => {
		// 199 chars + two emoji = 201 code points: over the 200 cap by one.
		const summary = cfErrorSummary([{ code: 7003, message: 'x'.repeat(199) + '🎉🎉' }]);
		expect(summary.endsWith('…')).toBe(true);
		expect(summary).not.toContain('�');
		// The kept 200 points end with the first emoji, whole.
		expect(Array.from(summary).length).toBe(Array.from('7003: ').length + 201);
		expect(summary).toContain('🎉');
	});

	it('caps the JOINED summary so many errors cannot yield a multi-KB line', () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ code: 1000 + i, message: 'y'.repeat(50) }));
		const summary = cfErrorSummary(many);
		expect(Array.from(summary).length).toBeLessThanOrEqual(301);
		expect(summary.endsWith('…')).toBe(true);
		expect(summary).toContain('1000: ');
	});

	it('the joined cap also counts code points (emoji at the join boundary stays whole)', () => {
		// Two entries land the join at exactly 299 points (each under the
		// per-message cap), so the third entry's emoji straddle the 300
		// boundary: the cap must drop or keep each one whole.
		const summary = cfErrorSummary([
			{ code: 1000, message: 'y'.repeat(141) }, // line: 147 points
			{ code: 1001, message: 'y'.repeat(142) }, // +2 +148 = 297, +2 = 299
			{ message: '🎉🎉🎉' } // 300..302 — over the cap mid-emoji-run
		]);
		// The kept 300th point is the first emoji, whole — a UTF-16 slice would
		// cut it into a lone surrogate and fail both of these.
		expect(summary.endsWith('🎉…')).toBe(true);
		expect(summary.isWellFormed()).toBe(true);
		expect(summary).not.toContain('\uFFFD');
		expect(Array.from(summary).length).toBe(301);
	});
});

describe('pagesPatchConfirmsSitekey', () => {
	const body = (value?: string) => ({
		deployment_configs: {
			production: { env_vars: value === undefined ? {} : { TURNSTILE_SITEKEY: { value } } }
		}
	});

	it('confirms when the response echoes the sitekey we sent', () => {
		expect(pagesPatchConfirmsSitekey(body('0xKEY'), '0xKEY')).toBe(true);
	});

	it('rejects a response that dropped or changed the var', () => {
		expect(pagesPatchConfirmsSitekey(body(), '0xKEY')).toBe(false);
		expect(pagesPatchConfirmsSitekey(body('0xOTHER'), '0xKEY')).toBe(false);
	});

	it('reads a missing/malformed body as unconfirmed (the safe direction)', () => {
		expect(pagesPatchConfirmsSitekey(undefined, '0xKEY')).toBe(false);
		expect(pagesPatchConfirmsSitekey({}, '0xKEY')).toBe(false);
		expect(pagesPatchConfirmsSitekey({ deployment_configs: null }, '0xKEY')).toBe(false);
	});
});

describe('cdnAttachmentLines', () => {
	it('points at connect-domains (attach + --check) when a domain was given', () => {
		const text = cdnAttachmentLines('https://cdn.taro.surf', 'taro-images', 'taro.surf').join('\n');
		expect(text).toContain('npm run connect-domains -- taro.surf');
		expect(text).toContain('npm run connect-domains -- --check taro.surf');
		// connect-domains hard-requires BOTH env vars (it exits 1 otherwise), so
		// both commands must name the pair.
		expect(text.match(/CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>/g)).toHaveLength(2);
		// The dashboard route survives as the fallback for tokens without DNS scope.
		expect(text).toContain('R2 → taro-images → Settings → Custom Domains → add https://cdn.taro.surf');
		// The images-404 consequence rides the connect instruction itself.
		expect(text).toContain('setup did not touch DNS.');
		expect(text).toContain('Images 404 until you connect it.');
	});

	it('normalizes a messy domain answer to the bare host itself', () => {
		const text = cdnAttachmentLines(
			'https://cdn.taro.surf',
			'taro-images',
			'https://Taro.Surf/gallery'
		).join('\n');
		expect(text).toContain('npm run connect-domains -- taro.surf');
	});

	it('falls back to the dashboard when the R2 public URL is not cdn.<domain>', () => {
		// connect-domains always attaches cdn.<domain>; pointing an overridden
		// public URL at it would wire the wrong host and leave images 404ing.
		const text = cdnAttachmentLines('https://images.taro.surf', 'taro-images', 'taro.surf').join('\n');
		expect(text).not.toContain('connect-domains');
		expect(text).toContain('Cloudflare dashboard → R2 → taro-images → Settings → Custom Domains');
		expect(text).toContain('add https://images.taro.surf');
		expect(text).toContain('Images 404 until this is done.');
	});

	it('falls back to the dashboard walkthrough when no domain was given', () => {
		const text = cdnAttachmentLines('https://cdn.taro.surf', 'taro-images', '').join('\n');
		expect(text).not.toContain('connect-domains');
		expect(text).toContain('Cloudflare dashboard → R2 → taro-images → Settings → Custom Domains');
		expect(text).toContain('Images 404 until this is done.');
	});
});

describe('cdnAttachmentLines ↔ package.json contract', () => {
	// The printed `npm run <script>` commands must exist in package.json — a
	// script rename would otherwise point every fresh setup at a dead command.
	const pkg = JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
	) as { scripts: Record<string, string> };
	const text = cdnAttachmentLines('https://cdn.taro.surf', 'taro-images', 'taro.surf').join('\n');
	const scripts = [...text.matchAll(/npm run (\S+)/g)].map((m) => m[1]);

	it('prints at least one npm run command', () => {
		expect(scripts).toContain('connect-domains');
	});

	it.each([...new Set(scripts)])('`npm run %s` exists in package.json scripts', (name) => {
		expect(pkg.scripts).toHaveProperty(name);
	});
});

describe('setup.ts ↔ zone-preflight source contract', () => {
	// main() isn't importable, so pin that the preflight uses the shared
	// candidate walk and distinguishes a failed lookup from "no zone" — the old
	// inline loop read a 403 as "No Cloudflare zone found".

	it('resolves the zone via resolveZone over zoneNameCandidates(host)', () => {
		expect(setupSrc).toMatch(/resolveZone\(\s*zoneNameCandidates\(\s*host\s*\)/s);
	});

	it('handles a failed lookup before the no-zone branch', () => {
		const errIdx = setupSrc.indexOf('zoneLookupError !== null');
		const noZoneIdx = setupSrc.indexOf('No Cloudflare zone found');
		expect(errIdx).toBeGreaterThan(-1);
		expect(noZoneIdx).toBeGreaterThan(errIdx);
	});
});

// setup.ts is main()-only: it self-executes and prompts, so there is nothing to
// import and these rules are pinned at the source level, like the contracts above.
// Only rules that encode behavior are pinned here — never formatting, and never
// something a unit test already proves.
// Prose that mentions run() or execSync must not be read as a call site. Line
// comments only: a `/*` inside one of them (`drizzle/*.sql`) would otherwise pair
// with a later `*/` and swallow the code in between.
const setupCode = setupSrc.replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('setup.ts ↔ no operator answer reaches a shell', () => {
	/** A top-level function's source: its header through the first column-0 `}`. */
	const fnBody = (name: string): string => {
		const start = setupCode.indexOf(`function ${name}(`);
		if (start < 0) throw new Error(`setup.ts no longer defines function ${name}`);
		const end = setupCode.indexOf('\n}', start);
		if (end < 0) throw new Error(`function ${name} has no top-level close`);
		return setupCode.slice(start, end);
	};
	// The two helpers allowed to spawn a shell, cut out so what remains is every
	// other line of the CLI.
	const outsideHelpers = ['run', 'commandSucceeds'].reduce(
		(rest, name) => rest.replace(fnBody(name), ''),
		setupCode
	);

	it('spawns a shell only inside run() and commandSucceeds()', () => {
		// A bare execSync anywhere else is the hoisted form this whole change removes:
		// `const cmd = ` + "`… ${project}`" + `; execSync(cmd)`.
		expect(outsideHelpers).not.toMatch(/\bexecSync\s*\(/);
	});

	it('passes only fixed literals to the shell-string helpers', () => {
		const firstArgs = [...outsideHelpers.matchAll(/\b(?:run|commandSucceeds)\(\s*([^,)]*)/g)].map(
			(m) => m[1].trim()
		);
		// Non-vacuity: if the scan ever matches nothing (a rename, a regex that stops
		// binding), it fails here instead of passing on an empty list.
		expect(firstArgs).toEqual(
			expect.arrayContaining([
				"'npx wrangler whoami'",
				"'git remote get-url origin'",
				"'gh --version'",
				"'gh auth status'"
			])
		);
		// Each is a plain quoted literal: no interpolation, no concatenation, and no
		// identifier holding a string built somewhere else.
		for (const arg of firstArgs) expect(arg, arg).toMatch(/^'[^'$`]*'$|^"[^"$`]*"$/);
	});

	// The two ways an argv call quietly becomes a shell call again.
	it('never asks a child process for a shell', () => {
		expect(setupCode).not.toMatch(/shell:\s*true/);
		// execFileSync('sh', ['-c', …]) is a command line by another name.
		expect(setupCode).not.toMatch(
			/execFileSync\(\s*['"`](?:\/bin\/|\/usr\/bin\/)?(?:sh|bash|zsh|cmd)(?:\.exe)?['"`]/
		);
	});

	// Dropping the opts argument silently disables capture, allowFail and onFail —
	// the behavior runWith's own unit tests cover, wired to the two callers here.
	it('forwards each runner\'s opts to runWith', () => {
		expect(setupCode.match(/runWith\([^;]*,\s*opts\s*\)/g)).toHaveLength(2);
	});
});

describe('setup.ts ↔ SQL never rides a command line', () => {
	it('never hands wrangler SQL with --command', () => {
		expect(setupCode).not.toContain('--command');
	});

	it('passes the migration and seed SQL as files, written through the private helper', () => {
		expect(setupCode.match(/--file=\$\{\w+\.path\}/g)).toHaveLength(2);
		expect(setupCode.match(/writePrivateTempSql\(/g)).toHaveLength(2);
	});

	it('writes the seed inside the try, so a failed write degrades instead of aborting', () => {
		// Outside it, an ENOSPC or EACCES on tmpdir throws out of main() with D1, R2
		// and Pages created but the secrets not yet set.
		const tryIdx = setupCode.indexOf('let seedOk = true;');
		const writeIdx = setupCode.indexOf('writePrivateTempSql(seed', tryIdx);
		const catchIdx = setupCode.indexOf('seedOk = false;', tryIdx);
		expect(writeIdx).toBeGreaterThan(tryIdx);
		expect(catchIdx).toBeGreaterThan(writeIdx);
	});
});

// Every private temp dir gets removed on the way out, whatever the command did.
describe('setup CLIs ↔ every temp SQL dir is cleaned up in a finally', () => {
	const files = {
		'setup.ts': setupCode,
		'reset-password.ts': readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'reset-password.ts'),
			'utf8'
		)
	};

	for (const [name, code] of Object.entries(files)) {
		it(`${name} removes as many temp dirs as it writes, each from a finally`, () => {
			const writes = code.match(/writePrivateTempSql\(/g) ?? [];
			const removes = [...code.matchAll(/removeTempSqlDir\(/g)];
			expect(writes.length, name).toBeGreaterThan(0);
			expect(removes.length, name).toBe(writes.length);
			for (const m of removes) {
				const openIdx = code.lastIndexOf('finally {', m.index);
				expect(openIdx, name).toBeGreaterThan(-1);
				// Still inside that finally block — no intervening close brace.
				expect(code.slice(openIdx, m.index), name).not.toContain('}');
			}
		});
	}
});

describe('setup.ts ↔ a rejected answer is asked again, or setup stops', () => {
	it("binds both prompts to this run's TTY, so a piped run cannot loop forever", () => {
		expect(setupCode).toMatch(/askResourceName\(/);
		expect(setupCode).toMatch(/askUntilValid\(\s*q,\s*def,\s*isValidDatabaseName/);
		expect(setupCode).toMatch(/askUntilValid\(\s*q,\s*def,\s*isValidBucketName/);
		// askName, askDbName, askBucketName, and the pasted database_id.
		expect(setupCode.match(/isInteractive:\s*Boolean\(\s*stdin\.isTTY\s*\)/g)).toHaveLength(4);
	});

	// The prompts themselves, not just the helpers: reverting any of the three to a
	// bare `await ask(` left every other pin in this file green.
	it('asks for all three names through a validating prompt, each with its abort', () => {
		const bindings = [...setupCode.matchAll(/const (project|dbName|bucket) = await (\w+)\(/g)];
		expect(bindings.map((m) => [m[1], m[2]])).toEqual([
			['project', 'askName'],
			['dbName', 'askDbName'],
			['bucket', 'askBucketName']
		]);
		// Each answer is checked for null on the very next line — an unguarded one
		// would carry a null name into wrangler and wrangler.toml.
		for (const [name] of bindings.map((m) => [m[1]])) {
			expect(setupCode, name).toMatch(
				new RegExp(`const ${name} = await \\w+\\([^;]*;\\s*(?://[^\\n]*\\n\\s*)*if \\(${name} === null\\) return abortAnswer\\(`)
			);
		}
	});

	// The pasted database_id is the fourth validated answer, and blank still means
	// "I don't have one" — the clause that lets the existing no-id abort fire.
	it('validates the pasted database_id while still accepting a blank answer', () => {
		expect(setupCode).toMatch(/\(answer\) => answer === ''\s*\|\|\s*isValidDatabaseId\(answer\)/);
		expect(setupCode).toMatch(/if \(pasted === null\) return abortAnswer\(\s*'database id'/);
	});

	// Printing the reason and returning is not stopping: without these two, setup
	// would carry on to provisioning and exit 0.
	it('marks the run failed and closes the prompt when it cannot ask again', () => {
		const start = setupCode.indexOf('const abortAnswer =');
		expect(start).toBeGreaterThan(-1);
		const body = setupCode.slice(start, setupCode.indexOf('\n\t};', start));
		expect(body).toContain('process.exitCode = 1;');
		expect(body).toContain('rl.close();');
	});
});

describe('setup.ts ↔ untrusted values are encoded, never pasted raw', () => {
	it('encodes both segments of the Pages-project PATCH path', () => {
		expect(setupCode).toContain(
			'/accounts/${encodeURIComponent(cfAccount)}/pages/projects/${encodeURIComponent(project)}'
		);
	});

	it('encodes the zone id in every zone call it makes itself', () => {
		expect(setupCode).not.toMatch(/\/zones\/\$\{zoneId\}/);
		expect(setupCode.match(/\/zones\/\$\{encodeURIComponent\(zoneId\)\}/g)).toHaveLength(3);
	});
});
