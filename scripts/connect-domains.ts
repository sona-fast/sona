#!/usr/bin/env tsx
/**
 * Sona connect-domains — the re-runnable step that attaches the app's OWN custom
 * domains once the zone is live in Cloudflare.
 *
 *   npm run connect-domains -- <domain>            # attach cdn.<domain> → bucket + <domain> → Pages
 *   npm run connect-domains -- <domain> --yes      # same, no confirmation prompt (CI/non-interactive)
 *   npm run connect-domains -- --check <domain>    # doctor mode: read-only health ladder, zero mutations
 *
 * Split out of first-run `npm run setup` because zone activation can lag
 * nameserver propagation by hours — this must run AFTER the zone is active. It
 * makes exactly two mutations (the R2 custom domain + the Pages custom domain)
 * plus, with the scope, enabling Image Transformations — a ZONE-WIDE setting on
 * the resolved zone (for a subdomain host that's the parent zone serving it);
 * each is idempotent and beyond those nothing else in the zone is touched. The
 * API token comes from
 * CLOUDFLARE_API_TOKEN (Zone → Zone: Read + Zone → DNS: Edit, plus Zone → Zone Settings: Edit to enable
 * Image Transformations for you); it is read from the env, never stored or
 * printed.
 *
 * Non-interactive safety: it never blocks on a prompt. With no TTY it requires
 * `--yes` to mutate (otherwise it aborts), and doctor mode never prompts at all
 * (the domain must be a positional argument).
 *
 * Prerequisites: the domain must already be an ACTIVE zone in the account, and
 * `npm run setup` must have written wrangler.toml (project + bucket names).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env, argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	cfApi,
	cfErrorSummary,
	failureDetail,
	hostFromDomain,
	zoneNameCandidates,
	imageResizingOutcome,
	type CfApiResult
} from './setup-lib.ts';
import {
	cdnHost,
	parseWranglerConfig,
	classifyZone,
	zoneGuidance,
	resolveZone,
	zoneConsentLabel,
	cdnDomainState,
	bucketDomainTlsIssued,
	pagesDomainState,
	classifyCdnProbe,
	domainReadFailure,
	planConnect,
	siteUrlMismatch,
	buildLadder,
	renderLadder,
	type CdnDomainState,
	type CdnProbe
} from './connect-domains-lib.ts';

const TOKEN_RECIPE =
	'Create a Cloudflare API token (dash → My Profile → API Tokens → Create Token → Custom token) with:\n' +
	'    • Zone → Zone: Read\n' +
	'    • Zone → DNS: Edit\n' +
	'    • Account → Workers R2 Storage: Edit   (to attach the bucket custom domain)\n' +
	'    • Account → Cloudflare Pages: Edit     (to attach the site domain)\n' +
	'    • Zone → Zone Settings: Edit           (optional; lets it enable Image Transformations)\n' +
	'Then export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID and re-run.';

/** Best-effort read of the deployed `siteUrl` site-setting (forward-compat with SONA-24). */
function readSiteUrlSetting(dbName: string): string | null {
	try {
		// execFile with an argv array (not a shell string) so the db name is a
		// literal argument — never interpolated into a shell command line.
		const out = execFileSync(
			'npx',
			[
				'wrangler',
				'd1',
				'execute',
				dbName,
				'--remote',
				'--json',
				'--command',
				"SELECT value FROM site_settings WHERE key='siteUrl'"
			],
			{ stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
		);
		const parsed = JSON.parse(out) as { results?: { value?: string }[] }[];
		return parsed?.[0]?.results?.[0]?.value ?? null;
	} catch {
		return null; // setting absent, older schema, or no D1 access — skip the rung
	}
}

async function main(): Promise<number> {
	const check = argv.includes('--check');
	const yes = argv.includes('--yes') || argv.includes('-y');
	const interactive = !!stdin.isTTY;
	const positional = argv.slice(2).filter((a) => !a.startsWith('-'));

	console.log(`— Sona connect-domains${check ? ' (doctor)' : ''} —\n`);

	const cfToken = env.CLOUDFLARE_API_TOKEN;
	const cfAccount = env.CLOUDFLARE_ACCOUNT_ID;
	if (!cfToken || !cfAccount) {
		console.error('✖ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment.\n');
		console.error(TOKEN_RECIPE);
		return 1;
	}

	if (!existsSync('wrangler.toml')) {
		console.error('✖ wrangler.toml not found — run `npm run setup` first (it writes the project + bucket).');
		return 1;
	}
	const toml = readFileSync('wrangler.toml', 'utf8');
	const { project, bucket } = parseWranglerConfig(toml);
	const dbName = toml.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? '';

	// Resolve the domain WITHOUT ever blocking on a prompt in a non-interactive
	// shell (the CI-hang guard). Doctor mode never prompts — the domain must be
	// a positional argument.
	let domainInput = positional[0] ?? '';
	if (!domainInput) {
		if (check) {
			console.error('✖ Doctor mode needs the domain as an argument:');
			console.error('    npm run connect-domains -- --check <domain>');
			return 1;
		}
		if (!interactive) {
			console.error('✖ No domain given. Pass it as an argument (non-interactive shell):');
			console.error('    npm run connect-domains -- <domain> --yes');
			return 1;
		}
	}

	const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
	try {
		if (!domainInput && rl) domainInput = await rl.question("Your site's domain (e.g. taro.surf): ");
		const host = hostFromDomain(domainInput);
		if (!host) {
			console.error('✖ No domain given.');
			return 1;
		}
		const cdn = cdnHost(host);

		// Zone lookup (account-scoped by the token). A subdomain like
		// sona.example.com is served by the example.com zone, so walk the candidate
		// zone names most-specific-first instead of one exact lookup. A 401/403 is
		// a hard token error; any other failed lookup aborts too (a transient error
		// must not silently pick the parent zone or read as "no zone").
		const candidates = zoneNameCandidates(host);
		const { zone, zoneName, errorStatus, errors, failedName } = await resolveZone(
			candidates,
			(name) => cfApi(cfToken, `/zones?name=${encodeURIComponent(name)}`)
		);
		if (errorStatus !== null) {
			// Name the candidate whose lookup failed — for a subdomain host that can
			// be the parent zone, and pointing at the host would mislead.
			const lookupName = failedName ?? host;
			if (errorStatus === 401 || errorStatus === 403) {
				console.error(`✖ The API token cannot read zones (HTTP ${errorStatus}).\n`);
				console.error(TOKEN_RECIPE);
			} else if (errorStatus === 0) {
				console.error(
					`✖ Could not reach the Cloudflare API while looking up the zone for ${lookupName} — check your network and re-run.`
				);
			} else {
				// The API answered and the lookup still failed — repeat its own reason
				// whenever it gave one. A 400/404/500 body carries that reason as often
				// as a 2xx-with-success:false does, and gating the summary on 2xx threw
				// it away for exactly the statuses an operator can least explain.
				const apiWhy = cfErrorSummary(errors);
				console.error(
					`✖ Cloudflare API error (HTTP ${errorStatus}${apiWhy ? `; the API said ${apiWhy}` : ''}) while looking up the zone for ${lookupName} — wait a moment and re-run.`
				);
			}
			return 1;
		}

		if (check) {
			return await runDoctor({ cfToken, cfAccount, bucket, host, cdn, zone, zoneName, candidates, dbName });
		}

		// --- mutating mode -------------------------------------------------------
		const guidance = zoneGuidance(zone, host, candidates, zoneName);
		if (guidance) {
			console.log(`ℹ ${guidance}`);
			return 0; // fail soft — the registrar/propagation step is the operator's
		}

		// Current attachment state (idempotency + honest disabled/unverifiable handling).
		const r2Res = await cfApi(cfToken, `/accounts/${cfAccount}/r2/buckets/${bucket}/domains/custom`);
		const pagesRes = await cfApi(cfToken, `/accounts/${cfAccount}/pages/projects/${project}/domains`);
		const cdnState = cdnDomainState(r2Res, cdn);
		const pagesState = pagesDomainState(pagesRes, host);

		if (cdnState === 'disabled')
			console.warn(
				`⚠ ${cdn} is already on the bucket but DISABLED — re-enable it in dashboard → R2 → ${bucket} → Custom Domains (not re-creating it).`
			);
		if (cdnState === 'unknown')
			// The reason comes from the response, not from a guess: naming the R2 read
			// scope for a 500 or an unreachable API sends the operator to re-mint a
			// token that was never the problem.
			console.warn(
				`⚠ Couldn't read the bucket's custom domains${domainReadFailure(
					r2Res,
					'Account → Workers R2 Storage: Read'
				)} — skipping the ${cdn} attach.`
			);

		if (pagesState === 'unknown')
			// Same discipline as the R2 path: the read that failed is the one that
			// would have told us whether the attach is needed, so we don't attach.
			// Posting it anyway would be mutating on state we never managed to read.
			console.warn(
				`⚠ Couldn't read the ${project} Pages project's domains${domainReadFailure(
					pagesRes,
					'Account → Cloudflare Pages: Read'
				)} — skipping the ${host} attach.`
			);

		const plan = planConnect({
			accountId: cfAccount,
			bucket,
			project,
			host,
			zoneId: zone.id ?? '',
			cdnPresent: cdnState !== 'absent',
			pagesPresent: pagesState !== 'absent'
		});

		// Image Transformations current state (read-only), so the preview can honestly
		// disclose the enablement as one of the changes the single confirm covers.
		const irGet = await cfApi(cfToken, `/zones/${zone.id}/settings/image_resizing`);
		const transformsCurrent = imageResizingOutcome(irGet, false); // true | false | null
		const willEnableTransforms = transformsCurrent === false;

		if (plan.length === 0 && !willEnableTransforms) {
			// "Already connected" is a claim about state we read. When either read
			// failed, an empty plan means we declined to act, not that the domains
			// are in place — say which one it was.
			const unread = cdnState === 'unknown' ? cdn : pagesState === 'unknown' ? host : null;
			console.log(
				unread
					? `ℹ Nothing changed — the ${unread} attachment couldn't be read, so nothing was created.`
					: `✔ Already connected: ${cdn} → ${bucket} bucket and ${host} → ${project} Pages.`
			);
			console.log(
				transformsCurrent === true
					? '  Image Transformations: on.'
					: `  Image Transformations: couldn't verify${failureDetail(irGet, 'Zone → Zone Settings: Read')}.`
			);
			console.log(`  Re-check anytime:  npm run connect-domains -- --check ${host}`);
			return 0;
		}

		// Preview EVERY change the confirm covers (records AND the zone setting), so
		// the one prompt is honest about what it does. Consent and success lines
		// name the RESOLVED zone (the parent zone for a subdomain host) because the
		// Image Transformations toggle is zone-wide on it.
		const zoneLabel = zoneConsentLabel(host, zoneName);
		console.log(
			`This will make the following changes to your account and ${zoneLabel}, and nothing else:`
		);
		for (const m of plan) console.log(`  • ${m.label}`);
		if (willEnableTransforms)
			console.log(
				`  • enable Image Transformations on the ${zoneName ?? host} zone${
					zoneName && zoneName !== host ? ` — this affects the whole zone, not just ${host}` : ''
				}`
			);

		let proceed = yes;
		if (!proceed) {
			if (!interactive || !rl) {
				console.error(
					'\n✖ Refusing to change DNS without confirmation. Re-run with --yes to proceed non-interactively.'
				);
				return 1;
			}
			const go = (await rl.question('\nApply these changes now? [y/N]: ')).trim().toLowerCase();
			proceed = go === 'y' || go === 'yes';
		}
		if (!proceed) {
			console.log('Aborted — nothing changed.');
			return 0;
		}

		for (const m of plan) {
			const res = await cfApi(cfToken, m.path, { method: m.method, body: m.body });
			if (res.ok) console.log(`✔ ${m.label}`);
			else
				// failureDetail keeps the reason honest per status: the call's own scope
				// on 401/403, the API's sanitized words when it gave any, and the
				// did-not-respond line for a thrown fetch (where a bare "HTTP 0" said
				// nothing at all).
				console.warn(
					`⚠ Could not ${m.label}${failureDetail(res, m.scopeHint)}`
				);
		}

		if (willEnableTransforms) {
			const patched = await cfApi(cfToken, `/zones/${zone.id}/settings/image_resizing`, {
				method: 'PATCH',
				body: { value: 'on' }
			});
			if (patched.ok) console.log(`✔ Image Transformations enabled on ${zoneLabel}.`);
			else
				console.warn(
					`⚠ Could not enable Image Transformations${failureDetail(patched, 'Zone → Zone Settings: Edit')} — enable it in the dashboard.`
				);
		} else if (transformsCurrent === true) {
			console.log('✔ Image Transformations already on.');
		} else {
			console.log(
				`⚠ Image Transformations: couldn't verify${failureDetail(irGet, 'Zone → Zone Settings: Read')} — enable it in the dashboard.`
			);
		}

		console.log('\nCertificates provision in the background (usually a few minutes).');
		console.log(`Verify anytime:  npm run connect-domains -- --check ${host}`);
		return 0;
	} finally {
		rl?.close();
	}
}

export interface DoctorArgs {
	cfToken: string;
	cfAccount: string;
	bucket: string;
	host: string;
	cdn: string;
	zone: ReturnType<typeof classifyZone>;
	/** The RESOLVED zone's name (the parent zone for a subdomain host); null when no zone matched. */
	zoneName?: string | null;
	/** The zone names the lookup tried, most specific first. */
	candidates?: string[];
	dbName: string;
}

export interface DoctorDeps {
	api: (
		token: string,
		path: string,
		init?: { method?: string; body?: unknown }
	) => Promise<CfApiResult>;
	/** HTTPS-probe cdn.<domain>/, returning the HTTP status (0 on a thrown fetch). */
	probeCdn: (cdn: string) => Promise<number>;
	readSiteUrl: (dbName: string) => string | null;
}

const defaultDoctorDeps: DoctorDeps = {
	api: cfApi,
	probeCdn: async (cdn) => {
		try {
			return (await fetch(`https://${cdn}/`, { method: 'HEAD' })).status;
		} catch {
			return 0;
		}
	},
	readSiteUrl: readSiteUrlSetting
};

/**
 * Read-only health ladder. Issues only GET requests (mutation discipline — the
 * doctor NEVER writes). Returns 0 even when rungs fail; nonzero is reserved for
 * hard API/auth errors surfaced by the caller. Dependencies are injected so the
 * probe path is unit-testable (secret-free output + zero-mutation assertions).
 */
export async function runDoctor(a: DoctorArgs, deps: DoctorDeps = defaultDoctorDeps): Promise<number> {
	let cdnState: CdnDomainState = 'unknown';
	let tlsIssued: boolean | null = null;
	let transforms: boolean | null = null;
	let cdnLoad: CdnProbe = 'unreachable';
	// Left undefined when the zone is unusable and the reads never ran — a rung
	// then says "couldn't verify" with no cause, rather than inventing one.
	let r2Read: CfApiResult | undefined;
	let irRead: CfApiResult | undefined;

	if (zoneUsable(a.zone)) {
		const r2Res = await deps.api(a.cfToken, `/accounts/${a.cfAccount}/r2/buckets/${a.bucket}/domains/custom`);
		r2Read = r2Res;
		cdnState = cdnDomainState(r2Res, a.cdn);
		tlsIssued = cdnState === 'attached' ? bucketDomainTlsIssued(r2Res.result, a.cdn) : null;

		const ir = await deps.api(a.cfToken, `/zones/${a.zone.id}/settings/image_resizing`);
		irRead = ir;
		transforms = imageResizingOutcome(ir, false);

		// Independent HTTPS probe (not via the API) — informative even when the token
		// can't read the R2 config.
		cdnLoad = classifyCdnProbe(await deps.probeCdn(a.cdn));
	}

	const ladder = buildLadder({
		host: a.host,
		zoneExists: a.zone.exists,
		zoneActive: a.zone.active,
		zoneName: a.zoneName,
		candidates: a.candidates,
		cdnState,
		cdnRead: r2Read,
		tlsIssued,
		imageTransforms: transforms,
		imageTransformsStatus: irRead?.status,
		imageTransformsErrors: irRead?.errors,
		cdnLoad
	});
	for (const line of renderLadder(ladder)) console.log(line);

	// Forward-compatible rung: warn when the deployed siteUrl points elsewhere.
	if (a.dbName) {
		const sm = siteUrlMismatch(deps.readSiteUrl(a.dbName), a.host);
		if (sm.checked && sm.mismatch)
			console.log(
				`\n⚠ Deployed siteUrl host (${sm.settingHost}) doesn't match ${a.host} — ` +
					'update it in admin Settings so canonical/OG links use this domain.'
			);
	}

	// Exit 0 even when rungs fail; the ladder is diagnostic state to act on, not a
	// failure of the command itself (nonzero is reserved for hard API/auth errors).
	return 0;
}

const zoneUsable = (z: ReturnType<typeof classifyZone>) => z.exists && z.active && !!z.id;

// Only run when invoked directly, so the unit tests can import runDoctor + helpers.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	main()
		.then((code) => exit(code ?? 0))
		.catch((err) => {
			console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
			exit(1);
		});
}
