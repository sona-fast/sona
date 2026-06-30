#!/usr/bin/env tsx
/**
 * Sona setup CLI — provisions the Cloudflare side of a fork.
 *
 *   npm run setup
 *
 * It creates the Pages project, D1 database, and (optionally) an R2 bucket;
 * writes `wrangler.toml` from the template; applies migrations; and generates +
 * sets the SETUP_TOKEN and CRON_SECRET secrets. Branding, theme, and the admin
 * password are NOT set here — you do those in the in-app first-run wizard at
 * /admin/setup after deploying.
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

function token(bytes = 32): string {
	return randomBytes(bytes).toString('hex');
}

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
	const useR2 = await askYesNo('Use Cloudflare R2 for image storage? (otherwise UploadThing)', true);
	const bucket = useR2 ? await ask('R2 bucket name', `${project}-images`) : `${project}-images`;

	// 1. Pages project (idempotent — ignore "already exists").
	run(`npx wrangler pages project create ${project} --production-branch main`, { allowFail: true });

	// 2. D1 — create and capture the database_id from the printed config block.
	const d1Out = run(`npx wrangler d1 create ${dbName}`, { capture: true, allowFail: true });
	process.stdout.write(d1Out);
	let dbId = (d1Out.match(/database_id\s*=\s*"([0-9a-fA-F-]+)"/) || [])[1] ?? '';
	if (!dbId) {
		dbId = await ask('Could not auto-detect database_id — paste it from the output above', '');
	}

	// 3. R2 bucket (optional).
	if (useR2) run(`npx wrangler r2 bucket create ${bucket}`, { allowFail: true });

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

	// 6. Generate + set secrets. SETUP_TOKEN gates the first-run wizard.
	const setupToken = token();
	const cronSecret = token();
	const putSecret = (name: string, value: string) =>
		run(`echo "${value}" | npx wrangler pages secret put ${name} --project-name ${project}`, {
			allowFail: true
		});
	putSecret('SETUP_TOKEN', setupToken);
	putSecret('CRON_SECRET', cronSecret);

	rl.close();

	console.log('\n──────────────────────────────────────────────');
	console.log('Setup (almost) done. Next steps:\n');
	console.log('  1. Deploy:  git push  (or `npx wrangler pages deploy .svelte-kit/cloudflare`)');
	if (!useR2) {
		console.log('  2. Set your UploadThing token:');
		console.log(`       npx wrangler pages secret put UPLOADTHING_TOKEN --project-name ${project}`);
	}
	console.log(`  ${useR2 ? 2 : 3}. Open  https://${project}.pages.dev/admin/setup  and finish in the wizard.`);
	console.log('\n  Your one-time setup token (enter it in the wizard):\n');
	console.log(`     SETUP_TOKEN = ${setupToken}`);
	console.log('\n  (CRON_SECRET was generated + set for the sticker re-sync cron.)');
	console.log('──────────────────────────────────────────────\n');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
