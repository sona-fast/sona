import { getTableColumns } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
	artists,
	avatarMedia,
	characters,
	collections,
	conventions,
	fursuitPhotos,
	images,
	stickerPacks,
	stickers,
	vrAvatars
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import type { SiteSettings } from '$lib/server/settings';

/**
 * Every URL-bearing column in the schema, by table — the source list for
 * collectReferencedUrls. This list must stay COMPLETE: orphan cleanup deletes
 * any stored object whose URL is not collected, so a missing column means the
 * files it references get deleted as "orphans".
 *
 * It deliberately OVER-collects: external-looking URLs (social links, furtrack,
 * photographer, source posts) are included too. Each storage provider's
 * deleteOrphans ignores URLs it doesn't own (see r2.ts #keyFromUrl), so an
 * extra external URL is inert — while a misclassified omission is destructive.
 * When in doubt, include the column.
 *
 * referenced-urls.test.ts asserts this list covers every *url column in the
 * schema, so a migration that adds one fails the suite until it's added here.
 */
export const URL_COLUMNS: ReadonlyArray<{ table: SQLiteTable; columns: readonly string[] }> = [
	{
		table: artists,
		columns: [
			'avatarUrl',
			'twitterUrl',
			'blueskyUrl',
			'telegramUrl',
			'furAffinityUrl',
			'deviantArtUrl',
			'patreonUrl',
			'instagramUrl'
		]
	},
	{ table: collections, columns: ['coverImageUrl'] },
	{ table: images, columns: ['imageUrl', 'thumbnailUrl', 'sourcePostUrl'] },
	{
		table: characters,
		columns: [
			'url',
			'twitterUrl',
			'blueskyUrl',
			'telegramUrl',
			'furAffinityUrl',
			'deviantArtUrl',
			'patreonUrl',
			'instagramUrl',
			'avatarUrl'
		]
	},
	{ table: fursuitPhotos, columns: ['imageUrl', 'photographerUrl', 'furtrackUrl'] },
	{ table: stickerPacks, columns: ['coverImageUrl', 'telegramUrl'] },
	{ table: stickers, columns: ['imageUrl', 'thumbnailUrl'] },
	{ table: conventions, columns: ['url'] },
	// modelUrl is self-hosted (the load-bearing one); externalUrl is off-site
	// and inert — included per the over-collect rule above.
	{ table: vrAvatars, columns: ['modelUrl', 'externalUrl'] },
	{ table: avatarMedia, columns: ['url'] }
];

/**
 * The union of every URL stored anywhere in the database plus the URL-ish site
 * settings (adminAvatarUrl may point at our storage; the social links and
 * r2PublicUrl are inert extras). This is THE reference set for orphan cleanup —
 * see URL_COLUMNS for why it over-collects. Null/empty values are dropped.
 */
export async function collectReferencedUrls(db: Database, settings: SiteSettings): Promise<string[]> {
	const urls = new Set<string>();
	for (const { table, columns } of URL_COLUMNS) {
		const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
		const selection = Object.fromEntries(columns.map((c) => [c, cols[c]]));
		const rows = await db.select(selection).from(table);
		for (const row of rows) {
			for (const value of Object.values(row)) {
				if (typeof value === 'string' && value) urls.add(value);
			}
		}
	}
	for (const [key, value] of Object.entries(settings)) {
		if (/url$/i.test(key) && typeof value === 'string' && value) urls.add(value);
	}
	return [...urls];
}
