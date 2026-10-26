import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { not } from 'drizzle-orm';
import { artistIsLedgerOnly } from '$lib/server/artist-visibility';
import { artistSocials } from '$lib/server/registry';
import type { RequestHandler } from './$types';

// GET /api/registry/export-artists  (admin-only via hooks)
//
// Downloads this site's artists as a JSON array shaped for the registry's
// scripts/seed-from-sparky.ts seeder — i.e. the founding dataset for a registry.
// Each entry: { name, avatarUrl, socials: { twitterUrl, ... } }. Ledger-only
// artists (SONA-236) are left out, as the daily sync leaves them out: the file
// exists to seed a registry, and they are private to the owner's ledger.
export const GET: RequestHandler = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const rows = await db.select().from(artists).where(not(artistIsLedgerOnly(artists.id)));
	const out = rows.map((a) => ({
		name: a.name,
		avatarUrl: a.avatarUrl ?? null,
		socials: artistSocials(a)
	}));
	return new Response(JSON.stringify(out, null, 2), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': 'attachment; filename="artists-export.json"'
		}
	});
};
