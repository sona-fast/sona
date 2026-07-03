#!/usr/bin/env tsx
/**
 * Sona setup CLI — provisions the Cloudflare side of a fork AND decides the image
 * storage backend (the one place that can create a bucket / set a token).
 *
 *   npm run setup
 *
 * It creates the Pages project, D1 database, and R2 bucket; picks the storage
 * provider (R2 or UploadThing) and wires its secret/URL; writes `wrangler.toml`;
 * applies migrations; seeds storageProvider; and generates + sets SETUP_TOKEN and
 * CRON_SECRET. Branding, theme, and the admin password are set afterward in the
 * in-app first-run wizard at /admin/setup. To switch storage later, use
 * Settings → Storage Provider (which sets up the new token/bucket + migrates).
 *
 * Prerequisites: `wrangler login` (or CLOUDFLARE_API_TOKEN) must be set up first.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

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

function run(cmd: string, opts: { capture?: boolean; allowFail?: boolean } = {}): string {
	console.log(`\n$ ${cmd}`);
	try {
		const out = execSync(cmd, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
		return out ?? '';
	} catch (err) {
		if (opts.allowFail) return '';
		throw err;
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

	const project = await ask('Cloudflare Pages project name (lowercase, hyphenated)', 'sona');
	const dbName = await ask('D1 database name', `${project}-db`);
	const bucket = await ask('R2 bucket name', `${project}-images`);

	// Storage backend is decided here (it needs a bucket / a token). The bucket is
	// created either way so the IMAGES binding is always valid and you can switch
	// to R2 later without re-provisioning.
	const useR2 = await askYesNo('Use Cloudflare R2 for image storage now? (otherwise UploadThing)', true);
	const r2PublicUrl = useR2
		? await ask("R2 public URL (the bucket's custom domain; blank to set later)", '')
		: '';
	const uploadThingToken = useR2 ? '' : await ask('UploadThing token (UPLOADTHING_TOKEN)', '');
	const provider = useR2 ? 'r2' : 'uploadthing';

	// 1. Pages project (idempotent — ignore "already exists").
	run(`npx wrangler pages project create ${project} --production-branch main`, { allowFail: true });

	// 2. D1 — create and capture the database_id from the printed config block.
	const d1Out = run(`npx wrangler d1 create ${dbName}`, { capture: true, allowFail: true });
	process.stdout.write(d1Out);
	let dbId = (d1Out.match(/database_id\s*=\s*"([0-9a-fA-F-]+)"/) || [])[1] ?? '';
	if (!dbId) dbId = await ask('Could not auto-detect database_id — paste it from the output above', '');

	// 3. R2 bucket — always create it so the IMAGES binding is valid.
	run(`npx wrangler r2 bucket create ${bucket}`, { allowFail: true });

	// 4. Render wrangler.toml from the template.
	const tpl = readFileSync('wrangler.toml.example', 'utf8');
	const toml = tpl
		.replace(/^name = ".*"/m, `name = "${project}"`)
		.replace(/database_name = ".*"/, `database_name = "${dbName}"`)
		.replace(/database_id = ".*"/, `database_id = "${dbId}"`)
		.replace(/bucket_name = ".*"/, `bucket_name = "${bucket}"`);
	writeFileSync('wrangler.toml', toml);
	console.log('\n✔ wrote wrangler.toml');

	// 5. Apply D1 migrations (remote).
	const migrations = run('ls drizzle/*.sql', { capture: true })
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const f of migrations) {
		run(`npx wrangler d1 execute ${dbName} --remote --file="${f}"`, { allowFail: true });
	}

	// 6. Seed the storage provider so the app boots with the chosen backend (the
	//    wizard no longer asks; switching later is a migration in Settings).
	let seed = `INSERT OR REPLACE INTO site_settings (key,value) VALUES ('storageProvider','${provider}')`;
	if (useR2 && r2PublicUrl) seed += `, ('r2PublicUrl','${sqlStr(r2PublicUrl)}')`;
	seed += ';';
	run(`npx wrangler d1 execute ${dbName} --remote --command "${seed}"`, { allowFail: true });

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

	rl.close();

	console.log('\n──────────────────────────────────────────────');
	console.log(`Storage backend: ${provider === 'r2' ? 'Cloudflare R2' : 'UploadThing'} (set up).`);
	console.log('Next steps:\n');
	console.log('  1. Deploy:  git push  (or `npx wrangler pages deploy .svelte-kit/cloudflare`)');
	console.log(`  2. Open  https://${project}.pages.dev/admin/setup  and finish in the wizard.`);
	console.log('\n  Your one-time setup token (enter it in the wizard):\n');
	console.log(`     SETUP_TOKEN = ${setupToken}`);
	console.log('\n  (CRON_SECRET set for the cron jobs; storageProvider seeded.)');
	console.log('──────────────────────────────────────────────\n');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
