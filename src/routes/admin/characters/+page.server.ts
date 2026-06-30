import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { characters, imageCharacters } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { resolveCharacterIcon } from '$lib/server/avatar';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	const allCharacters = await db
		.select({
			id: characters.id,
			name: characters.name,
			ownerName: characters.ownerName,
			url: characters.url,
			twitterUrl: characters.twitterUrl,
			blueskyUrl: characters.blueskyUrl,
			telegramUrl: characters.telegramUrl,
			furAffinityUrl: characters.furAffinityUrl,
			deviantArtUrl: characters.deviantArtUrl,
			patreonUrl: characters.patreonUrl,
			instagramUrl: characters.instagramUrl,
			avatarUrl: characters.avatarUrl,
			createdAt: characters.createdAt,
			imageCount: sql<number>`(SELECT COUNT(*) FROM image_characters WHERE image_characters.character_id = characters.id)`
		})
		.from(characters)
		.orderBy(characters.name);

	return { characters: allCharacters };
};

function parseSocials(data: FormData) {
	return {
		twitterUrl: sanitizeUrl(data.get('twitter') as string),
		blueskyUrl: sanitizeUrl(data.get('bluesky') as string),
		telegramUrl: sanitizeUrl(data.get('telegram') as string),
		furAffinityUrl: sanitizeUrl(data.get('furaffinity') as string),
		deviantArtUrl: sanitizeUrl(data.get('deviantart') as string),
		patreonUrl: sanitizeUrl(data.get('patreon') as string),
		instagramUrl: sanitizeUrl(data.get('instagram') as string)
	};
}

export const actions = {
	create: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const name = sanitizeText(data.get('name') as string, 200);
		const ownerName = sanitizeText(data.get('ownerName') as string, 200) || null;
		const url = sanitizeUrl(data.get('url') as string);
		const socials = parseSocials(data);

		if (!name) return fail(400, { error: 'Character name is required' });

		const avatarUrl = await resolveCharacterIcon({ url, blueskyUrl: socials.blueskyUrl });
		await db.insert(characters).values({ name, ownerName, url, ...socials, avatarUrl });
		return { success: true };
	},

	update: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const name = sanitizeText(data.get('name') as string, 200);
		const ownerName = sanitizeText(data.get('ownerName') as string, 200) || null;
		const url = sanitizeUrl(data.get('url') as string);
		const socials = parseSocials(data);

		if (!id) return fail(400, { error: 'Character ID is required' });
		if (!name) return fail(400, { error: 'Character name is required' });

		const avatarUrl = await resolveCharacterIcon({ url, blueskyUrl: socials.blueskyUrl });
		await db.update(characters).set({ name, ownerName, url, ...socials, avatarUrl }).where(eq(characters.id, id));
		return { success: true };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));

		if (!id) return fail(400, { error: 'Character ID is required' });

		await db.delete(imageCharacters).where(eq(imageCharacters.characterId, id));
		await db.delete(characters).where(eq(characters.id, id));
		return { success: true };
	}
} satisfies Actions;
