import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { artists } from '$lib/server/db/schema';
import { isTelegramEnabled } from '$lib/server/telegram';
import { getImportCandidates, importTelegramPack, importStickerBatch } from '$lib/server/sticker-import';
import type { StickerCandidate, StickerBatchItem } from '$lib/server/sticker-import';
import { sanitizeText } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);
	const telegramEnabled = isTelegramEnabled(platform?.env);

	// Character is implicit (the site's one character) — not chosen in the UI.
	const allArtists = await db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name);

	// Only hit Telegram when the admin explicitly checks (?check=1).
	let candidates: StickerCandidate[] = [];
	let setName = '';
	let setTitle = '';
	let checked = false;
	let reachError = false;

	const nameOrUrl = url.searchParams.get('pack') ?? '';

	if (telegramEnabled && url.searchParams.get('check') && nameOrUrl) {
		checked = true;
		try {
			const r = await getImportCandidates({ env: platform?.env, db, nameOrUrl });
			if (r) {
				candidates = r.candidates;
				setName = r.setName;
				setTitle = r.title;
			}
		} catch (e) {
			// Surfaces the Telegram reason (e.g. STICKERSET_INVALID = bad pack name) in
			// server logs; the user sees the friendly "couldn't reach / not found" banner.
			console.error('[stickers import] getStickerSet failed:', e instanceof Error ? e.message : e);
			reachError = true;
		}
	}

	return {
		telegramEnabled,
		artists: allArtists,
		nameOrUrl,
		checked,
		reachError,
		candidates,
		setName,
		setTitle
	};
};

export const actions = {
	import: async ({ request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const data = await request.formData();

		if (!isTelegramEnabled(platform?.env)) {
			return fail(400, { error: 'Telegram import is not configured.' });
		}

		const nameOrUrl = sanitizeText(data.get('nameOrUrl') as string, 500);
		const managerArtistIdRaw = data.get('managerArtistId') as string;
		const managerArtistId = managerArtistIdRaw && managerArtistIdRaw !== '' ? Number(managerArtistIdRaw) : null;
		const defaultArtistIdRaw = data.get('defaultArtistId') as string;

		if (!nameOrUrl) return fail(400, { error: 'Pack link or name is required.' });

		// Default artist is OPTIONAL — artists are created up-front via /api/artists, so
		// this is a real id or empty (null = import unattributed, assign later).
		const defaultArtistId = defaultArtistIdRaw && defaultArtistIdRaw !== 'new' ? Number(defaultArtistIdRaw) : null;

		// Parse per-sticker overrides from the form.
		// Fields: perSticker[i][excluded], perSticker[i][nsfw], perSticker[i][artistId], perSticker[i][emojis]
		const perSticker: Record<number, { excluded?: boolean; nsfw?: boolean; artistId?: number; emojis?: string[] }> = {};
		for (const [key, val] of data.entries()) {
			const m = /^perSticker\[(\d+)\]\[(\w+)\]$/.exec(key);
			if (!m) continue;
			const idx = Number(m[1]);
			const field = m[2];
			if (!perSticker[idx]) perSticker[idx] = {};
			if (field === 'excluded') perSticker[idx].excluded = (val as string) === '1';
			if (field === 'nsfw') perSticker[idx].nsfw = (val as string) === '1';
			if (field === 'artistId') perSticker[idx].artistId = Number(val);
			if (field === 'emojis') {
				perSticker[idx].emojis = (val as string).split(',').map((e) => e.trim()).filter(Boolean);
			}
		}

		const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);

		try {
			const result = await importTelegramPack({
				env: platform?.env,
				settings,
				db,
				nameOrUrl,
				managerArtistId,
				defaultArtistId,
				perSticker,
				absolutize
			});
			return { success: true, result };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Import failed.' });
		}
	},

	// Import ONE bounded batch. The client splits a large pack into batches and posts
	// them in sequence (each request stays well under Cloudflare's ~100s edge timeout),
	// accumulating the per-batch results. Called via fetch + deserialize(), so it returns
	// a plain { created, imported, skipped, failed } object the client reads directly.
	importBatch: async ({ request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const data = await request.formData();

		if (!isTelegramEnabled(platform?.env)) {
			return fail(400, { error: 'Telegram import is not configured.' });
		}

		const nameOrUrl = sanitizeText(data.get('nameOrUrl') as string, 500);
		if (!nameOrUrl) return fail(400, { error: 'Pack link or name is required.' });

		const managerArtistIdRaw = data.get('managerArtistId') as string;
		const managerArtistId = managerArtistIdRaw && managerArtistIdRaw !== '' ? Number(managerArtistIdRaw) : null;

		// The batch items arrive as a single JSON field: [{ fileId, emojis, artistId, nsfw }].
		// artistId is null = unattributed (the server applies the manager invariant).
		let items: StickerBatchItem[];
		try {
			const parsed = JSON.parse((data.get('items') as string) ?? '[]');
			if (!Array.isArray(parsed)) throw new Error('items must be an array');
			items = parsed.map((it) => ({
				fileId: String(it.fileId),
				emojis: Array.isArray(it.emojis) ? it.emojis.map((e: unknown) => String(e)).filter(Boolean) : [],
				artistId: it.artistId === null || it.artistId === undefined || it.artistId === '' ? null : Number(it.artistId),
				nsfw: it.nsfw === true || it.nsfw === '1'
			}));
		} catch {
			return fail(400, { error: 'Malformed batch.' });
		}

		const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);

		try {
			const result = await importStickerBatch({
				env: platform?.env,
				settings,
				db,
				nameOrUrl,
				managerArtistId,
				items,
				absolutize
			});
			return { batch: result };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'Batch import failed.' });
		}
	}
} satisfies Actions;
