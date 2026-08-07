// workerd's FixedLengthStream global (absent in Node, where vite dev and vitest
// run this code). Looked up via globalThis because @cloudflare/workers-types is
// consumed as a module in this repo, so its globals aren't ambient. Shared by
// both providers: R2 needs it for the object length, and the UploadThing ingest
// PUT needs it because workerd silently DROPS a manually-set content-length
// header on a plain ReadableStream body (sending chunked encoding instead) —
// only a FixedLengthStream body carries a real Content-Length.

export type FixedLengthStreamCtor = new (
	byteLength: number
) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** The FixedLengthStream constructor when running under workerd, else undefined. */
export function fixedLengthStreamCtor(): FixedLengthStreamCtor | undefined {
	return (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
}
