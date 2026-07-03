#!/usr/bin/env tsx
/**
 * Sona setup CLI — provisions the Cloudflare side of a fork AND decides the image
 * storage backend (the one place that can create a bucket / set a token).
 *
 *   npm run setup
 *
 * It creates the Pages project, D1 database, and R2 bucket; picks the storage
 * provider (R2 or UploadThing) and wires its secret/URL; writes `wrangler.toml`;
 * applies migrations (recording them in schema_migrations so the first CI deploy
 * is a no-op); seeds storageProvider; generates + sets SETUP_TOKEN and
 * CRON_SECRET; and optionally wires the fork's GitHub Actions secrets/vars.
 * Branding, theme, and the admin password are set afterward in the in-app
 * first-run wizard at /admin/setup. To switch storage later, use Settings →
 * Storage Provider (which sets up the new token/bucket + migrates).
 *
 * Prerequisites: `wrangler login` (or CLOUDFLARE_API_TOKEN) must be set up first.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env, cwd } from 'node:process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	buildMigrationSql,
	sanitizeProjectName,
	isR2NotEnabled,
	ensureUrlScheme,
	ghSecretEligibility
} from './setup-lib.ts';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q: string, def: string) => {
	const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
	return a || def;
};
const askYesNo = async (q: string, def = true) => {
	const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
	if (!a) return def;
	return a === 'y' || a === 'yes';
};

type RunOpts = { capture?: boolean; allowFail?: boolean; stdin?: 'inherit' | 'ignore' };
function run(cmd: string, opts: RunOpts = {}): string {
	console.log(`\n$ ${cmd}`);
	try {
		const stdio: import('node:child_process').StdioOptions = opts.capture
			? 'pipe'
			: [opts.stdin ?? 'inherit', 'inherit', 'inherit'];
		const out = execSync(cmd, { stdio, encoding: 'utf8' });
		return out ?? '';
	} catch (err) {
		if (opts.allowFail) {
			// On a tolerated failure, hand back whatever the command printed so callers
			// can sniff it (e.g. the R2 "not enabled" error). Inherited stdio isn't
			// captured, so this is only non-empty when `capture` was set.
			const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
			return `${e.stdout ?? ''}${e.stderr ?? ''}`;
		}
		throw err;
	}
}

// True when the command runs to a zero exit. Used for gh/git probes where we
// only care about success, not output.
function commandSucceeds(cmd: string): boolean {
	try {
		execSync(cmd, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

// Set a GitHub Actions secret/variable, passing the value on stdin so it is
// never printed (the token must not land in the console log).
function ghSet(kind: 'secret' | 'variable', name: string, value: string): boolean {
	console.log(`\n$ gh ${kind} set ${name}`);
	try {
		execSync(`gh ${kind} set ${name}`, { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
		return true;
	} catch {
		return false;
	}
}

const token = (bytes = 32) => randomBytes(bytes).toString('hex');
const sqlStr = (s: string) => s.replace(/'/g, "''");

async function main() {
	console.log('— Sona setup —\n');
	console.log('Make sure you are logged in: `npx wrangler login` (or set CLOUDFLARE_API_TOKEN).\n');

	if (existsSync('wrangler.toml')) {
		const overwrite = await askYesNo('wrangler.toml already exists. Overwrite it?', false);
		if (!overwrite) {
			console.log('Aborting so your existing wrangler.toml is preserved.');
			rl.close();
			return;
		}
	}

	// Storage backend is decided first (it needs a bucket / a token). The bucket is
	// created either way so the IMAGES binding is always valid and you can switch
	// to R2 later without re-provisioning.
	const useR2 = await askYesNo('Use Cloudflare R2 for image storage now? (otherwise UploadThing)', true);

	// The site's domain only seeds sensible defaults (the Pages project name and the
	// R2 public/CDN URL). Setup does NOT configure DNS or attach a custom domain to
	// the bucket — that needs DNS-scoped access we don't ask for, so it stays a
	// manual step (called out in Next steps). Only asked for R2, where it seeds the
	// CDN URL.
	const domain = useR2 ? await ask("Your site's domain (e.g. taro.surf) — blank to skip", '') : '';

	// Default the project name from the domain (the most meaningful identifier),
	// else the fork's directory, so a rename doesn't silently reuse the template's
	// `sona` resources; the operator can override.
	const defaultProject = sanitizeProjectName(domain || basename(cwd()));
	const project = await ask('Cloudflare Pages project name (lowercase, hyphenated)', defaultProject);
	const dbName = await ask('D1 database name', `${project}-db`);
	const bucket = await ask('R2 bucket name', `${project}-images`);

	// Default the R2 public URL to https://cdn.<domain> when a domain was given.
	// The app uses this verbatim as `${base}/${key}`, so normalize whatever the
	// operator ends up with to carry a scheme (a bare host would break delivery).
	const r2PublicUrlRaw = useR2
		? await ask(
				"R2 public URL (the bucket's custom domain; blank to set later)",
				domain ? ensureUrlScheme(`cdn.${domain}`) : ''
			)
		: '';
	const r2PublicUrl = ensureUrlScheme(r2PublicUrlRaw);
	const uploadThingToken = useR2 ? '' : await ask('UploadThing token (UPLOADTHING_TOKEN)', '');
	const provider = useR2 ? 'r2' : 'uploadthing';

	// Fursuit photos (FurTrack). Off by default — a fresh fork shouldn't call an
	// external API until the operator opts in. When enabled we set FURTRACK_MODE in
	// wrangler.toml and seed the character/tag the feature queries; switch it later
	// by editing FURTRACK_MODE or in admin Settings.
	console.log(
		"\nFursuit photos import a character's photos from FurTrack and self-host them."
	);
	let furtrackMode = 'off';
	let primaryCharacter = '';
	if (await askYesNo('Enable fursuit photos now?', false)) {
		console.log(
			"  'live' calls the real FurTrack API (self-host CC/public-domain photos per FurTrack's terms;"
		);
		console.log("         direct API use requires approval from FurTrack).");
		console.log("  'mock' serves bundled demo data (safe for local/dev).");
		furtrackMode = (await askYesNo('Use live FurTrack data? (No = mock demo data)', false))
			? 'live'
			: 'mock';
		primaryCharacter = await ask(
			'FurTrack character/tag to feature (the fursuit the gallery imports; blank to set later)',
			''
		);
	}

	// 1. Pages project (idempotent — ignore "already exists").
	run(`npx wrangler pages project create ${project} --production-branch main`, { allowFail: true });

	// 2. D1 — create and capture the database_id from the printed config block.
	const d1Out = run(`npx wrangler d1 create ${dbName}`, { capture: true, allowFail: true });
	process.stdout.write(d1Out);
	let dbId = (d1Out.match(/database_id\s*=\s*"([0-9a-fA-F-]+)"/) || [])[1] ?? '';
	if (!dbId) dbId = await ask('Could not auto-detect database_id — paste it from the output above', '');

	// 3. R2 bucket — always create it so the IMAGES binding is valid. Detect the
	//    "R2 not enabled on this account" case (error 10042) rather than swallowing
	//    it as success and later claiming the R2 backend is set up.
	const r2Out = run(`npx wrangler r2 bucket create ${bucket}`, { capture: true, allowFail: true });
	process.stdout.write(r2Out);
	const r2Missing = isR2NotEnabled(r2Out);
	if (r2Missing) {
		console.warn('\n⚠ R2 does not appear to be enabled on this Cloudflare account.');
		console.warn('  Enable it at dash.cloudflare.com → R2, then re-run setup');
		console.warn(`  (or run:  npx wrangler r2 bucket create ${bucket}).`);
		if (useR2)
			console.warn(`  Image uploads will NOT work until the bucket "${bucket}" exists.`);
	}

	// 4. Render wrangler.toml from the template.
	const tpl = readFileSync('wrangler.toml.example', 'utf8');
	const toml = tpl
		.replace(/^name = ".*"/m, `name = "${project}"`)
		.replace(/database_name = ".*"/, `database_name = "${dbName}"`)
		.replace(/database_id = ".*"/, `database_id = "${dbId}"`)
		.replace(/bucket_name = ".*"/, `bucket_name = "${bucket}"`)
		.replace(/^FURTRACK_MODE = ".*"/m, `FURTRACK_MODE = "${furtrackMode}"`);
	writeFileSync('wrangler.toml', toml);
	console.log('\n✔ wrote wrangler.toml');

	// 5. Apply D1 migrations (remote) in ONE execute. We build a single SQL script
	//    — CREATE schema_migrations + every drizzle/*.sql in order, each followed
	//    by an INSERT that records its basename — so there is one remote call (not
	//    ~18) and the DB ends in the state the deploy workflow's tracked migration
	//    step treats as already-applied (a clean no-op on the first CI deploy).
	//    stdin is ignored so wrangler's interactive "Ok to proceed?" never fires
	//    (the same reason CI, which has no TTY, is never prompted).
	const migFiles = readdirSync('drizzle')
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const combinedSql = buildMigrationSql(
		migFiles.map((name) => ({ name, sql: readFileSync(join('drizzle', name), 'utf8') }))
	);
	const combinedPath = join(tmpdir(), `sona-migrations-${token(6)}.sql`);
	writeFileSync(combinedPath, combinedSql);
	try {
		run(`npx wrangler d1 execute ${dbName} --remote --file="${combinedPath}"`, { stdin: 'ignore' });
	} finally {
		try {
			unlinkSync(combinedPath);
		} catch {
			/* best-effort temp cleanup */
		}
	}

	// 6. Seed the storage provider so the app boots with the chosen backend (the
	//    wizard no longer asks; switching later is a migration in Settings).
	let seed = `INSERT OR REPLACE INTO site_settings (key,value) VALUES ('storageProvider','${provider}')`;
	if (useR2 && r2PublicUrl) seed += `, ('r2PublicUrl','${sqlStr(r2PublicUrl)}')`;
	// Seed the FurTrack character/tag the fursuit feature queries (mirrors storageProvider).
	if (primaryCharacter) seed += `, ('primaryCharacter','${sqlStr(primaryCharacter)}')`;
	seed += ';';
	run(`npx wrangler d1 execute ${dbName} --remote --command "${seed}"`, {
		allowFail: true,
		stdin: 'ignore'
	});

	// 7. Generate + set secrets. SETUP_TOKEN gates the first-run wizard.
	const setupToken = token();
	const cronSecret = token();
	const putSecret = (name: string, value: string) => {
		// Feed the value over stdin (never the command line or the log) so the
		// secret is not echoed to the console or exposed in the process list.
		const cmd = `npx wrangler pages secret put ${name} --project-name ${project}`;
		console.log(`\n$ ${cmd}`);
		try {
			execSync(cmd, { input: `${value}\n`, stdio: ['pipe', 'inherit', 'inherit'] });
		} catch {
			// allowFail
		}
	};
	putSecret('SETUP_TOKEN', setupToken);
	putSecret('CRON_SECRET', cronSecret);
	if (!useR2 && uploadThingToken) putSecret('UPLOADTHING_TOKEN', uploadThingToken);

	// 8. Offer to wire the fork's GitHub Actions secrets/vars so CI deploys work
	//    with no separate manual step. Only when gh is installed + authenticated,
	//    there is a GitHub origin, and the CLOUDFLARE_* values are in the env (if
	//    the operator used `wrangler login` there is no token value to pass on).
	const originUrl = run('git remote get-url origin', { capture: true, allowFail: true }).trim();
	const gh = ghSecretEligibility({
		ghInstalled: commandSucceeds('gh --version'),
		ghAuthenticated: commandSucceeds('gh auth status'),
		hasGithubOrigin: /github\.com/i.test(originUrl),
		apiToken: env.CLOUDFLARE_API_TOKEN,
		accountId: env.CLOUDFLARE_ACCOUNT_ID
	});
	let ciSecretsSet = false;
	if (gh.eligible) {
		const doIt = await askYesNo(
			'Set this repo\'s GitHub Actions secrets/vars for CI deploys (from your CLOUDFLARE_* env)?',
			false
		);
		if (doIt) {
			const ok = [
				ghSet('secret', 'CLOUDFLARE_API_TOKEN', env.CLOUDFLARE_API_TOKEN!),
				ghSet('secret', 'CLOUDFLARE_ACCOUNT_ID', env.CLOUDFLARE_ACCOUNT_ID!),
				ghSet('variable', 'CF_PAGES_PROJECT', project),
				ghSet('variable', 'D1_DATABASE_NAME', dbName)
			].every(Boolean);
			ciSecretsSet = ok;
			if (ok)
				console.log(
					'\n✔ CI secrets/variables set (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_PAGES_PROJECT, D1_DATABASE_NAME).'
				);
			else
				console.warn(
					'\n⚠ Some `gh` secret/variable commands failed — check `gh` auth/permissions and set them manually.'
				);
		}
	} else {
		console.log(`\nℹ Skipping GitHub Actions secret setup: ${gh.reason}.`);
		console.log(
			'  CI deploys need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID secrets and CF_PAGES_PROJECT'
		);
		console.log('  + D1_DATABASE_NAME variables (Settings → Secrets and variables → Actions).');
	}

	rl.close();

	console.log('\n──────────────────────────────────────────────');
	if (useR2 && r2Missing) {
		console.log('Storage backend: Cloudflare R2 — NOT READY (R2 is not enabled on this account).');
		console.log(`  Create the bucket, then re-run setup:  npx wrangler r2 bucket create ${bucket}`);
	} else {
		console.log(`Storage backend: ${provider === 'r2' ? 'Cloudflare R2' : 'UploadThing'} (set up).`);
	}
	console.log(
		`Fursuit photos: ${furtrackMode === 'off' ? 'disabled' : `enabled (${furtrackMode})`}${primaryCharacter ? ` — character "${primaryCharacter}"` : ''}.`
	);
	console.log('Migrations applied and recorded in schema_migrations (first CI deploy is a no-op).');
	console.log('\nNext steps:\n');
	console.log('  1. Deploy:  git push  (or `npx wrangler pages deploy .svelte-kit/cloudflare`)');
	console.log(`  2. Open  https://${project}.pages.dev/admin/setup  and finish in the wizard.`);
	if (useR2 && r2PublicUrl) {
		console.log(`  3. Point ${r2PublicUrl} at the bucket YOURSELF (setup did not touch DNS):`);
		console.log(
			`     Cloudflare dashboard → R2 → ${bucket} → Settings → Custom Domains → add ${r2PublicUrl},`
		);
		console.log('     then create the DNS record it prompts for. Images 404 until this is done.');
	}
	console.log('\n  Your one-time setup token (enter it in the wizard):\n');
	console.log(`     SETUP_TOKEN = ${setupToken}`);
	if (ciSecretsSet) {
		console.log('\n  CI deploy secrets/variables are set — pushing to main will deploy.');
	} else {
		console.log('\n  Before deploying via GitHub, set the CI secrets/variables (see the note above).');
	}
	console.log('  Verify bindings any time with:  npx wrangler pages project list  /  npx wrangler d1 list');
	console.log('  (CRON_SECRET set for the cron jobs; storageProvider seeded.)');
	console.log('──────────────────────────────────────────────\n');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
