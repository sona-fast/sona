/**
 * Footer build receipt (SONA-167): turn the baked-in build constants into a
 * renderable stamp. The /ai page points at this as "the source for this exact
 * build", so the link must target the repository the deployment actually built
 * from — each fork's own — never a hardcoded upstream URL, where a fork-only
 * commit would 404. With a SHA but no repo URL the stamp renders unlinked;
 * with no SHA (local dev, preview builds outside Actions) there is no stamp.
 */
export interface BuildReceipt {
	/** Seven-char short SHA for display. */
	short: string;
	/** Commit tree URL in the building repo, or '' when the repo is unknown. */
	url: string;
}

/**
 * Compose the building repository's URL from a GitHub Actions environment.
 * Deploys run through each fork's own Actions workflow, where both vars are
 * set, so every fork stamps its OWN repo rather than a hardcoded upstream link
 * that would 404 on a fork-only commit. Anything else — a local build, half an
 * environment, a non-https server URL — yields '' and the footer omits the
 * link, applying the same absolute-https rule `buildReceipt` enforces so a
 * rejected URL never reaches the bundle in the first place.
 */
export function repoUrlFromEnv(env: Record<string, string | undefined>): string {
	const server = env.GITHUB_SERVER_URL?.trim();
	const repo = env.GITHUB_REPOSITORY?.trim();
	if (!server || !repo) return '';
	// Trim the seam so the join is one slash whichever side carries it — both ends
	// of the repository, since `buildReceipt` appends `/tree/<sha>` to the result.
	const composed = `${server.replace(/\/+$/, '')}/${repo.replace(/^\/+|\/+$/g, '')}`;
	try {
		const url = new URL(composed);
		if (url.protocol !== 'https:') return '';
		// Embedded credentials make the visible prefix read as the expected host
		// while the request goes elsewhere ('https://github.com@evil.example'); that
		// href would sit in every page's footer, so reject it outright.
		if (url.username || url.password) return '';
		// `/tree/<sha>` is appended to whatever comes back, so it has to land on a
		// path. A query or fragment ('https://github.com?x=1') would swallow it, and
		// a bare '/' path (GITHUB_REPOSITORY='/', '.', '..') would re-create the
		// doubled slash the trimming above exists to prevent.
		if (url.search || url.hash || url.pathname === '/') return '';
		// Return what was validated, not the raw composition: a '../' segment in the
		// repository value is normalized here rather than resolved by the browser.
		return url.href;
	} catch {
		return '';
	}
}

export function buildReceipt(sha: string, repoUrl: string): BuildReceipt | null {
	const cleanSha = sha.trim();
	if (!/^[0-9a-f]{7,40}$/i.test(cleanSha)) return null;
	// Only an absolute https URL may be linked: the repo URL is env-injected at
	// build time, and anything else (http, javascript:, a bare path) renders the
	// stamp unlinked instead of an attacker-shaped href in every page's footer.
	let cleanRepo = repoUrl.trim();
	try {
		const url = new URL(cleanRepo);
		// Embedded credentials ('https://github.com@evil.example') read as the
		// expected host and resolve elsewhere. `repoUrlFromEnv` rejects them too;
		// both layers check so either one is sufficient on its own.
		if (url.protocol !== 'https:' || url.username || url.password) cleanRepo = '';
	} catch {
		cleanRepo = '';
	}
	return {
		short: cleanSha.slice(0, 7),
		// /tree/<sha> works for any commit, unlike /commit/<sha> which shows a
		// diff — the receipt's promise is "browse this build's source".
		url: cleanRepo ? `${cleanRepo}/tree/${cleanSha}` : ''
	};
}
