import { UTApi } from 'uploadthing/server';
import type { StorageProvider, PutInput, PutResult, DeleteOrphansOptions } from './types';

export class UploadThingStorage implements StorageProvider {
	readonly id = 'uploadthing' as const;
	#api: UTApi;

	constructor(opts: { token: string }) {
		this.#api = new UTApi({ token: opts.token });
	}

	async put({ body, contentType, filename }: PutInput): Promise<PutResult> {
		// UploadThing needs a File, so a stream is buffered here.
		const part = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
		const file = new File([part as BlobPart], filename, { type: contentType });
		const res = await this.#api.uploadFiles(file);
		if (res.error) throw new Error(`UploadThing upload failed: ${res.error.message}`);
		return { url: res.data.ufsUrl };
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
