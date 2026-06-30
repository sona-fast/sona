import type { LicenseInfo } from './license';

/** A fursuit photo, normalized from FurTrack into what the UI needs. */
export interface FursuitPhoto {
	/** FurTrack post id. */
	id: number;
	/** Canonical FurTrack page, e.g. https://www.furtrack.com/p/123456 */
	furtrackUrl: string;
	/** Photo description from FurTrack (postDescription); empty/missing when none. */
	description?: string;
	/** Full-resolution image on FurTrack's CDN (orca2). */
	imageUrl: string;
	width?: number;
	height?: number;
	/** Photographer handle (from the `3:` tag). */
	photographer: string;
	/** Photographer's FurTrack profile, if known. */
	photographerUrl?: string;
	/** Event / convention (from a `5:` tag), e.g. "FWA 2026". */
	event?: string;
	/** Character (from the `1:` tag) this photo was matched on. */
	character?: string;
	/** Remaining general tags (species, etc.). */
	tags: string[];
	/** ISO date the photo was taken, if available. */
	takenAt?: string;
	/** Resolved per-photo license. Only `license.displayable` photos are ever returned publicly. */
	license: LicenseInfo;
	/**
	 * If set, the admin recorded direct permission from the photographer for this
	 * specific photo (e.g. "Telegram DM 2026-05-29"). Such photos render publicly
	 * even when the license alone doesn't permit it; gating is
	 * `license.displayable || !!permissionSource`.
	 */
	permissionSource?: string;
}

export type FurtrackMode = 'off' | 'mock' | 'live';
