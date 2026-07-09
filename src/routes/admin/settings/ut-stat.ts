import type { StorageProviderId } from '$lib/server/settings';

/**
 * Whether to show the UploadThing file-count stat in the admin storage panel.
 *
 * `+page.server.ts` populates `utUsage` whenever UPLOADTHING_TOKEN exists,
 * REGARDLESS of the active storage provider — so the provider clause is the only
 * thing hiding a stale UT file count on a site that has migrated UT -> R2 (the
 * real sparky.ink situation). Both clauses are load-bearing: on a migrated R2
 * site `utUsage` is still truthy, so the stat must be gated on the provider too.
 */
export function showUtFileStat<
	T extends {
		utUsage?: { filesUploaded: number } | null;
		settings: { storageProvider: StorageProviderId };
	}
>(data: T): data is T & { utUsage: { filesUploaded: number } } {
	return Boolean(data.utUsage) && data.settings.storageProvider === 'uploadthing';
}
