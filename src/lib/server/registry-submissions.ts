// Pure helpers for reconciling this fork's registry submissions and the shared
// catalog with the local artists table. Used by the admin artists page load so
// that an APPROVED submission immediately marks the artist as shared (and blocks
// resubmission), instead of waiting for the next background sync.

import { type RegistryArtist, type RegistrySubmission } from './registry';
import { handlesOverlap } from './handle-normalize';

/** A local artist as seen by these helpers: name, link state, and social columns. */
export type ArtistForSubmission = { name: string; globalId?: string | null } & Record<
	string,
	unknown
>;

/** Does a submission concern this local artist? An update targets the artist's
 *  global id; a create (the artist isn't linked yet) is matched by the proposed
 *  display name. Mirrors the pending/rejected matching on the artists page. */
function submissionMatchesArtist(sub: RegistrySubmission, artist: ArtistForSubmission): boolean {
	if (sub.targetGlobalId) return !!artist.globalId && sub.targetGlobalId === artist.globalId;
	try {
		return (JSON.parse(sub.payload).displayName as string) === artist.name;
	} catch {
		return false;
	}
}

/** The registry global id an APPROVED submission linked this artist to, or null
 *  when the artist is already linked, no approved submission matches, or the
 *  approval carries no resolvable id. This is how a fork learns its artist's id
 *  the moment the maintainer approves — the same link the background sync would
 *  eventually stamp. `submissions` is newest-first, so the first match wins. */
export function approvedSubmissionGlobalId(
	artist: ArtistForSubmission,
	submissions: RegistrySubmission[]
): string | null {
	if (artist.globalId) return null;
	const sub = submissions.find((s) => submissionMatchesArtist(s, artist));
	if (!sub || sub.status !== 'approved') return null;
	return sub.targetGlobalId ?? sub.matchedGlobalId ?? null;
}

/** Is this (possibly unlinked) local artist already present in the shared
 *  catalog? Matched by a shared social handle or an exact display name, so a
 *  fork can't submit a duplicate of an artist that already exists. */
export function artistInCatalog(artist: ArtistForSubmission, catalog: RegistryArtist[]): boolean {
	const localName = artist.name.trim().toLowerCase();
	return catalog.some((entry) => {
		if (entry.status !== 'active') return false;
		if (handlesOverlap(artist, entry.socials ?? {})) return true;
		return !!localName && entry.displayName.trim().toLowerCase() === localName;
	});
}
