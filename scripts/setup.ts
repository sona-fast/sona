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
import { execSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env, cwd } from 'node:process';
import { basename, join } from 'node:path';
import {
	buildMigrationSql,
	buildSeedSql,
	sanitizeProjectName,
	askResourceName,
	askUntilValid,
	derivedResourceName,
	isValidDatabaseId,
	isValidDatabaseName,
	writePrivateTempSql,
	removeTempSqlDir,
	runWith,
	type RunOpts,
	RESOURCE_NAME_RULE,
	DATABASE_NAME_RULE,
	DATABASE_ID_RULE,
	bucketCreateSucceeded,
	isR2NotEnabled,
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
	failureDetail,
	zoneLookupWarnLines,
	securitySummaryLines,
	storageSummaryLines,
	telegramSummaryLine,
	resendSecretWarnLines,
	setupTokenLines,
	provisioningNoteLine,
	pagesPatchConfirmsSitekey,
	cdnAttachmentLines
} from './setup-lib.ts';
import { resolveZone } from './connect-domains-lib.ts';
import { applyDownloadRateLimit, type RateLimitStatus } from './waf-lib.ts';
import {
	provisionTurnstileWidget,
	SCOPE_HINT as TURNSTILE_SCOPE_HINT,
	type TurnstileStatus
} from './turnstile-lib.ts';
// Shared with the admin Settings save so the seeded siteUrl passes the same
// https-URL validation (validate.ts has no imports, so tsx loads it directly).
import { normalizeHttpsUrl } from '../src/lib/server/validate.ts';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q: string, def: string) => {
	const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
	return a || def;
};
// Ask for a Cloudflare resource name, re-asking until the answer is usable. The
// loop itself lives in setup-lib (askResourceName) so it can be unit-tested; this
// is the binding that supplies the prompt, the TTY fact, and the wording.
const askName = (q: string, def: string): Promise<string | null> =>
	askResourceName(q, def, {
		ask,
		isInteractive: Boolean(stdin.isTTY),
		onReject: (answer) => {
			console.warn(`\n⚠ "${answer}" can't be used as a Cloudflare resource name.`);
			console.warn(`  Use ${RESOURCE_NAME_RULE}.`);
		}
	});
// D1 gets its own rule: a re-run is expected to point at a database that already
// exists, and an existing one may be named in a style the Pages/R2 rule forbids.
const askDbName = (q: string, def: string): Promise<string | null> =>
	askUntilValid(q, def, isValidDatabaseName, {
		ask,
		isInteractive: Boolean(stdin.isTTY),
		onReject: (answer) => {
			console.warn(`\n⚠ "${answer}" can't be used as a D1 database name.`);
			console.warn(`  Use ${DATABASE_NAME_RULE}.`);
		}
	});
const askYesNo = async (q: string, def = true) => {
	const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
	if (!a) return def;
	return a === 'y' || a === 'yes';
};

// A fixed command line, run through a shell. Only for commands that interpolate
// nothing — anything carrying an operator's answer goes through runArgs.
function run(cmd: string, opts: RunOpts = {}): string {
	console.log(`\n$ ${cmd}`);
	return runWith((stdio) => execSync(cmd, { stdio, encoding: 'utf8', env: opts.env }), opts);
}

// run()'s contract, but the command is an argv array executed WITHOUT a shell.
// Every call that interpolates an operator's answer (project, database, bucket,
// a temp-file path) goes through here: as an argv element the answer reaches
// wrangler exactly as typed, where on a shell command line `$`, a backtick, a
// quote or a space would be expanded or split — silently, since wrangler would
// still succeed under the rewritten name while wrangler.toml records the raw one.
function runArgs(file: string, args: string[], opts: RunOpts = {}): string {
	console.log(`\n$ ${file} ${args.join(' ')}`);
	return runWith((stdio) => execFileSync(file, args, { stdio, encoding: 'utf8', env: opts.env }), opts);
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
// never printed (the token must not land in the console log). `repo` (owner/repo)
// is passed as `-R` because a fork has two remotes (origin + upstream sona) and
// a bare `gh secret set` errors with "multiple remotes detected".
function ghSet(kind: 'secret' | 'variable', name: string, value: string, repo: string): boolean {
	console.log(`\n$ gh ${kind} set ${name} -R ${repo}`);
	try {
		// execFileSync (no shell) so `repo`, derived from the git origin URL, is a
		// single argv element and can never be interpreted as a shell command.
		execFileSync('gh', [kind, 'set', name, '-R', repo], {
			input: value,
			stdio: ['pipe', 'inherit', 'inherit']
		});
		return true;
	} catch {
		return false;
	}
}

const token = () => randomBytes(32).toString('hex');

// The scope the Pages-project PATCH needs, named in a failure only when the
// status (401/403) proves that is the reason.
const PAGES_SCOPE_HINT = 'Account → Cloudflare Pages: Edit';

// The friend-facing API-token recipe, printed whenever a scope preflight fails so
// the operator knows exactly what to (re)create. Kept in one place so the CLI and
// the message stay in sync with README's "API token" section.
const TOKEN_RECIPE =
	'Create a Cloudflare API token (dash → My Profile → API Tokens → Create Token → Custom token) with:\n' +
	`    • ${PAGES_SCOPE_HINT}\n` +
	'    • Account → D1: Edit\n' +
	'    • Account → Workers R2 Storage: Edit\n' +
	`    • ${TURNSTILE_SCOPE_HINT}      (only with a custom domain; adds the admin-login bot check)\n` +
	'    • Zone → Zone: Read              (only with a custom domain; resolves the zone)\n' +
	'    • Zone → DNS: Edit               (only with a custom domain; needed later to attach the apex record)\n' +
	'    • Zone → WAF: Edit               (only with a custom domain; adds the public rate limit)\n' +
	'    • Zone → Zone Settings: Edit     (optional; lets setup enable image resizing for you)';

async function main() {
	console.log('— Sona setup —\n');
	console.log('Make sure you are logged in: `npx wrangler login` (or set CLOUDFLARE_API_TOKEN).\n');

	// The API token + account, when present, let setup do the few things wrangler
	// can't: attach Pages bindings and run the DNS / image-transform preflights.
	// Absent (i.e. `wrangler login`), those steps degrade to printed manual steps.
	const cfToken = env.CLOUDFLARE_API_TOKEN;
	const cfAccount = env.CLOUDFLARE_ACCOUNT_ID;

	// Preflight: confirm the credentials resolve BEFORE provisioning, so a bad or
	// expired token fails here with an actionable message instead of midway
	// through creating resources. `wrangler whoami` works for both `wrangler
	// login` and a CLOUDFLARE_API_TOKEN.
	// WRANGLER_LOG=warn|error|none in the operator's env suppresses wrangler's
	// info-level "You are logged in" banner, which tokenResolves keys off — that
	// would fail-closed on VALID creds. Drop it for this one invocation so the
	// banner always prints.
	const whoamiEnv = { ...env };
	delete whoamiEnv.WRANGLER_LOG;
	const whoami = run('npx wrangler whoami', { capture: true, allowFail: true, env: whoamiEnv });
	process.stdout.write(whoami);
	if (!tokenResolves(whoami)) {
		console.error('\n✖ Cloudflare credentials did not resolve (`wrangler whoami` failed).');
		console.error(
			'  Run `npx wrangler login`, or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, then re-run setup.\n'
		);
		console.error(TOKEN_RECIPE);
		// Non-zero so a wrapper/CI can detect the aborted setup (a bare `return`
		// from main() leaves exit 0, which reads as success).
		process.exitCode = 1;
		rl.close();
		return;
	}
	// A User API Token without User → User Details → Read authenticates fine but
	// can't read the account email, so wrangler prints "Unable to retrieve email".
	// That token still provisions everything — note it rather than aborting.
	if (/unable to (retrieve|fetch) email/i.test(whoami)) {
		console.log(
			"\nℹ Logged in, but this token can't read your account email (missing User → User Details → Read). That's fine for setup."
		);
	}

	if (existsSync('wrangler.toml')) {
		const overwrite = await askYesNo('wrangler.toml already exists. Overwrite it?', false);
		if (!overwrite) {
			console.log('Aborting so your existing wrangler.toml is preserved.');
			// Exit 0 (unlike the credential/DNS aborts): declining to overwrite is a
			// deliberate, successful no-op — not a failure a wrapper should flag.
			rl.close();
			return;
		}
	}

	// Storage backend is decided first (it needs a bucket / a token). The bucket is
	// created either way so the IMAGES binding is always valid and you can switch
	// to R2 later without re-provisioning.
	const useR2 = await askYesNo('Use Cloudflare R2 for image storage now? (otherwise UploadThing)', true);

	// The site's domain only seeds sensible defaults (the Pages project name, the
	// SITE_URL Actions variable the scheduled syncs POST to, and — on R2 — the
	// public/CDN URL). Setup does NOT configure DNS or attach a custom domain to
	// the bucket — that needs DNS-scoped access we don't ask for, so it stays a
	// manual step (called out in Next steps). Asked on BOTH storage paths: gating
	// it on R2 left UploadThing forks with SITE_URL pointing at pages.dev (#33).
	const domain = await ask("Your site's domain (e.g. taro.surf) — blank to skip", '');

	// Default the project name from the domain (the most meaningful identifier),
	// else the fork's directory, so a rename doesn't silently reuse the template's
	// `sona` resources; the operator can override.
	const defaultProject = sanitizeProjectName(domain || basename(cwd()));
	// The three names are validated as answered, not just as defaulted: they are
	// passed to wrangler AND written into wrangler.toml, and a name outside the
	// allowed shape would leave the two pointing at different resources.
	// Reached only when a rejected answer can't be re-asked, which without a TTY is
	// every rejected answer.
	const abortAnswer = (what: string, rule: string) => {
		console.error(
			`\n✖ Setup cannot use that ${what}, and this run is not interactive, so there is no way to ask again.`
		);
		console.error(`  Re-run in a terminal, or supply a ${what} that fits the rule: ${rule}.`);
		process.exitCode = 1;
		rl.close();
	};
	const project = await askName('Cloudflare Pages project name (lowercase, hyphenated)', defaultProject);
	if (project === null) return abortAnswer('name', RESOURCE_NAME_RULE);
	// The derived defaults are truncated to stay inside the rule — a name setup
	// itself would reject is not a default it may offer.
	const dbName = await askDbName('D1 database name', derivedResourceName(project, 'db'));
	if (dbName === null) return abortAnswer('database name', DATABASE_NAME_RULE);
	const bucket = await askName('R2 bucket name', derivedResourceName(project, 'images'));
	if (bucket === null) return abortAnswer('name', RESOURCE_NAME_RULE);

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

	// Base URL the scheduled sync workflows POST to. Use the custom domain when
	// the operator gave one, else the default Pages URL.
	const siteUrl = domain ? ensureUrlScheme(domain) : `https://${project}.pages.dev`;

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
		// 'live' with no character ships an empty/erroring public fursuit section
		// (nothing to import). Refuse by default; only proceed on explicit confirm,
		// otherwise fall back to mock until a character is set.
		if (furtrackMode === 'live' && !primaryCharacter) {
			console.warn(
				'\n⚠ Live FurTrack with no character means the public fursuit section ships empty/erroring.'
			);
			console.warn('  (Direct live API use also requires approval from FurTrack.)');
			const proceed = await askYesNo('Enable live FurTrack anyway with no character?', false);
			if (!proceed) {
				furtrackMode = 'mock';
				console.log(
					'  → Using mock demo data for now. Set a character later (admin Settings) and switch to live.'
				);
			}
		}
	}

	// Telegram sticker importing (optional). The stickers feature can import Telegram
	// sticker packs, which needs a Bot API token from @BotFather (set as the
	// TELEGRAM_BOT_TOKEN secret). Off by default; skip to leave it unset.
	console.log(
		'\nTelegram sticker import lets your site pull in Telegram sticker packs you want to host.'
	);
	let telegramBotToken = '';
	if (await askYesNo('Import Telegram sticker packs? (needs a bot token from @BotFather)', false)) {
		console.log(
			'  This bot token lets your site call the Telegram Bot API to download the packs you host.'
		);
		console.log(
			'  Without it, Telegram import stays hidden and only manual sticker upload is available.'
		);
		telegramBotToken = await ask('Telegram bot token (TELEGRAM_BOT_TOKEN)', '');
	}

	// Admin password recovery email (optional). The in-app "Forgot password" flow
	// sends a reset link via Resend; it needs a RESEND_API_KEY. Off by default —
	// without it, recovery is the `npm run reset-password` CLI. See README.
	console.log(
		'\nAdmin password recovery can email a reset link via Resend (https://resend.com).'
	);
	let resendApiKey = '';
	let resendFrom = '';
	if (await askYesNo('Enable "Forgot password" reset emails? (needs a Resend API key)', false)) {
		resendApiKey = await ask('Resend API key (RESEND_API_KEY)', '');
		console.log(
			'  Sender identity (RESEND_FROM), format "Name <you@yourdomain>". A custom domain'
		);
		console.log('  must be verified in your own Resend account first; blank uses Resend\'s shared sender.');
		resendFrom = await ask('Resend sender (RESEND_FROM)', '');
	}

	// 0. Custom-domain preflight (only when a domain was given). Checks (does not
	//    guarantee) DNS access for the zone — the Pages apex CNAME needs
	//    Zone → DNS: Edit, and without it the domain sticks `pending` with a confusing
	//    522 — and, while we have the zone, checks/enables Image Transformations
	//    (thumbnails/OG images are built via /cdn-cgi/image, which is off by default
	//    and per-zone). Runs before provisioning so a missing DNS scope surfaces
	//    early (as a warning the operator can override, since setup never writes DNS
	//    itself). `imageResizingOn`: true = on, false = off (couldn't enable),
	//    null = unknown/not checked.
	let imageResizingOn: boolean | null = null;
	// Public-endpoint WAF rate limit. Only meaningful when the fork
	// runs on a zone the operator controls — a *.pages.dev-only fork has no zone to
	// attach it to. Null = not attempted (no domain / no zone / no token).
	let downloadRateLimit: RateLimitStatus | null = null;
	// The human-readable reason behind a rate-limit 'error' — waf-lib names the
	// actual failure (scope, missing zone, HTTP error), and the summary should
	// repeat that instead of guessing at a cause.
	let downloadRateLimitDetail: string | null = null;
	// Admin-login Turnstile widget. Only meaningful with a custom
	// domain — a *.pages.dev-only fork isn't provisioned one. Its sitekey (public)
	// is set as a Pages var below and its secret as a Pages secret; the login page
	// enforces the challenge only when BOTH are present. null = not attempted
	// (no domain / no token); 'error' = provisioning failed — turnstileDetail
	// carries the actual reason (scope on 401/403, otherwise the HTTP status
	// or a partial body).
	let turnstileStatus: TurnstileStatus | null = null;
	// The human-readable reason behind a Turnstile 'error' — mirrors
	// downloadRateLimitDetail so the summary repeats turnstile-lib's real
	// failure instead of assuming a missing scope.
	let turnstileDetail: string | null = null;
	let turnstileSitekey = '';
	let turnstileSecret = '';
	// Whether the Pages-project PATCH (which carries TURNSTILE_SITEKEY) landed —
	// the summary reports the bot check as wired only when it did.
	let pagesConfigOk = false;
	// The RESOLVED zone's name — the parent zone for a subdomain host. Summary
	// lines that name the zone must use this, not the host (which for a
	// subdomain has no Cloudflare zone of its own).
	let resolvedZoneName: string | null = null;
	if (domain) {
		const host = hostFromDomain(domain);
		if (cfToken && cfAccount) {
			// A subdomain (sona.example.com) is served by the registrable zone
			// (example.com); the shared candidate walk tries the host then strips
			// leading labels, and aborts on a failed lookup so a 403 or transient
			// error is reported as what it is — not as "no zone".
			const {
				zone: preflightZone,
				zoneName: preflightZoneName,
				errorStatus: zoneLookupError,
				errors: zoneLookupErrors,
				failedName: zoneLookupFailedName
			} = await resolveZone(zoneNameCandidates(host), (name) =>
				cfApi(cfToken, `/zones?name=${encodeURIComponent(name)}`)
			);
			resolvedZoneName = preflightZoneName;
			const zoneId = preflightZone.id;
			if (zoneLookupError !== null) {
				// The reason (and whether a scope is named at all) is decided by the
				// status, in the shared helper — see zoneLookupWarnLines.
				for (const line of zoneLookupWarnLines(
					zoneLookupFailedName ?? host,
					zoneLookupError,
					zoneLookupErrors
				)) {
					console.warn(line);
				}
			} else if (!zoneId) {
				console.warn(
					`\n⚠ No Cloudflare zone found for ${host} — skipping the DNS / image-transform preflight.`
				);
				console.warn('  Add the domain to this Cloudflare account first if you want setup to check it.');
			} else {
				// DNS scope probe: listing records needs DNS access. A 401/403 means the
				// token can't even read DNS (and so can't write the apex CNAME later) —
				// but setup never writes DNS itself, and an operator attaching the domain
				// from the dashboard is fine, so warn + offer to continue rather than abort.
				const dnsProbe = await cfApi(cfToken, `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=1`);
				if (dnsProbeBlocksSetup(dnsProbe)) {
					console.warn(
						`\n⚠ Could not verify DNS access for ${host} (token lacks Zone → DNS: Read; attaching the apex CNAME later needs Zone → DNS: Edit).`
					);
					console.warn('  Setup only checks access — it never writes DNS itself. If you plan to attach');
					console.warn('  the domain from the Cloudflare dashboard, you can continue.');
					// Default to NO: pressing Enter (or a non-interactive run) aborts, so a
					// missing DNS scope fails fast instead of silently leaving the apex domain
					// stuck `pending` with a 522 after setup reports success.
					const proceed = await askYesNo('Continue setup anyway?', false);
					if (!proceed) {
						console.error(`\n${TOKEN_RECIPE}`);
						process.exitCode = 1;
						rl.close();
						return;
					}
				}
				// Image Transformations. Off by default, per-zone, and NOT grantable by
				// the deploy token — enable it if the token carries Zone → Zone Settings: Edit,
				// else leave imageResizingOn=null (unknown) and warn in Next steps.
				const ir = await cfApi(cfToken, `/zones/${encodeURIComponent(zoneId)}/settings/image_resizing`);
				let patchOk = false;
				if (ir.ok && !imageResizingIsOn(ir)) {
					const enabled = await cfApi(cfToken, `/zones/${encodeURIComponent(zoneId)}/settings/image_resizing`, {
						method: 'PATCH',
						body: { value: 'on' }
					});
					patchOk = enabled.ok;
				}
				imageResizingOn = imageResizingOutcome(ir, patchOk);

				// WAF rate limit for the anonymously-reachable /api paths (download
				// beacon + oEmbed provider — one rule, Free-plan cap). Non-fatal:
				// a token without Zone → WAF: Edit just yields an 'error'
				// result we warn about in Next steps — setup keeps going regardless.
				// Reuse the zone the preflight just resolved — no second candidate walk.
				const rateLimit = await applyDownloadRateLimit(cfToken, host, cfApi, zoneId);
				downloadRateLimit = rateLimit.status;
				downloadRateLimitDetail = rateLimit.detail;
				if (rateLimit.status === 'error') {
					console.warn(`\n⚠ Could not attach the public-endpoint rate-limit rule: ${rateLimit.detail}`);
				} else {
					console.log(`✔ Public-endpoint rate limit: ${rateLimit.detail}`);
				}
			}

			// Turnstile widget for the admin-login bot check. Account-
			// scoped, so — unlike the DNS / image-resizing checks above — it does NOT
			// need a resolved zone and runs even when the domain's DNS lives elsewhere.
			// Non-fatal: a token without Account → Turnstile: Edit just yields an
			// 'error' result we warn about in Next steps — setup keeps going regardless.
			const ts = await provisionTurnstileWidget(cfToken, cfAccount, host);
			turnstileStatus = ts.status;
			turnstileDetail = ts.detail;
			turnstileSitekey = ts.sitekey ?? '';
			turnstileSecret = ts.secret ?? '';
			if (ts.status === 'error') {
				console.warn(`\n⚠ Admin-login protection NOT set — ${ts.detail}`);
			} else {
				console.log(`✔ Admin-login Turnstile: ${ts.detail}`);
			}
		} else {
			console.warn(
				'\n⚠ A custom domain was given but CLOUDFLARE_API_TOKEN/ACCOUNT_ID are not in the env,'
			);
			console.warn('  so setup cannot preflight DNS access. Attaching the apex domain needs a token');
			console.warn('  with Zone → DNS: Edit (see README → custom domain).');
		}
	}

	// 1. Pages project (idempotent — ignore "already exists").
	runArgs('npx', ['wrangler', 'pages', 'project', 'create', project, '--production-branch', 'main'], {
		allowFail: true
	});

	// 2. D1 — create and capture the database_id from the printed config block.
	const d1Out = runArgs('npx', ['wrangler', 'd1', 'create', dbName], { capture: true, allowFail: true });
	process.stdout.write(d1Out);
	let dbId = parseDatabaseId(d1Out);
	if (!dbId) {
		// The pasted id lands in wrangler.toml verbatim, so it is held to the shape
		// parseDatabaseId itself extracts — a quote or a newline in the answer would
		// otherwise write arbitrary TOML into the generated config. A blank answer
		// still means "I don't have one", and falls through to the abort below.
		const pasted = await askUntilValid(
			'Could not auto-detect database_id — paste it from the output above',
			'',
			(answer) => answer === '' || isValidDatabaseId(answer),
			{
				ask,
				isInteractive: Boolean(stdin.isTTY),
				onReject: (answer) => {
					console.warn(`\n⚠ "${answer}" is not a database id. Expected ${DATABASE_ID_RULE}.`);
				}
			}
		);
		if (pasted === null) return abortAnswer('database id', DATABASE_ID_RULE);
		dbId = pasted;
	}
	// Still nothing: `wrangler d1 create` failed and no id was pasted, so we never
	// established that a database exists. Writing wrangler.toml and PATCHing the
	// Pages project with an empty database_id would print two ✔ lines for bindings
	// that point at nothing, and only blow up later in the migration step.
	if (!dbId) {
		console.error('\n✖ No D1 database_id — `wrangler d1 create` did not report one and none was pasted.');
		console.error('  Setup stopped rather than wire wrangler.toml and the Pages project to no database.');
		console.error('  Check the wrangler output above, then re-run setup.');
		process.exitCode = 1;
		rl.close();
		return;
	}

	// 3. R2 bucket — always create it so the IMAGES binding is valid. Detect the
	//    "R2 not enabled on this account" case (error 10042) rather than swallowing
	//    it as success and later claiming the R2 backend is set up.
	let r2CreateOk = true;
	const r2Out = runArgs('npx', ['wrangler', 'r2', 'bucket', 'create', bucket], {
		capture: true,
		allowFail: true,
		onFail: () => {
			r2CreateOk = false;
		}
	});
	process.stdout.write(r2Out);
	const r2Missing = isR2NotEnabled(r2Out);
	// Whether a bucket is actually there, from the create's own outcome — not from
	// the absence of one particular error string. An "already exists" failure on a
	// re-run counts as ready; a permission failure does not.
	const bucketReady = bucketCreateSucceeded(r2Out, r2CreateOk);
	if (r2Missing) {
		console.warn('\n⚠ R2 does not appear to be enabled on this Cloudflare account.');
		console.warn('  Enable it at dash.cloudflare.com → R2, then re-run setup');
		console.warn(`  (or run:  npx wrangler r2 bucket create ${bucket}).`);
		if (useR2)
			console.warn(`  Image uploads will NOT work until the bucket "${bucket}" exists.`);
	} else if (!bucketReady) {
		console.warn(`\n⚠ Could not create the R2 bucket "${bucket}" — see the wrangler output above.`);
		console.warn('  A token without Account → Workers R2 Storage: Edit fails exactly here.');
		console.warn(`  Create it, then re-run setup:  npx wrangler r2 bucket create ${bucket}`);
		if (useR2) console.warn('  Image uploads will NOT work until that bucket exists.');
	}

	// 4. Render wrangler.toml from the template.
	const tpl = readFileSync('wrangler.toml.example', 'utf8');
	// Function replacements throughout: a `$&`, `$1` or `$'` in an answer — the
	// pasted database_id is the one value no rule constrains — would otherwise be
	// read as a replacement pattern and silently rewrite the line it lands in.
	const toml = tpl
		.replace(/^name = ".*"/m, () => `name = "${project}"`)
		.replace(/database_name = ".*"/, () => `database_name = "${dbName}"`)
		.replace(/database_id = ".*"/, () => `database_id = "${dbId}"`)
		.replace(/bucket_name = ".*"/, () => `bucket_name = "${bucket}"`)
		.replace(/^FURTRACK_MODE = ".*"/m, () => `FURTRACK_MODE = "${furtrackMode}"`);
	writeFileSync('wrangler.toml', toml);
	console.log('\n✔ wrote wrangler.toml');

	// 4b. Attach the D1/R2 bindings + FURTRACK_MODE to the Pages PROJECT via the
	//     API. setup only wrote them to the gitignored wrangler.toml, which a
	//     CI-only deploy never sees — so without this the first `git push` deploy
	//     ships with no D1/R2 binding (a broken database). Needs the API token +
	//     account id; if they're absent (wrangler login) or the PATCH fails, fall
	//     back to a one-time local deploy that reads wrangler.toml.
	if (cfToken && cfAccount) {
		const payload = buildPagesConfigPayload({
			dbId,
			// Bind R2 only when a bucket is actually there — binding a name the create
			// never made ships a broken IMAGES binding on the first CI deploy.
			bucket: bucketReady ? bucket : '',
			// TURNSTILE_SITEKEY is public (rendered into the login page), so it rides
			// as a plain Pages var alongside FURTRACK_MODE. Its secret is set separately
			// as a Pages secret below. Absent when Turnstile wasn't provisioned.
			envVars: {
				FURTRACK_MODE: furtrackMode,
				...(turnstileSitekey ? { TURNSTILE_SITEKEY: turnstileSitekey } : {})
			}
		});
		const res = await cfApi(cfToken, `/accounts/${cfAccount}/pages/projects/${encodeURIComponent(project)}`, {
			method: 'PATCH',
			body: payload
		});
		// A 200 whose body dropped the sitekey must not read as wired — confirm the
		// PATCH persisted TURNSTILE_SITEKEY (skipped when no widget was provisioned).
		pagesConfigOk =
			res.ok && (!turnstileSitekey || pagesPatchConfirmsSitekey(res.result, turnstileSitekey));
		if (res.ok) {
			// Name only what was sent: the R2 binding is omitted when no bucket exists.
			console.log(
				`✔ attached D1${bucketReady ? '/R2' : ''} bindings + FURTRACK_MODE to the Pages project (CI deploys get working bindings).`
			);
		} else {
			// failureDetail keeps the reason honest per status — a thrown fetch says
			// the API did not respond instead of "(HTTP 0)", and only a 401/403 names
			// the scope. It reads the allowlisted code+message pairs, never the raw
			// errors body, which can echo account/project identifiers.
			console.warn(
				`\n⚠ Could not attach bindings to the Pages project via the API${failureDetail(res, PAGES_SCOPE_HINT)}`
			);
			console.warn('  Fix: run ONE local deploy with wrangler.toml present so the bindings attach:');
			console.warn('    npx wrangler pages deploy .svelte-kit/cloudflare');
			console.warn('  Until then, CI (git push) deploys will have no D1/R2 binding.');
		}
	} else {
		console.warn('\n⚠ Skipping Pages-project binding wiring (CLOUDFLARE_API_TOKEN/ACCOUNT_ID not in env).');
		console.warn('  Run ONE local deploy (reads wrangler.toml) so the D1/R2 bindings attach to the project:');
		console.warn('    npx wrangler pages deploy .svelte-kit/cloudflare');
		console.warn('  Otherwise a CI-only deploy ships without D1/R2 bindings (broken database).');
	}

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
	const migrations = writePrivateTempSql(combinedSql, 'sona-migrations-');
	try {
		runArgs('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', `--file=${migrations.path}`], {
			stdin: 'ignore'
		});
	} finally {
		removeTempSqlDir(migrations.dir);
	}

	// 6. Seed the storage provider so the app boots with the chosen backend (the
	//    wizard no longer asks; switching later is a migration in Settings). Also
	//    seed siteUrl (the canonical origin for outgoing-email links) from the same
	//    domain answer — only when a custom domain was given AND it normalizes to a
	//    valid https URL (same rule the admin Settings save enforces, so a bad value
	//    can't be stored here and then throw at email-send time). Blank/invalid leaves
	//    it unset so the app falls back to the request origin (the Pages URL) on its own.
	const siteUrlSeed = domain ? (normalizeHttpsUrl(ensureUrlScheme(domain)) ?? '') : '';
	const seed = buildSeedSql({
		provider,
		siteUrl: siteUrlSeed,
		// r2PublicUrl is '' unless R2 was chosen and a public URL was given.
		r2PublicUrl,
		// Seed the FurTrack character/tag the fursuit feature queries.
		primaryCharacter
	});
	// Tolerated failure, but not an ignored one: the summary says the provider was
	// seeded, and a failed execute leaves the app with no storage backend at boot.
	let seedOk = true;
	let seedDir = '';
	// Handed to wrangler in a file, like the migration step above, rather than on a
	// command line: the seed carries operator answers (the FurTrack character, the
	// site and CDN URLs), and buildSeedSql escapes them for SQL, not for a shell —
	// a `$`, a backtick or a quote in one would be expanded or split there while
	// the execute still exited 0 and seedOk stayed true.
	try {
		// The write is INSIDE the try: a full or unwritable tmpdir is one more way
		// the seed can fail, and it must degrade to seedOk=false like the rest. Left
		// outside, it would throw out of main() with D1, R2 and the Pages project
		// already created but SETUP_TOKEN and CRON_SECRET not yet set.
		const written = writePrivateTempSql(seed, 'sona-seed-');
		seedDir = written.dir;
		runArgs('npx', ['wrangler', 'd1', 'execute', dbName, '--remote', `--file=${written.path}`], {
			stdin: 'ignore'
		});
	} catch {
		seedOk = false;
		console.warn('\n⚠ Could not seed site_settings — the storage provider is not recorded yet.');
		console.warn('  Set it in admin Settings → Storage Provider after the first deploy.');
	} finally {
		if (seedDir) removeTempSqlDir(seedDir);
	}

	// 7. Generate + set secrets. SETUP_TOKEN gates the first-run wizard.
	const setupToken = token();
	const cronSecret = token();
	const putSecret = (name: string, value: string): boolean => {
		// Feed the value over stdin (never the command line or the log) so the
		// secret is not echoed to the console or exposed in the process list.
		// Returns whether the put succeeded — the summary must not claim a
		// security control is wired when the write silently failed.
		// argv, not a shell string, so the project name reaches wrangler as typed.
		const args = ['wrangler', 'pages', 'secret', 'put', name, '--project-name', project];
		console.log(`\n$ npx ${args.join(' ')}`);
		try {
			execFileSync('npx', args, { input: `${value}\n`, stdio: ['pipe', 'inherit', 'inherit'] });
			return true;
		} catch {
			return false; // allowFail
		}
	};
	// Keep every put's result: the summary below must report what actually landed,
	// not what we tried to write.
	const setupTokenSet = putSecret('SETUP_TOKEN', setupToken);
	const cronSecretSet = putSecret('CRON_SECRET', cronSecret);
	const uploadThingTokenSet =
		!useR2 && uploadThingToken ? putSecret('UPLOADTHING_TOKEN', uploadThingToken) : false;
	const telegramTokenSet = telegramBotToken ? putSecret('TELEGRAM_BOT_TOKEN', telegramBotToken) : false;
	// Optional, but a supplied value whose put failed can't stay silent — see
	// resendSecretWarnLines: the failure would otherwise show up as a dead reset
	// link months later.
	const resendFailed: string[] = [];
	if (resendApiKey && !putSecret('RESEND_API_KEY', resendApiKey)) resendFailed.push('RESEND_API_KEY');
	if (resendFrom && !putSecret('RESEND_FROM', resendFrom)) resendFailed.push('RESEND_FROM');
	// Turnstile secret for the admin-login siteverify. Server-only, so
	// it's a Pages secret (never a plain var); the public sitekey was set above.
	// The login check fails open without it, so remember whether the put landed.
	let turnstileSecretSet = false;
	if (turnstileSecret) turnstileSecretSet = putSecret('TURNSTILE_SECRET', turnstileSecret);

	// 8. Offer to wire the fork's GitHub Actions secrets/vars so CI deploys work
	//    with no separate manual step. Only when gh is installed + authenticated,
	//    there is a GitHub origin, and the CLOUDFLARE_* values are in the env (if
	//    the operator used `wrangler login` there is no token value to pass on).
	const originUrl = run('git remote get-url origin', { capture: true, allowFail: true }).trim();
	// One GitHub-origin parser: deriveRepoSlug is the source of truth, and
	// "has a GitHub origin" is simply "we could derive owner/repo from it". This
	// drops the old second regex (`/github\.com/`) and the defensive branch that
	// existed only for when the two disagreed.
	const repoSlug = deriveRepoSlug(originUrl);
	const gh = ghSecretEligibility({
		ghInstalled: commandSucceeds('gh --version'),
		ghAuthenticated: commandSucceeds('gh auth status'),
		hasGithubOrigin: repoSlug !== null,
		apiToken: env.CLOUDFLARE_API_TOKEN,
		accountId: env.CLOUDFLARE_ACCOUNT_ID
	});
	let ciSecretsSet = false;
	if (gh.eligible && repoSlug) {
		const doIt = await askYesNo(
			`Set ${repoSlug}'s GitHub Actions secrets/vars for CI deploys (from your CLOUDFLARE_* env)?`,
			false
		);
		if (doIt) {
			// -R repoSlug on every call: a fork has two remotes (origin + upstream
			// sona), so a bare `gh secret set` errors "multiple remotes detected".
			// The exact set (incl. CRON_SECRET as a repo secret so artist-sync.yml /
			// sticker-resync.yml authenticate, and FURTRACK_MODE — always, even 'off',
			// so a live→off re-run neutralizes a stale 'live') lives in ciWiringEntries.
			const entries = ciWiringEntries({
				apiToken: env.CLOUDFLARE_API_TOKEN!,
				accountId: env.CLOUDFLARE_ACCOUNT_ID!,
				cronSecret,
				setupToken,
				project,
				dbName,
				siteUrl,
				furtrackMode
			});
			const ok = entries.map((e) => ghSet(e.kind, e.name, e.value, repoSlug)).every(Boolean);
			ciSecretsSet = ok;
			if (ok)
				console.log(`\n✔ CI secrets/variables set (${entries.map((e) => e.name).join(', ')}).`);
			else
				console.warn(
					'\n⚠ Some `gh` secret/variable commands failed — check `gh` auth/permissions and set them manually.'
				);
		}
	} else {
		console.log(`\nℹ Skipping GitHub Actions secret setup: ${gh.reason}.`);
		console.log(
			'  CI deploys need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + CRON_SECRET + SETUP_TOKEN'
		);
		console.log(
			'  secrets and CLOUDFLARE_PAGES_PROJECT, D1_DATABASE_NAME, SITE_URL, FURTRACK_MODE variables'
		);
		console.log('  (Settings → Secrets and variables → Actions).');
	}

	rl.close();

	console.log('\n──────────────────────────────────────────────');
	for (const line of storageSummaryLines({
		provider,
		r2Missing,
		bucketReady,
		uploadThingTokenSet,
		bucket,
		project
	})) {
		console.log(line);
	}
	console.log(
		`Fursuit photos: ${furtrackMode === 'off' ? 'disabled' : `enabled (${furtrackMode})`}${primaryCharacter ? ` — character "${primaryCharacter}"` : ''}.`
	);
	console.log(telegramSummaryLine(Boolean(telegramBotToken), telegramTokenSet));
	for (const line of resendSecretWarnLines(resendFailed, project)) console.warn(line);
	console.log('Migrations applied and recorded in schema_migrations (first CI deploy is a no-op).');
	console.log('\nNext steps:\n');
	console.log('  1. Deploy:  git push  (or `npx wrangler pages deploy .svelte-kit/cloudflare`)');
	console.log(`  2. Open  https://${project}.pages.dev/admin/setup  and finish in the wizard.`);
	if (useR2 && r2PublicUrl) {
		for (const line of cdnAttachmentLines(r2PublicUrl, bucket, domain)) {
			console.log(line);
		}
	}
	if (domain) {
		const host = hostFromDomain(domain);
		console.log(`  • Custom domain ${host}: after adding it to the Pages project, the APEX needs a`);
		console.log(`     manual proxied CNAME  ${host} → ${project}.pages.dev  (unlike the R2 domain,`);
		console.log('     which wrangler wires itself). Without it the domain sticks pending with a 522.');
		// Image Transformations (thumbnails/OG). off by default, per-zone; can't be
		// enabled by the deploy token. imageResizingOn: true (on), false (still off),
		// null (couldn't check — token lacks Zone Settings:Read).
		// Zone-wide setting: name the RESOLVED zone (the parent for a subdomain),
		// which is where the dashboard path actually lives.
		const zoneName = resolvedZoneName ?? host;
		if (imageResizingOn === true) {
			console.log(`  • Image Transformations: enabled on the ${zoneName} zone (thumbnails will resize).`);
			// Enabling the zone setting does NOT enable "Resize images from any origin",
			// which a cross-zone source (e.g. an R2 public URL on another zone) needs.
			console.log('     If images load from another zone/origin (e.g. an R2 public URL), also turn on');
			console.log(`     "Resize images from any origin":  dashboard → ${zoneName} → Images → Transformations.`);
		} else {
			console.log('  • Image Transformations (thumbnails/OG images) is OFF or unverified. Enable it:');
			console.log(`     dashboard → ${zoneName} → Images → Transformations → "Enable for zone" +`);
			console.log('     "Resize images from any origin". Free tier: 5,000 transformations/month.');
			console.log('     Until on, gallery thumbnails serve the full-size original (slow) or 404.');
		}
		// Zone security: rate limit + admin-login Turnstile.
		for (const line of securitySummaryLines({
			host,
			downloadRateLimit,
			downloadRateLimitDetail,
			turnstileStatus,
			turnstileDetail,
			turnstileWired: pagesConfigOk && turnstileSecretSet,
			zoneName: resolvedZoneName
		})) {
			console.log(line);
		}
	}
	for (const line of setupTokenLines({ setupToken, setupTokenSet, project })) {
		console.log(line);
	}
	if (ciSecretsSet) {
		console.log('\n  CI deploy secrets/variables are set — pushing to main will deploy.');
	} else {
		console.log('\n  Before deploying via GitHub, set the CI secrets/variables (see the note above).');
	}
	console.log('  Verify bindings any time with:  npx wrangler pages project list  /  npx wrangler d1 list');
	console.log(provisioningNoteLine(cronSecretSet, seedOk));
	console.log('──────────────────────────────────────────────\n');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
