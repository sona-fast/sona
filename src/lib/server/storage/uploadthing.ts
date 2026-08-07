import { UTApi } from 'uploadthing/server';
// The SDK's own version, sent as x-uploadthing-version on the ingest PUT to
// match what UTApi.uploadFiles sends (uploadthing/server re-imports this same
// value but doesn't re-export it).
import { version as UT_SDK_VERSION } from 'uploadthing/package.json';
import { generateKey, generateSignedURL } from '@uploadthing/shared';
import * as Micro from 'effect/Micro';
import * as Redacted from 'effect/Redacted';
import { ZeroKeepError } from './types';
import { fixedLengthStreamCtor } from './fixed-length';
import type { StorageProvider, PutInput, PutResult, DeleteOrphansOptions } from './types';

/**
 * The relevant fields of the UPLOADTHING_TOKEN payload (base64 JSON) — the same
 * shape the SDK's own token schema parses: { apiKey, appId, regions, ingestHost? }.
 */
interface ParsedToken {
	apiKey: string;
	appId: string;
	regions: string[];
	ingestHost: string;
}

/** Response body of a successful ingest PUT (the subset we use). */
interface IngestUploadResponse {
	ufsUrl?: string;
	error?: unknown;
}

// Token-derived values that end up inside the ingest URL must be plain DNS-name
// shapes — anything else (credentials, ports, paths) could redirect the signed
// upload to a host the token author chose.
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

const UNUSABLE_TOKEN =
	'UPLOADTHING_TOKEN is missing or malformed (apiKey/appId/regions/ingestHost); cannot construct a presigned upload URL';

export class UploadThingStorage implements StorageProvider {
	readonly id = 'uploadthing' as const;
	#api: UTApi;
	#rawToken: string;

	constructor(opts: { token: string }) {
		this.#api = new UTApi({ token: opts.token });
		this.#rawToken = opts.token;
	}

	async put({ body, contentType, filename, size }: PutInput): Promise<PutResult> {
		// With a declared size, upload the stream via UploadThing's documented
		// presigned-ingest protocol instead of materializing it — UTApi has no
		// streaming API (uploadFiles takes a Blob), but the wire protocol is a
		// plain HTTP PUT: https://docs.uploadthing.com/uploading-files
		if (body instanceof ReadableStream && size !== undefined) {
			return this.#putStream(body, size, contentType, filename);
		}
		// Buffered path: small bodies and streams of unknown length. Callers cap
		// unknown-length streams (MAX_BUFFER_BYTES) before they get here.
		const part = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
		const file = new File([part as BlobPart], filename, { type: contentType });
		const res = await this.#api.uploadFiles(file);
		if (res.error) throw new Error(`UploadThing upload failed: ${res.error.message}`);
		return { url: res.data.ufsUrl };
	}

	/**
	 * Stream `body` to UploadThing without buffering it: sign an ingest URL
	 * locally (no API round-trip — generateKey/generateSignedURL are the SDK's
	 * own public helpers), then PUT the bytes as the same multipart shape the
	 * official clients send. Content-Length is exact, so the whole request is a
	 * single fixed-size pass and the isolate only ever holds one chunk.
	 */
	async #putStream(
		body: ReadableStream<Uint8Array>,
		size: number,
		contentType: string,
		filename: string
	): Promise<PutResult> {
		// The content type is interpolated into a multipart header line below;
		// only printable ASCII can't smuggle CR/LF (or raw bytes) into the framing.
		if (!/^[\x20-\x7e]+$/.test(contentType)) {
			throw new Error(`uploadthing: content type contains unsafe characters: ${JSON.stringify(contentType)}`);
		}
		const { apiKey, appId, regions, ingestHost } = this.#token();
		const key = await Micro.runPromise(
			generateKey({ name: filename, size, type: contentType, lastModified: Date.now() }, appId)
		);
		const url = await Micro.runPromise(
			generateSignedURL(`https://${regions[0]}.${ingestHost}/${key}`, Redacted.make(apiKey), {
				// x-ut-slug is only for client route uploads; server-side uploads omit
				// it. x-ut-acl is deliberately undefined (generateSignedURL skips
				// null/undefined data values): the app's default ACL then applies,
				// matching what UTApi.uploadFiles sends.
				data: {
					'x-ut-identifier': appId,
					'x-ut-file-name': filename,
					'x-ut-file-size': size,
					'x-ut-file-type': contentType,
					'x-ut-content-disposition': 'inline',
					'x-ut-acl': undefined
				}
			})
		);
		// #token() validates the host shape, so the signed URL can never carry
		// credentials — assert it anyway (defense in depth, same generic error).
		const signed = new URL(url);
		if (signed.username !== '' || signed.password !== '') {
			throw new Error(UNUSABLE_TOKEN);
		}

		// Multipart framing around the raw stream, mirroring the SDK's
		// `formData.append('file', file)` — built by hand so the file bytes stay
		// a stream. Quotes/CR/LF are stripped from the filename to keep the
		// Content-Disposition header well-formed (the stored name comes from
		// x-ut-file-name above, which is signed and percent-encoded separately).
		const boundary = `----sona-${crypto.randomUUID()}`;
		const safeName = filename.replace(/["\r\n]/g, '_');
		const encoder = new TextEncoder();
		const head = encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
				`Content-Type: ${contentType}\r\n\r\n`
		);
		const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
		const total = head.length + size + tail.length;

		const framed = frameMultipart(head, body, size, tail);
		// workerd silently drops a manually-set content-length header on a plain
		// ReadableStream body and sends chunked encoding instead — only a
		// FixedLengthStream body carries a real Content-Length there. Node
		// (dev/tests) has no FixedLengthStream but honours the header below.
		const FixedLengthStream = fixedLengthStreamCtor();
		const fixed = FixedLengthStream ? new FixedLengthStream(total) : undefined;
		const pump = fixed ? framed.pipeTo(fixed.writable) : undefined;

		// Await both: fetch consumes the readable side, and a pump failure (source
		// error, wrong length) must reject the call, not float.
		const [res] = await Promise.all([
			fetch(url, {
				method: 'PUT',
				headers: {
					'content-type': `multipart/form-data; boundary=${boundary}`,
					// Exact total: declared file size plus the fixed framing. A body
					// that doesn't match fails the request instead of storing garbage.
					'content-length': String(total),
					// The ingest protocol is resumable; a fresh upload starts at 0.
					range: 'bytes=0-',
					'x-uploadthing-version': UT_SDK_VERSION
				},
				body: fixed ? fixed.readable : framed,
				// Node (dev/tests) requires half-duplex for stream bodies; workerd
				// streams uploads natively and ignores the flag.
				...({ duplex: 'half' } as RequestInit)
			}),
			pump
		]);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(`UploadThing ingest PUT failed: ${res.status} ${detail}`.trim());
		}
		const json = (await res.json()) as IngestUploadResponse;
		if (!json.ufsUrl) {
			throw new Error(
				`UploadThing ingest PUT returned no ufsUrl${json.error ? `: ${String(json.error)}` : ''}`
			);
		}
		return { url: json.ufsUrl };
	}

	/** Parse UPLOADTHING_TOKEN lazily (only the streaming path needs it). */
	#token(): ParsedToken {
		let parsed: Partial<ParsedToken> & { regions?: unknown };
		try {
			parsed = JSON.parse(
				new TextDecoder().decode(Uint8Array.from(atob(this.#rawToken), (c) => c.charCodeAt(0)))
			);
		} catch {
			throw new Error(
				'UPLOADTHING_TOKEN is not a base64 JSON token; cannot construct a presigned upload URL'
			);
		}
		const { apiKey, appId } = parsed;
		const regions = Array.isArray(parsed.regions)
			? parsed.regions.filter((r): r is string => typeof r === 'string')
			: [];
		const ingestHost =
			typeof parsed.ingestHost === 'string' ? parsed.ingestHost : 'ingest.uploadthing.com';
		if (
			typeof apiKey !== 'string' ||
			typeof appId !== 'string' ||
			regions.length === 0 ||
			!HOST_RE.test(regions[0]) ||
			!HOST_RE.test(ingestHost)
		) {
			throw new Error(UNUSABLE_TOKEN);
		}
		return { apiKey, appId, regions, ingestHost };
	}

	async deleteByUrl(url: string): Promise<void> {
		const key = this.#keyFromUrl(url);
		if (key) await this.#api.deleteFiles([key]);
	}

	owns(url: string): boolean {
		// UploadThing serves from <appId>.ufs.sh/f/<key> (and legacy utfs.io/f/<key>).
		return /\.ufs\.sh\/f\/|utfs\.io\/f\//.test(url);
	}

	async deleteOrphans(referencedUrls: string[], opts?: DeleteOrphansOptions): Promise<number> {
		const keep = new Set(
			referencedUrls.map((u) => this.#keyFromUrl(u)).filter((k): k is string => !!k)
		);
		// 500 covers this site's volume; paginate if it ever grows past that.
		const { files } = await this.#api.listFiles({ limit: 500 });
		// Keys here are host-agnostic (any …/f/<key> URL), so an empty keep set
		// with files present means the reference set itself is empty/broken —
		// deleting would wipe every stored file. See DeleteOrphansOptions.
		// KNOWN CASE: after a full UT→R2 migration no DB URL points at UT, so the
		// scheduled cron trips this belt forever and never removes the leftover
		// originals. That's intended — the migrate page's manual cleanup button
		// (which doesn't set abortOnEmptyKeepSet) is the post-migration path.
		if (opts?.abortOnEmptyKeepSet && keep.size === 0 && files.length > 0) {
			throw new ZeroKeepError(
				'uploadthing: no referenced URL resolves to a stored key — refusing to treat every file as an orphan (empty or unmappable reference set?)'
			);
		}
		// listFiles exposes uploadedAt as epoch millis, so the age gate works here too.
		const cutoff = opts?.olderThan?.getTime();
		const orphans = files
			.filter((f) => !keep.has(f.key) && (cutoff === undefined || f.uploadedAt < cutoff))
			.map((f) => f.key);
		if (orphans.length && !opts?.dryRun) await this.#api.deleteFiles(orphans);
		return orphans.length;
	}

	#keyFromUrl(url: string): string | null {
		const m = url.match(/\/f\/([^/?#]+)/);
		return m ? m[1] : null;
	}
}

/**
 * Frame a byte stream as a single multipart/form-data part without buffering:
 * `head`, then the source chunks (backpressure and cancellation propagate
 * through the TransformStream), then `tail`. Errors the stream as soon as the
 * source yields more than `size` bytes — in Node an over-long body would
 * otherwise stall the fetch forever once content-length bytes have been sent
 * (workerd's FixedLengthStream catches the mismatch on its own).
 */
function frameMultipart(
	head: Uint8Array,
	body: ReadableStream<Uint8Array>,
	size: number,
	tail: Uint8Array
): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start: (c) => c.enqueue(head),
			transform(chunk, c) {
				seen += chunk.length;
				if (seen > size) {
					throw new Error(`uploadthing: body exceeded the declared ${size} bytes`);
				}
				c.enqueue(chunk);
			},
			flush: (c) => c.enqueue(tail)
		})
	);
}
