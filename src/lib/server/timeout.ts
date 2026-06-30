/**
 * Race a promise against a timeout, resolving to `fallback` if it neither
 * settles nor rejects within `ms`. Also falls back on rejection, so a single
 * call guards against BOTH a slow D1 read and a failing one.
 *
 * Why: D1 round-trip latency in production occasionally spikes from
 * milliseconds to seconds. With several sequential reads per page, that stacks
 * past Cloudflare's edge timeout and the visitor gets a 524. Bounding each read
 * lets us serve a fast, degraded page (e.g. an empty grid) instead of hanging.
 *
 * The pending promise is not cancelled — it is abandoned; the Workers runtime
 * tears down the in-flight subrequest once the response is returned.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise.catch(() => fallback), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
