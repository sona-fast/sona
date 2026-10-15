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
			// Throws, for example, in a hidden document; navigate without it.
			resolve();
			return;
		}
		for (const settled of [transition.ready, transition.finished, transition.updateCallbackDone]) {
			settled.catch(() => {});
		}
	});
}
