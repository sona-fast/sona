import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReceipt, repoUrlFromEnv } from './build-info';

describe('buildReceipt', () => {
	const SHA = '6ff8a8a0c2b54d01ec549773b5a7d7c3a6fe1234';

	it('renders a short SHA linked into the building repo tree', () => {
		const r = buildReceipt(SHA, 'https://github.com/someone/sona');
		expect(r).toEqual({
			short: '6ff8a8a',
			url: `https://github.com/someone/sona/tree/${SHA}`
		});
	});

	// A fork can build from a repo we can't know at author time; with no repo
	// URL the stamp must still render, unlinked — never a guessed upstream link
	// that 404s on fork-only commits.
	it('renders unlinked when the repo URL is unknown', () => {
		expect(buildReceipt(SHA, '')).toEqual({ short: '6ff8a8a', url: '' });
	});

	// The repo URL is env-injected at build time; only absolute https may become
	// an href — anything else renders the stamp unlinked, never a footer-wide link.
	it('renders unlinked when the repo URL is not an absolute https URL', () => {
		expect(buildReceipt(SHA, 'http://github.com/someone/sona')?.url).toBe('');
		expect(buildReceipt(SHA, 'javascript:alert(1)')?.url).toBe('');
		expect(buildReceipt(SHA, 'github.com/someone/sona')?.url).toBe('');
	});

	// The second layer of the same check `repoUrlFromEnv` applies: a host that
	// reads as github.com and resolves elsewhere must not become a footer href,
	// whichever side supplied the URL.
	it('renders unlinked when the repo URL embeds credentials', () => {
		expect(buildReceipt(SHA, 'https://github.com@evil.example')?.url).toBe('');
		expect(buildReceipt(SHA, 'https://user:pass@github.com/someone/sona')?.url).toBe('');
	});

	// Local dev and test builds bake in '' — no stamp at all rather than a
	// broken or misleading one.
	it('returns null for an empty or malformed SHA', () => {
		expect(buildReceipt('', 'https://github.com/x/y')).toBeNull();
		expect(buildReceipt('not-a-sha', 'https://github.com/x/y')).toBeNull();
		expect(buildReceipt('abc12', '')).toBeNull();
	});
});

// The composition itself, not just buildReceipt's use of it: a wrong variable
// name or a missing slash here would surface only in a real Actions deploy, as
// a footer link that 404s on every fork at once.
describe('repoUrlFromEnv', () => {
	it('joins the server URL and the repository with a single slash', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('https://github.com/someone/sona');
	});

	// Either side may carry the slash depending on the runner; the join must not
	// double it, because a '//' path is a different (404ing) URL on GitHub.
	it('does not double the slash when either side already carries one', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com/',
				GITHUB_REPOSITORY: '/someone/sona'
			})
		).toBe('https://github.com/someone/sona');
		// A trailing slash on the repository would survive into
		// `${repoUrl}/tree/<sha>` as the same doubled slash.
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com',
				GITHUB_REPOSITORY: 'someone/sona/'
			})
		).toBe('https://github.com/someone/sona');
	});

	// Local dev, `vite preview`, and any build outside Actions: no repo is known,
	// so nothing is baked in and the footer stamp renders unlinked.
	it('yields no URL when either variable is missing or empty', () => {
		expect(repoUrlFromEnv({ GITHUB_REPOSITORY: 'someone/sona' })).toBe('');
		expect(repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com' })).toBe('');
		expect(repoUrlFromEnv({})).toBe('');
		expect(
			repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: '  ' })
		).toBe('');
	});

	// Same absolute-https rule buildReceipt enforces, applied one step earlier so
	// a URL that could never be linked never reaches the bundle.
	it('yields no URL when the server URL is not absolute https', () => {
		expect(
			repoUrlFromEnv({ GITHUB_SERVER_URL: 'http://github.com', GITHUB_REPOSITORY: 'someone/sona' })
		).toBe('');
		expect(
			repoUrlFromEnv({ GITHUB_SERVER_URL: 'github.com', GITHUB_REPOSITORY: 'someone/sona' })
		).toBe('');
	});

	// A GitHub Enterprise fork builds from its own host; the receipt must link
	// there, not rewrite it to github.com.
	it('keeps a GitHub Enterprise server URL', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://git.example.org',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('https://git.example.org/someone/sona');
	});

	// 'https://github.com@evil.example' reads as github.com in the composed string
	// but resolves to another host; that href would land in every page's footer.
	it('yields no URL when the server URL embeds credentials', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com@evil.example',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('');
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://user:pass@github.com',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('');
	});

	// `/tree/<sha>` is appended to the result, so it has to land on a path: a
	// repository-less URL re-creates the doubled slash, and a query or fragment
	// puts the commit inside it.
	it('yields no URL when the composition has no repository path', () => {
		expect(
			repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: '/' })
		).toBe('');
		expect(
			repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: '..' })
		).toBe('');
	});

	it('yields no URL when the server URL carries a query or fragment', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com?x=1',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('');
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com#x',
				GITHUB_REPOSITORY: 'someone/sona'
			})
		).toBe('');
	});

	// What was validated is what is returned: a traversal segment resolves here,
	// not later in the browser against a URL nobody checked.
	it('normalizes a traversal segment in the repository value', () => {
		expect(
			repoUrlFromEnv({
				GITHUB_SERVER_URL: 'https://github.com',
				GITHUB_REPOSITORY: 'someone/../evil'
			})
		).toBe('https://github.com/evil');
	});
});

// The extracted function is unit-tested above, but its call site is not: a
// renamed define key or a wrong argument passes every test and ships a footer
// link that 404s on all forks at once (the footer-build-markup.test.ts pattern).
describe('vite config wiring', () => {
	const viteConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');

	it('feeds repoUrlFromEnv(process.env) into the build defines', () => {
		expect(viteConfig).toContain('repoUrlFromEnv(process.env)');
		// Each define is pinned to ITS OWN value, not merely present: swapping the
		// two would stamp the repo URL as the commit and still read as wired up.
		expect(viteConfig).toMatch(/__BUILD_COMMIT_SHA__:\s*JSON\.stringify\(buildSha\)/);
		expect(viteConfig).toMatch(/__BUILD_REPO_URL__:\s*JSON\.stringify\(buildRepoUrl\)/);
	});
});
