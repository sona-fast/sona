// Cross-page transitions through the View Transitions API, for onNavigate.
//
// startViewTransition returns three promises (ready, finished,
// updateCallbackDone). They reject when the browser skips the animation, when
// the DOM update outlasts its timeout ("Transition was aborted because of
// timeout in DOM update"), or when the navigation itself fails. The navigation
// has happened or failed on its own by then, so those rejections carry nothing
// to act on; unhandled, they surface as uncaught page errors.

type ViewTransitionLike = {
	ready: Promise<unknown>;
	finished: Promise<unknown>;
	updateCallbackDone: Promise<unknown>;
};

type TransitionDocument = {
	startViewTransition?: (update: () => Promise<void>) => ViewTransitionLike;
};

/** Starts a transition for a navigation. Resolves once the browser has captured
 *  the old page, so SvelteKit can swap in the new one; returns undefined when
 *  the browser has no View Transitions API, and the navigation runs at once. */
export function startNavigationTransition(
	doc: TransitionDocument,
	complete: Promise<unknown>
): Promise<void> | undefined {
	const start = doc.startViewTransition?.bind(doc);
	if (!start) return;

	return new Promise((resolve) => {
		let transition: ViewTransitionLike;
		try {
			transition = start(async () => {
				resolve();
				await complete;
			});
		} catch {
			// SvelteKit awaits every onNavigate result, so a throw here would fail
			// the navigation itself. Navigate without the transition instead.
			resolve();
			return;
		}
		for (const settled of [transition.ready, transition.finished, transition.updateCallbackDone]) {
			settled.catch(() => {});
		}
	});
}

type NavigationEnd = { url: URL } | null;

/** False for an in-place update: a `goto` or link that changes only the query
 *  string (gallery and sticker filters, sort, pagination). The page updates in
 *  place there, and fading the whole document out and back in makes it look
 *  like a full reload. Every other navigation keeps the transition, including
 *  Back and Forward and a navigation to the same URL: when Back lands mid
 *  navigation, SvelteKit runs a popstate from a URL to itself, and the admin
 *  ledger pages stopped responding when that one skipped it. */
export function wantsNavigationTransition(
	from: NavigationEnd,
	to: NavigationEnd,
	type: string
): boolean {
	if (!from || !to || (type !== 'goto' && type !== 'link')) return true;
	return from.url.pathname !== to.url.pathname || from.url.search === to.url.search;
}
