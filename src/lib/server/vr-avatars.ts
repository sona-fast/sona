import { eq, and, ne } from 'drizzle-orm';
import { vrAvatars, avatarCredits, avatarMedia, avatarPlatforms, characters, images } from '$lib/server/db/schema';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { deleteFile } from '$lib/server/storage';
import type { SiteSettings } from '$lib/server/settings';
import type { Database } from '$lib/server/db';

type Env = App.Platform['env'];

const LICENSES = new Set(['personal-use', 'cc-by', 'base-tos', 'all-rights-reserved']);
const FORMATS = new Set(['vrm', 'vrm0', 'fbx']);
const PLATFORMS = new Set(['vrchat', 'resonite', 'chilloutvr', 'neosvr', 'vseeface', 'warudo', 'other']);
const ROLES = new Set(['base', 'modeler', 'rigger', 'texture', 'shader', 'other']);

export interface AvatarCreditInput {
	artistId: number;
	role: string;
	roleLabel: string | null;
	position: number;
}

export interface AvatarFormInput {
	name: string;
	slug: string;
	characterId: number;
	description: string | null;
	externalUrl: string | null;
	license: string | null;
	permissionSource: string | null;
	downloadable: boolean;
	nsfw: boolean;
	published: boolean;
	posterImageId: number | null;
	modelUrl: string | null;
	modelFormat: string | null;
	modelSizeBytes: number | null;
	platforms: string[];
	credits: AvatarCreditInput[];
}

export type ParseResult = { ok: true; input: AvatarFormInput } | { ok: false; error: string };

/**
 * Parse + validate the avatar create/edit form. Field-level rules only (no DB):
 * slug uniqueness and referenced-row existence are the action's job. Credit
 * rows arrive as `credit[i][artistId|role|roleLabel]` in display order — the
 * index becomes the stored position. roleLabel is REQUIRED for role='other'
 * (the schema deliberately doesn't enforce it; this is the enforcement point).
 */
export function parseAvatarForm(data: FormData): ParseResult {
	const name = sanitizeText(data.get('name') as string, 200);
	if (!name) return { ok: false, error: 'Avatar name is required.' };

	const slug = ((data.get('slug') as string) ?? '').trim().toLowerCase();
	if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
		return { ok: false, error: 'Slug may only contain lowercase letters, numbers and dashes.' };
	}

	const characterId = Number(data.get('characterId'));
	if (!Number.isInteger(characterId) || characterId <= 0) {
		return { ok: false, error: 'Character is required.' };
	}

	const posterRaw = (data.get('posterImageId') as string) ?? '';
	let posterImageId: number | null = null;
	if (posterRaw !== '') {
		posterImageId = Number(posterRaw);
		if (!Number.isInteger(posterImageId) || posterImageId <= 0) {
			return { ok: false, error: 'Invalid poster image.' };
		}
	}

	const license = LICENSES.has(data.get('license') as string) ? (data.get('license') as string) : null;

	const modelUrl = sanitizeUrl(data.get('modelUrl') as string);
	const formatRaw = data.get('modelFormat') as string;
	const modelFormat = modelUrl && FORMATS.has(formatRaw) ? formatRaw : null;
	const sizeRaw = Number(data.get('modelSizeBytes'));
	const modelSizeBytes =
		modelUrl && Number.isInteger(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;

	const platforms = [...new Set((data.getAll('platforms') as string[]).filter((p) => PLATFORMS.has(p)))];

	const credits: AvatarCreditInput[] = [];
	for (let i = 0; data.has(`credit[${i}][artistId]`); i++) {
		const artistId = Number(data.get(`credit[${i}][artistId]`));
		if (!Number.isInteger(artistId) || artistId <= 0) {
			return { ok: false, error: 'Each credit needs an artist.' };
		}
		const role = data.get(`credit[${i}][role]`) as string;
		if (!ROLES.has(role)) return { ok: false, error: 'Invalid credit role.' };
		const roleLabel = sanitizeText(data.get(`credit[${i}][roleLabel]`) as string, 100) || null;
		if (role === 'other' && !roleLabel) {
			return { ok: false, error: 'Name the role for "Other" credits.' };
		}
		credits.push({ artistId, role, roleLabel: role === 'other' ? roleLabel : null, position: i });
	}

	return {
		ok: true,
		input: {
			name,
			slug,
			characterId,
			description: sanitizeText(data.get('description') as string, 2000) || null,
			externalUrl: sanitizeUrl(data.get('externalUrl') as string),
			license,
			permissionSource: sanitizeText(data.get('permissionSource') as string, 500) || null,
			downloadable: data.get('downloadable') === '1',
			nsfw: data.get('nsfw') === '1',
			published: data.get('published') === '1',
			posterImageId,
			modelUrl,
			modelFormat,
			modelSizeBytes,
			platforms,
			credits
		}
	};
}

/** DB-level checks shared by create and update: slug uniqueness (excluding the
 * row itself on update) and existence of the referenced character/poster.
 * Returns an error string, or null when everything checks out. */
export async function validateAvatarRefs(
	db: Database,
	input: AvatarFormInput,
	excludeId?: number
): Promise<string | null> {
	const clash = await db
		.select({ id: vrAvatars.id })
		.from(vrAvatars)
		.where(
			excludeId === undefined
				? eq(vrAvatars.slug, input.slug)
				: and(eq(vrAvatars.slug, input.slug), ne(vrAvatars.id, excludeId))
		)
		.get();
	if (clash) return 'That slug is already in use.';

	const character = await db
		.select({ id: characters.id })
		.from(characters)
		.where(eq(characters.id, input.characterId))
		.get();
	if (!character) return 'Character not found.';

	if (input.posterImageId !== null) {
		const poster = await db
			.select({ id: images.id })
			.from(images)
			.where(eq(images.id, input.posterImageId))
			.get();
		if (!poster) return 'Poster image not found.';
	}
	return null;
}

function avatarRow(input: AvatarFormInput) {
	return {
		name: input.name,
		slug: input.slug,
		characterId: input.characterId,
		description: input.description,
		externalUrl: input.externalUrl,
		license: input.license as typeof vrAvatars.$inferInsert.license,
		permissionSource: input.permissionSource,
		downloadable: input.downloadable,
		nsfw: input.nsfw,
		published: input.published,
		posterImageId: input.posterImageId,
		modelUrl: input.modelUrl,
		modelFormat: input.modelFormat as typeof vrAvatars.$inferInsert.modelFormat,
		modelSizeBytes: input.modelSizeBytes
	};
}

async function replaceChildren(db: Database, avatarId: number, input: AvatarFormInput): Promise<void> {
	// Child rows are few (credits, platform badges) — replace wholesale, ordered
	// inserts carrying the display position.
	await db.delete(avatarCredits).where(eq(avatarCredits.avatarId, avatarId));
	await db.delete(avatarPlatforms).where(eq(avatarPlatforms.avatarId, avatarId));
	if (input.credits.length > 0) {
		await db.insert(avatarCredits).values(
			input.credits.map((c) => ({
				avatarId,
				artistId: c.artistId,
				role: c.role as typeof avatarCredits.$inferInsert.role,
				roleLabel: c.roleLabel,
				position: c.position
			}))
		);
	}
	if (input.platforms.length > 0) {
		await db.insert(avatarPlatforms).values(
			input.platforms.map((p) => ({
				avatarId,
				platform: p as typeof avatarPlatforms.$inferInsert.platform
			}))
		);
	}
}

/** Insert a new avatar with its credits/platforms; returns the new row id. */
export async function insertAvatar(db: Database, input: AvatarFormInput): Promise<number> {
	const inserted = await db
		.insert(vrAvatars)
		.values(avatarRow(input))
		.returning({ id: vrAvatars.id });
	const id = inserted[0].id;
	await replaceChildren(db, id, input);
	return id;
}

/**
 * Update an existing avatar. When a previously stored self-hosted model file is
 * replaced or removed, the old object is deleted eagerly (best-effort, like
 * deletePack / the fursuit + images admin deletes — the orphan sweep backstops
 * a failed delete).
 */
export async function updateAvatar(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	id: number;
	input: AvatarFormInput;
	previousModelUrl: string | null;
}): Promise<void> {
	const { env, settings, db, id, input, previousModelUrl } = opts;
	await db.update(vrAvatars).set(avatarRow(input)).where(eq(vrAvatars.id, id));
	await replaceChildren(db, id, input);

	if (previousModelUrl && previousModelUrl !== input.modelUrl) {
		try {
			await deleteFile(env, settings, previousModelUrl);
		} catch {
			// Best-effort — the orphan sweep cleans up stragglers.
		}
	}
}

/** Delete an avatar row (credits/media/platforms cascade) and best-effort
 * delete its stored model + showcase media files. The poster is a shared
 * gallery image and is never touched. */
export async function deleteAvatar(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	id: number;
}): Promise<void> {
	const { env, settings, db, id } = opts;
	const row = await db
		.select({ modelUrl: vrAvatars.modelUrl })
		.from(vrAvatars)
		.where(eq(vrAvatars.id, id))
		.get();
	const media = await db
		.select({ url: avatarMedia.url })
		.from(avatarMedia)
		.where(eq(avatarMedia.avatarId, id));

	await db.delete(vrAvatars).where(eq(vrAvatars.id, id));

	const urls = [...(row?.modelUrl ? [row.modelUrl] : []), ...media.map((m) => m.url)];
	for (const url of urls) {
		try {
			await deleteFile(env, settings, url);
		} catch {
			// Best-effort — the orphan sweep cleans up stragglers.
		}
	}
}
