// Does a local artist still differ from its registry catalog entry? Drives the
// "submit to shared registry" guard on the admin artists page: a linked artist
// that already matches the registry has nothing to submit.
//
// Mirrors the registry's own noise rules (sona-registry src/lib/diff.ts): social
// values compared by NORMALIZED handle (so twitter.com vs x.com, a trailing slash
// or an @ prefix don't count), whitespace trimmed, null/'' equivalent, aliases
// compared as a set. Only the fields the fork actually owns are compared — name,
// socials, and (registry-synced) aliases. Avatar is registry-managed (the daily
// refresh) and the fork has no bio field, so neither is part of "up to date".

import { normalizeHandle, SOCIAL_KEY_TO_PLATFORM, type Platform } from './handle-normalize';
import { parseAliases, SOCIAL_URL_KEYS, type RegistryArtist, type ArtistAlias } from './registry';

/** A local artist row: name + the *Url social columns + the aliases JSON column. */
export type LocalArtistForDiff = { name: string; aliases?: string | null } & Record<string, unknown>;

function emptyToNull(v: unknown): string | null {
	if (v == null) return null;
	const s = String(v).trim();
	return s === '' ? null : s;
}

function handleEqual(platform: Platform, a: unknown, b: unknown): boolean {
	const as = typeof a === 'string' ? a : null;
	const bs = typeof b === 'string' ? b : null;
	return normalizeHandle(platform, as) === normalizeHandle(platform, bs);
}

/** Order-independent, formatting-independent signature for an alias. */
function aliasSignature(a: ArtistAlias): string {
	const name = (a.displayName || '').trim().toLowerCase();
	const socials = a.socials || {};
	const handles = Object.keys(socials)
		.map((k) => {
			const platform = SOCIAL_KEY_TO_PLATFORM[k];
			const raw = typeof socials[k] === 'string' ? (socials[k] as string) : null;
			return `${k}:${platform ? normalizeHandle(platform, raw) : emptyToNull(raw)}`;
		})
		.sort()
		.join(',');
	return `${name}|${handles}`;
}

/** The fields that differ between a local artist and its registry entry (empty =
 * identical). Keys: 'displayName', 'socials.<key>', 'aliases'. */
export function registryDiffFields(local: LocalArtistForDiff, registry: RegistryArtist): string[] {
	const changed: string[] = [];

	if (emptyToNull(local.name) !== emptyToNull(registry.displayName)) changed.push('displayName');

	const regSocials = registry.socials || {};
	for (const key of SOCIAL_URL_KEYS) {
		const platform = SOCIAL_KEY_TO_PLATFORM[key];
		if (!handleEqual(platform, local[key], regSocials[key])) changed.push(`socials.${key}`);
	}

	const localAliases = new Set(parseAliases(local.aliases).map(aliasSignature));
	const regAliases = new Set((registry.aliases ?? []).map(aliasSignature));
	const aliasesEqual =
		localAliases.size === regAliases.size && [...localAliases].every((s) => regAliases.has(s));
	if (!aliasesEqual) changed.push('aliases');

	return changed;
}

/** True when the local artist has something worth submitting to the registry. */
export function artistDiffersFromRegistry(local: LocalArtistForDiff, registry: RegistryArtist): boolean {
	return registryDiffFields(local, registry).length > 0;
}
