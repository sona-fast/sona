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

export function buildReceipt(sha: string, repoUrl: string): BuildReceipt | null {
	const cleanSha = sha.trim();
	if (!/^[0-9a-f]{7,40}$/i.test(cleanSha)) return null;
	const cleanRepo = repoUrl.trim().replace(/\/+$/, '');
	return {
		short: cleanSha.slice(0, 7),
		// /tree/<sha> works for any commit, unlike /commit/<sha> which shows a
		// diff — the receipt's promise is "browse this build's source".
		url: cleanRepo ? `${cleanRepo}/tree/${cleanSha}` : ''
	};
}
