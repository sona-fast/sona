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
 * include the fork's domain. (Read-only Zone → Zone: Read is enough to resolve the
 * zone, but writing the rule needs WAF: Edit.)
 */
import { env, argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyDownloadRateLimit, isPermissionError, type RateLimitResult } from './waf-lib.ts';

export const TOKEN_RECIPE =
	'Set CLOUDFLARE_API_TOKEN to a Cloudflare API token (dash → My Profile → API Tokens →\n' +
	'Create Token → Custom token) with:\n' +
	'    • Zone → Zone: Read\n' +
	'    • Zone → WAF: Edit\n' +
	'  and a Zone Resource that includes the fork domain, then re-run:\n' +
	'    CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>';

/**
 * What the runner prints when the rule wasn't applied. The recipe fixes token
 * scopes, so it goes out only when the call actually hit a refusal — the result
 * records that; the wording is never consulted. Any other failure gets plain
 * retry guidance, since re-minting a token would not have helped.
 *
 * Pure and exported so the gate itself is testable: main() drives live
 * Cloudflare state, and inverting this branch used to pass the whole suite.
 */
export function failureLines(res: RateLimitResult): string[] {
	const lines = [`✖ ${res.detail}\n`];
	if (isPermissionError(res)) {
		lines.push(TOKEN_RECIPE);
	} else {
		lines.push('This may not be a token-permission problem. Re-run once the');
		lines.push('reason above is resolved:');
		lines.push('    CLOUDFLARE_API_TOKEN=<token> npm run apply-download-ratelimit -- <domain>');
	}
	return lines;
}

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
			for (const line of failureLines(res)) console.error(line);
			return 1;
	}
}

// Only run when invoked directly, so the unit tests can import the helpers.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	main()
		.then((code) => exit(code))
		.catch((err) => {
			// Never surface the token; print only the error class/message.
			console.error('✖ Unexpected error:', err instanceof Error ? err.message : String(err));
			exit(1);
		});
}
