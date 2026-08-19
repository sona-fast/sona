#!/usr/bin/env tsx
/**
 * Sona apply-download-ratelimit — standalone runner that applies the WAF
 * rate-limit rule protecting the anonymously-reachable /api paths (the download
 * beacon and the oEmbed provider) to an EXISTING fork's zone. New forks get the
 * rule automatically during `npm run setup`; this is the one-off for forks that
 * were already deployed.
 *
 *   CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>
 *
 * The token comes from the environment (never an argv, so it can't land in shell
 * history or a process listing) and is read, used as a Bearer header, and never
 * printed. The domain is the fork's site domain (e.g. akito.dog); scheme/path are
 * stripped. The operation is idempotent — re-running on an already-protected zone
 * is a no-op. Exit 0 on created/updated/exists, 1 on error.
 *
 * Token scope required: Zone → WAF: Edit, on a token whose Zone Resources
 * include the fork's domain. (Read-only Zone·Read is enough to resolve the
 * zone, but writing the rule needs WAF: Edit.)
 */
import { env, argv, exit } from 'node:process';
import { applyDownloadRateLimit, isPermissionError } from './waf-lib.ts';

const TOKEN_RECIPE =
	'Set CLOUDFLARE_API_TOKEN to a Cloudflare API token (dash → My Profile → API Tokens →\n' +
	'Create Token → Custom token) with:\n' +
	'    • Zone → WAF: Edit\n' +
	'  and a Zone Resource that includes the fork domain, then re-run:\n' +
	'    CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>';

async function main(): Promise<number> {
	console.log('— Sona apply-download-ratelimit —\n');

	const cfToken = env.CLOUDFLARE_API_TOKEN;
	if (!cfToken) {
		console.error('✖ CLOUDFLARE_API_TOKEN is not set in the environment.\n');
		console.error(TOKEN_RECIPE);
		return 1;
	}

	const domain = argv.slice(2).find((a) => !a.startsWith('-')) ?? '';
	if (!domain) {
		console.error('✖ No domain given. Pass the fork domain as an argument:');
		console.error('    CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>');
		return 1;
	}

	const res = await applyDownloadRateLimit(cfToken, domain);
	switch (res.status) {
		case 'created':
			console.log(`✔ ${res.detail}`);
			return 0;
		case 'updated':
			console.log(`✔ ${res.detail}`);
			return 0;
		case 'exists':
			console.log(`✔ ${res.detail}`);
			return 0;
		default:
			console.error(`✖ ${res.detail}\n`);
			// The recipe fixes token scopes, so print it only when the detail names
			// a permission failure (isPermissionError keys off waf-lib's own scope
			// hint) — a transient HTTP error just gets plain retry guidance.
			if (isPermissionError(res.detail)) {
				console.error(TOKEN_RECIPE);
			} else {
				console.error('This may not be a token-permission problem. Re-run once the');
				console.error('reason above is resolved:');
				console.error('    CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>');
			}
			return 1;
	}
}

main()
	.then((code) => exit(code))
	.catch((err) => {
		// Never surface the token; print only the error class/message.
		console.error('✖ Unexpected error:', err instanceof Error ? err.message : String(err));
		exit(1);
	});
