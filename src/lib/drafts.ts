// Unsaved commission entry drafts (SONA-236), kept through SvelteKit's page
// snapshots so following a link off the entry form and coming back with the
// browser's Back button keeps what the owner typed.

/** Where SvelteKit keeps page snapshots in sessionStorage. Pinned by the
 * logout e2e, which checks the key is gone after signing out. */
export const SNAPSHOT_STORAGE_KEY = 'sveltekit:snapshot';

/** A page's snapshot that defers to its form: the form decides what's worth
 * keeping (`capture` returns undefined for nothing) and how to put it back. */
export function draftSnapshot<T>(form: () => { captureDraft(): T | undefined; restoreDraft(draft: T): void } | undefined) {
	return {
		capture: () => form()?.captureDraft(),
		restore: (draft: T | undefined) => {
			if (draft) form()?.restoreDraft(draft);
		}
	};
}

/**
 * Forgets every saved draft, for signing out. SvelteKit holds snapshots in
 * memory and writes them back to sessionStorage when the page unloads (on
 * beforeunload, then again as the page turns hidden), so removing the key once
 * isn't enough: it's removed again after each of SvelteKit's unload writes, and
 * the caller then loads a fresh page, which starts empty.
 */
export function forgetDrafts() {
	const clear = () => {
		try {
			sessionStorage.removeItem(SNAPSHOT_STORAGE_KEY);
		} catch {
			// Storage can be unavailable (a private window); nothing is kept then.
		}
	};
	clear();
	addEventListener('beforeunload', clear);
	addEventListener('visibilitychange', clear);
}
