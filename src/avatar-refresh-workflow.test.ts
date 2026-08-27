import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the one step in avatar-refresh.yml, which is the only caller of
// /api/cron/refresh-avatars. Its previous regression is why the heal exists at
// all: the step exited early whenever AVATAR_REFRESH_BATCH was unset, that
// variable is set on none of the real forks, and every test in the suite stayed
// green while the fix reached nobody. Same bug class as the two guards next
// door (src/turnstile-deploy-sync.test.ts,
// src/lib/server/cf-analytics-scope.test.ts): the app is fine, the thing that
// invokes it is not, and nothing fails.
//
// The last two describes widen to avatar-refresh's sibling cron workflows,
// because the token posture and the SITE_URL handling they share are only worth
// asserting across all of them.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
const workflow = read('../.github/workflows/avatar-refresh.yml');

/** Every workflow that POSTs to /api/cron/* with the fork's CRON_SECRET. */
const CRON_WORKFLOWS = [
	'avatar-refresh.yml',
	'sticker-resync.yml',
	'artist-sync.yml',
	'cleanup-orphans.yml',
	'backfill-animated.yml'
];

/** One workflow's step body. Sliced for the same reason `step` is below: each of
 *  these files documents SITE_URL as `https://example.com` in its preamble, so an
 *  assertion read against the whole file would be satisfied by prose. */
function stepOf(file: string): string {
	const yml = read(`../.github/workflows/${file}`);
	const start = yml.indexOf('      - name:');
	expect(start, `no step in ${file}`).toBeGreaterThan(-1);
	return yml.slice(start);
}

// The step body, isolated so assertions can't be satisfied by an unrelated step.
const step = (() => {
	const start = workflow.indexOf('- name: Trigger avatar refresh endpoint');
	const rest = workflow.slice(start);
	const end = rest.indexOf('\n      - name:');
	return end === -1 ? rest : rest.slice(0, end);
})();

/** The body of a `if <cond>; then … fi` block, so a claim about one branch can't
 *  be satisfied by a line somewhere else in the step. */
function ifBlock(condition: string): string {
	const start = step.indexOf(condition);
	expect(start, `no such branch: ${condition}`).toBeGreaterThan(-1);
	const rest = step.slice(start);
	return rest.slice(0, rest.indexOf('\n          fi'));
}

describe('avatar-refresh.yml — the step calls the endpoint on every fork', () => {
	it('has the trigger step at all', () => {
		expect(step).toContain('Trigger avatar refresh endpoint');
		expect(step).toContain('/api/cron/refresh-avatars');
	});

	it('sends batch=0 instead of exiting when the artist dial is unset', () => {
		// The whole point of the change: batch=0 means "heal this site's own avatar,
		// no artist work". An `exit` in this branch is the regression that shipped a
		// fix to nobody.
		const zero = ifBlock('if [ "$BATCH" = "0" ]');
		expect(zero).toContain('::notice::');
		expect(zero).not.toContain('exit');
		// The branch not exiting is only half of it: an `exit 0` anywhere between
		// here and the request would skip the heal just as completely, and this
		// assertion would not have noticed. So pin that the request is actually
		// reached — nothing between the batch check and the curl exits at all.
		// Comments are stripped first, or the prose about curl's exit code below
		// counts as an exit.
		const zeroCheck = step.indexOf('if [ "$BATCH" = "0" ]');
		const request = step.indexOf('curl -sS');
		expect(zeroCheck).toBeGreaterThan(-1);
		expect(request).toBeGreaterThan(zeroCheck);
		const between = step
			.slice(zeroCheck, request)
			.split('\n')
			.filter((line) => !line.trim().startsWith('#'))
			.join('\n');
		expect(between).not.toMatch(/\bexit\b/);
	});

	it('puts the parsed BATCH in the URL, not the raw repo variable', () => {
		// ${AVATAR_REFRESH_BATCH} here would undo the parsing above it: an unset
		// variable would send `batch=`, which the endpoint reads as unparseable.
		expect(step).toContain('/api/cron/refresh-avatars?batch=${BATCH}');
		expect(step).not.toContain('batch=${AVATAR_REFRESH_BATCH}');
	});

	it('refuses a non-numeric batch before it reaches curl', () => {
		// The only defence between a typo'd repo variable and the endpoint, which
		// falls back to its own default for a param it cannot parse.
		expect(step).toMatch(/case "\$BATCH" in/);
		expect(step).toMatch(/\*\[!0-9\]\*\)/);
		expect(step).toContain('::error::AVATAR_REFRESH_BATCH must be a whole number');
	});

	it('normalises leading zeros before deciding the run is opted out', () => {
		// '00' passes the digit guard but is not the string '0', so without this it
		// would do no artist work and say nothing about it.
		const normalizeAt = step.indexOf('BATCH=$((10#$BATCH))');
		const zeroCheckAt = step.indexOf('if [ "$BATCH" = "0" ]');
		expect(normalizeAt).toBeGreaterThan(-1);
		expect(zeroCheckAt).toBeGreaterThan(normalizeAt);
	});
});

describe('avatar-refresh.yml — an unconfigured fork skips rather than fails', () => {
	// Now that the call is unconditional, every fork runs this daily. A fork with
	// SITE_URL set and no CRON_SECRET is the documented, expected state (the setup
	// CLI's GitHub-secrets step is opt-in), and failing it would leave a red
	// Actions tab and daily failure mail on accounts the operator can't log into.
	it('warns and exits 0 when CRON_SECRET is unset, like its two siblings', () => {
		const missing = ifBlock('if [ -z "$CRON_SECRET" ]');
		expect(missing).toContain('::warning::');
		expect(missing).toContain('exit 0');
		expect(missing).not.toContain('exit 1');
	});

	it('treats HTTP 503 as "cron not configured on the site", not an error', () => {
		// requireCronSecret returns 503 when the site has no CRON_SECRET Pages
		// secret — the same not-opted-in state, seen from the other end.
		const notConfigured = ifBlock('if [ "$code" = "503" ]');
		expect(notConfigured).toContain('exit 0');
		expect(step.indexOf('if [ "$code" = "503" ]')).toBeLessThan(
			step.indexOf('if [ "$code" != "200" ]')
		);
	});
});

describe('avatar-refresh.yml — SITE_URL receives the cron secret daily', () => {
	it('accepts only an https URL', () => {
		// The curl carries CRON_SECRET in an Authorization header, and that secret
		// opens every /api/cron/* endpoint. A typo'd or lapsed host would be handed
		// a working credential every morning.
		expect(step).toMatch(/case "\$SITE_URL" in/);
		expect(step).toContain('https://*) ;;');
		expect(step).toContain('::error::SITE_URL must be an https URL');
	});

	it('passes the target as --url so a leading dash cannot become curl options', () => {
		expect(step).toContain('--url "${SITE_URL%/}/api/cron/refresh-avatars');
	});
});

// The whole family, not just this one workflow: a job that declares no
// permissions inherits the repo default, and forks created before GitHub flipped
// that default in 2023 still hand read-write-everything to every job. None of
// these needs a token — no checkout, no action, no `gh` — so a step that grows
// one is the thing to notice, not the empty block.
describe('the /api/cron/* workflows ask for no GITHUB_TOKEN', () => {
	it.each(CRON_WORKFLOWS)('%s declares permissions: {}', (file) => {
		expect(read(`../.github/workflows/${file}`)).toMatch(/^ {4}permissions: \{\}$/m);
	});

	it.each(CRON_WORKFLOWS)('%s still has nothing that could use one', (file) => {
		// The empty block is only safe while this stays true. A checkout, an
		// action, or a `gh` call needs a scope, and adding one here would fail at
		// runtime with a 403 that reads like an unrelated outage.
		// Comment lines dropped first: backfill-animated documents `gh workflow run`
		// as the way an operator fires it, which is prose about the Actions tab, not
		// a call the job makes.
		const yml = read(`../.github/workflows/${file}`)
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.join('\n');
		expect(yml).not.toContain('uses:');
		expect(yml).not.toMatch(/\bgh (api|pr|issue|release|workflow) /);
	});
});

// Also the whole family, and for the same reason the token posture is: every one
// of these hands the fork's CRON_SECRET to whatever host SITE_URL names, and one
// secret opens all of them. avatar-refresh got both of these first; asserting
// them here is what stops the next workflow added to this folder from being the
// one that only checks the variable is non-empty.
describe('the /api/cron/* workflows guard the host they hand the secret to', () => {
	it.each(CRON_WORKFLOWS)('%s refuses a SITE_URL that is not https', (file) => {
		// A transposed or lapsed domain would otherwise collect a working
		// credential for every state-changing cron endpoint, on a schedule, from
		// forks whose Actions tab nobody is watching.
		const body = stepOf(file);
		expect(body).toMatch(/case "\$SITE_URL" in/);
		expect(body).toContain('https://*) ;;');
		expect(body).toContain('::error::SITE_URL must be an https URL');
		// Before the request, not after it. Comment lines dropped first, the way
		// the token test does it: each guard's own prose explains why the value
		// also goes to curl as --url, and that mention must not be what satisfies
		// the ordering.
		const script = body
			.split('\n')
			.filter((line) => !/^\s*#/.test(line))
			.join('\n');
		expect(script.indexOf('case "$SITE_URL" in')).toBeLessThan(script.indexOf('curl'));
	});

	it.each(CRON_WORKFLOWS)('%s passes the target as --url, never as a bare argument', (file) => {
		// A SITE_URL that begins with '-' is read as curl options otherwise.
		const body = stepOf(file);
		expect(body).toContain('--url "${SITE_URL%/}/api/cron/');
		expect(body).not.toMatch(/\n\s+"\$\{SITE_URL%\/\}\/api\/cron\//);
	});

	it.each(CRON_WORKFLOWS)('%s still explains itself when curl never reaches the site', (file) => {
		// `code=$(curl …)` under GitHub's default `bash -e` dies on a timeout, DNS
		// failure or TLS error — before the response dump and before every status
		// branch. That is a red run with nothing in it saying why, on a job that
		// runs unattended. Keeping curl's exit code is what buys the diagnostic;
		// exit 1 stays for a genuine non-200, which is the site's answer, not the
		// absence of one.
		const body = stepOf(file);
		expect(body).toMatch(/code=\$\(curl[\s\S]*?\) \|\| rc=\$\?/);
		expect(body).toMatch(/if \[ "\$rc" -ne 0 \]; then/);
		expect(body).toMatch(/::warning::curl exited \$rc/);
	});
});
