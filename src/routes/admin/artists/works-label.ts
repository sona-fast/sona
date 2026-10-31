import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { ArtistDeleteBlockers } from '$lib/server/artist-delete-blockers';

const NBSP = '\u00a0';
const WORD_JOINER = '\u2060';

// Keep "21 artworks" on one line: spaces inside a segment never break.
function unbreakable(segment: string): string {
	return segment.replace(/ /g, NBSP);
}

// Japanese puts its counter right after the number ("1体"), and CJK text can
// break between any two characters: a word joiner keeps the two on one line.
// English has a space there, so nothing changes.
function counterJoined(segment: string): string {
	return segment.replace(/(\d)(?=[^\s\d,.])/g, `$1${WORD_JOINER}`);
}

// An artist may have drawn artworks, stickers, VR avatars, or any mix — show whatever's non-zero.
export function worksLabel(a: { artworkCount: number; stickerCount: number; avatarCount: number }): string {
	const parts: string[] = [];
	if (a.artworkCount > 0) parts.push(m.admin_count_artworks({ count: a.artworkCount }));
	if (a.stickerCount > 0) parts.push(m.admin_count_stickers({ count: a.stickerCount }));
	if (a.avatarCount > 0) parts.push(m.admin_count_vr_avatars({ count: a.avatarCount }));
	// NBSP before the dot so it never starts a line; the ordinary space after it is the only break point.
	// NBSP only covers Latin text: CJK breaks between any two characters, so the page's
	// `.works-label { word-break: keep-all; }` rule does that half. Read the two together.
	return parts.length ? parts.map(unbreakable).join(`${NBSP}· `) : m.admin_artists_no_works();
}

// Why Delete won't run for this artist, or null when nothing blocks it. Lists
// only the non-zero counts, in the delete action's order. The server's
// artistDeleteBlockerCounts supplies these fields; its refusal is the real guard.
export function deleteBlockersLabel(a: ArtistDeleteBlockers): string | null {
	const parts: string[] = [];
	if (a.artworkCount > 0) parts.push(m.admin_count_artworks({ count: a.artworkCount }));
	if (a.stickerCount > 0) parts.push(m.admin_count_stickers({ count: a.stickerCount }));
	if (a.avatarCount > 0) parts.push(m.admin_count_vr_avatars({ count: a.avatarCount }));
	if (a.managedPackCount > 0) parts.push(m.admin_count_sticker_packs({ count: a.managedPackCount }));
	if (a.commissionCount > 0) parts.push(m.admin_count_ledger_entries({ count: a.commissionCount }));
	if (!parts.length) return null;
	const blockers = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(parts.map(counterJoined));
	return m.admin_artists_delete_blocked({ blockers });
}
