import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
	SOCIAL_PLATFORM_NAMES,
	socialHandle,
	socialLabel,
	type SocialPlatform
} from './social-label';

// One table per platform covering the five URL shapes a stored setting takes.
// The three SONA-128 rules read straight off it: every `handle` case is @-
// prefixed, every `pathless` case is the platform name, and `deepLink` proves
// the handle comes from the first profile segment rather than the last.
const PLATFORMS: Array<{
	platform: SocialPlatform;
	name: string;
	/** A canonical profile URL for the handle "taro". */
	handle: string;
	/** The same profile with something appended — a post, a tab, a sub-page. */
	deepLink: string;
	/** The platform's own root, with no account in it at all. */
	pathless: string;
	/** The profile URL with a trailing slash. */
	trailingSlash: string;
	/** The profile URL with a www. host. */
	www: string;
}> = [
	{
		platform: 'twitter',
		name: 'Twitter',
		handle: 'https://twitter.com/taro',
		deepLink: 'https://twitter.com/taro/status/123',
		pathless: 'https://twitter.com',
		trailingSlash: 'https://twitter.com/taro/',
		www: 'https://www.twitter.com/taro'
	},
	{
		platform: 'instagram',
		name: 'Instagram',
		handle: 'https://instagram.com/taro',
		deepLink: 'https://instagram.com/taro/reels/',
		pathless: 'https://instagram.com',
		trailingSlash: 'https://instagram.com/taro/',
		www: 'https://www.instagram.com/taro'
	},
	{
		platform: 'telegram',
		name: 'Telegram',
		handle: 'https://t.me/taro',
		deepLink: 'https://t.me/taro/42',
		pathless: 'https://t.me',
		trailingSlash: 'https://t.me/taro/',
		www: 'https://www.t.me/taro'
	},
	{
		platform: 'bluesky',
		name: 'Bluesky',
		handle: 'https://bsky.app/profile/taro',
		deepLink: 'https://bsky.app/profile/taro/post/3k2a',
		pathless: 'https://bsky.app',
		trailingSlash: 'https://bsky.app/profile/taro/',
		www: 'https://www.bsky.app/profile/taro'
	},
	{
		platform: 'furaffinity',
		name: 'FurAffinity',
		handle: 'https://furaffinity.net/user/taro',
		deepLink: 'https://furaffinity.net/user/taro/gallery',
		pathless: 'https://furaffinity.net',
		trailingSlash: 'https://furaffinity.net/user/taro/',
		www: 'https://www.furaffinity.net/user/taro'
	},
	{
		platform: 'furtrack',
		name: 'FurTrack',
		handle: 'https://furtrack.com/user/taro',
		deepLink: 'https://furtrack.com/user/taro/photos',
		pathless: 'https://furtrack.com',
		trailingSlash: 'https://furtrack.com/user/taro/',
		www: 'https://www.furtrack.com/user/taro'
	},
	{
		platform: 'deviantart',
		name: 'DeviantArt',
		handle: 'https://deviantart.com/taro',
		deepLink: 'https://deviantart.com/taro/gallery/all',
		pathless: 'https://deviantart.com',
		trailingSlash: 'https://deviantart.com/taro/',
		www: 'https://www.deviantart.com/taro'
	},
	{
		platform: 'patreon',
		name: 'Patreon',
		handle: 'https://patreon.com/taro',
		deepLink: 'https://patreon.com/taro/posts',
		pathless: 'https://patreon.com',
		trailingSlash: 'https://patreon.com/taro/',
		www: 'https://www.patreon.com/taro'
	}
];

describe.each(PLATFORMS)('$name social labels', (p) => {
	it('names the platform exactly as the UI writes it', () => {
		expect(SOCIAL_PLATFORM_NAMES[p.platform]).toBe(p.name);
	});

	it.each([
		['a profile URL', 'handle'],
		['a deep link', 'deepLink'],
		['a trailing slash', 'trailingSlash'],
		['a www. host', 'www']
	] as const)('reads the handle from %s', (_desc, key) => {
		expect(socialHandle(p.platform, p[key])).toBe('taro');
		expect(socialLabel(p.platform, p[key])).toBe('@taro');
	});

	it('falls back to the platform name for a pathless URL', () => {
		expect(socialHandle(p.platform, p.pathless)).toBeNull();
		expect(socialLabel(p.platform, p.pathless)).toBe(p.name);
		// …and for the same URL written with a trailing slash.
		expect(socialLabel(p.platform, `${p.pathless}/`)).toBe(p.name);
	});

	it('falls back to the platform name when the setting is unset', () => {
		expect(socialLabel(p.platform, undefined)).toBe(p.name);
		expect(socialLabel(p.platform, null)).toBe(p.name);
		expect(socialLabel(p.platform, '')).toBe(p.name);
		expect(socialLabel(p.platform, '   ')).toBe(p.name);
	});
});

describe('rule 1: the @ prefix is uniform', () => {
	it('prefixes every platform, with no per-platform exceptions', () => {
		const labels = PLATFORMS.map((p) => socialLabel(p.platform, p.handle));
		expect(labels.every((l) => l.startsWith('@'))).toBe(true);
	});

	it('keeps the @ on a handle equal to the platform name', () => {
		// Regression: a fallback comparison against the platform name stripped the
		// @ from instagram.com/Instagram, a real account.
		expect(socialLabel('instagram', 'https://instagram.com/Instagram')).toBe('@Instagram');
	});

	it('does not double the @ on a value that already carries one', () => {
		expect(socialLabel('twitter', '@taro')).toBe('@taro');
	});
});

describe('rule 2: no hostname is ever shown as a handle', () => {
	it('never renders a label containing the platform domain', () => {
		// /connect's retired local handle() fell back to u.hostname here, so the
		// same stored setting read "@instagram.com" on /connect and "Instagram"
		// on /about. Both now say "Instagram".
		for (const p of PLATFORMS) {
			expect(socialLabel(p.platform, p.pathless)).not.toContain('.');
		}
	});

	it('falls back for an unparseable string rather than echoing it', () => {
		expect(socialLabel('twitter', 'not a url')).toBe('Twitter');
		expect(socialLabel('twitter', 'https://')).toBe('Twitter');
	});

	it('falls back for a scheme-less bare domain', () => {
		expect(socialLabel('instagram', 'instagram.com')).toBe('Instagram');
		expect(socialLabel('instagram', 'www.instagram.com')).toBe('Instagram');
	});

	it('never renders a section marker as a handle', () => {
		// The platform's own host with a path that is not a profile: the prefix
		// match fails and the first path segment is a section, not an account.
		// Written WITHOUT a trailing slash — the slashed forms already returned
		// null, which is how these walked past the table above.
		expect(socialLabel('furaffinity', 'https://www.furaffinity.net/gallery/taro')).toBe(
			'FurAffinity'
		);
		expect(socialLabel('bluesky', 'https://bsky.app/profile')).toBe('Bluesky');
		expect(socialLabel('bluesky', 'https://bsky.app/search')).toBe('Bluesky');
		expect(socialLabel('furtrack', 'https://www.furtrack.com/user')).toBe('FurTrack');
	});

	it('still reads a mirror host, which carries no prefix of its own', () => {
		// The rule-2 guard is scoped to the platform's OWN domains, so a host it
		// does not list keeps the first-path-segment reading.
		expect(socialHandle('twitter', 'https://x.com/taro')).toBe('taro');
		expect(socialHandle('twitter', 'https://mobile.twitter.com/taro')).toBe('taro');
	});
});

describe('rule 3: the handle is the first profile segment', () => {
	it('reads past a post, tab, or sub-page rather than into it', () => {
		// Both helpers used to take the LAST segment, so these read "@reels" and
		// "@123" — the deep link's tail, not the account.
		expect(socialLabel('instagram', 'https://www.instagram.com/taro/reels/')).toBe('@taro');
		expect(socialLabel('twitter', 'https://twitter.com/taro/status/123')).toBe('@taro');
	});

	it('skips the profile prefix on platforms that have one', () => {
		// The first path segment alone would be "user" / "profile".
		expect(socialLabel('furaffinity', 'https://www.furaffinity.net/user/taro/')).toBe('@taro');
		expect(socialLabel('bluesky', 'https://bsky.app/profile/taro.bsky.social')).toBe(
			'@taro.bsky.social'
		);
	});

	it('takes the Patreon creator-page username, not the /c/ marker', () => {
		expect(socialLabel('patreon', 'https://www.patreon.com/c/taro/posts')).toBe('@taro');
	});

	it('takes the Telegram channel name, not the /s/ preview marker', () => {
		expect(socialLabel('telegram', 'https://t.me/s/tarochannel')).toBe('@tarochannel');
	});

	it('reads a mirror host that carries no prefix as a single-segment profile', () => {
		expect(socialLabel('twitter', 'https://x.com/taro/status/123')).toBe('@taro');
		expect(socialLabel('twitter', 'https://mobile.twitter.com/taro')).toBe('@taro');
	});

	it('ignores query strings and fragments', () => {
		expect(socialLabel('twitter', 'https://twitter.com/taro?ref=sona')).toBe('@taro');
		expect(socialLabel('instagram', 'https://instagram.com/taro#photos')).toBe('@taro');
	});
});

describe('handle decoding', () => {
	it('decodes a percent-encoded handle', () => {
		expect(socialLabel('instagram', 'https://www.instagram.com/tar%C3%B6')).toBe('@tarö');
	});

	it('keeps the raw segment on a malformed escape', () => {
		expect(socialLabel('instagram', 'https://www.instagram.com/tar%ZZ')).toBe('@tar%ZZ');
	});

	it('preserves the handle casing the owner stored', () => {
		expect(socialLabel('twitter', 'https://twitter.com/TaroTheFox')).toBe('@TaroTheFox');
	});

	it('drops characters that would make the label read as another handle', () => {
		// Registry socials are proxied unmodified from a remote registry, so a
		// segment can decode to a bidi override or a zero-width character and make
		// an admin's search row read as somebody else's account — the art then
		// gets credited to the wrong artist.
		expect(socialLabel('twitter', 'https://twitter.com/%E2%80%AEorat')).toBe('@orat');
		expect(socialLabel('twitter', 'https://twitter.com/ta%E2%80%8Bro')).toBe('@taro');
		expect(socialLabel('twitter', 'https://twitter.com/taro%0Aevil')).toBe('@taroevil');
		expect(socialLabel('twitter', 'https://twitter.com/taro%00')).toBe('@taro');
	});

	it('falls back when nothing renderable survives the strip', () => {
		expect(socialHandle('twitter', 'https://twitter.com/%E2%80%AE')).toBeNull();
		expect(socialLabel('twitter', 'https://twitter.com/%E2%80%AE')).toBe('Twitter');
	});

	it('does not let a decoded delimiter extend the handle', () => {
		expect(socialLabel('twitter', 'https://twitter.com/a%2Fb')).toBe('@a');
	});
});

describe('scheme-less values', () => {
	// Registry socials are proxied unmodified and often arrive without a scheme.
	it('reads a handle out of a scheme-less profile URL', () => {
		expect(socialHandle('twitter', 'twitter.com/taro')).toBe('taro');
		expect(socialHandle('furaffinity', 'www.furaffinity.net/user/taro/gallery')).toBe('taro');
		expect(socialLabel('instagram', 'instagram.com/taro/reels/')).toBe('@taro');
	});

	it('keeps a bare Bluesky handle a handle rather than reparsing it as a host', () => {
		// It has dots but no slash, so the bare-handle branch has to claim it
		// first: read as a hostname it would be a "no handle here" URL.
		expect(socialHandle('bluesky', 'taro.bsky.social')).toBe('taro.bsky.social');
		expect(socialLabel('bluesky', 'taro.bsky.social')).toBe('@taro.bsky.social');
	});

	it('still refuses a value that carries a scheme and does not parse', () => {
		expect(socialHandle('twitter', 'https://')).toBeNull();
	});
});

// SONA-128's point was one rule everywhere, so the surfaces are pinned as well
// as the helper: a page that grows its own handle() is how the three rules
// diverged in the first place. Source scan rather than render — these pages pull
// in $app/state and paraglide, which this pure-TS vitest setup does not provide.
describe('every surface renders socials through this module', () => {
	it.each([
		['/about', '../routes/(public)/about/+page.svelte'],
		['/connect', '../routes/(paths)/connect/+page.svelte'],
		['/share', '../routes/(paths)/share/+page.svelte'],
		['NewArtistDialog', './components/NewArtistDialog.svelte']
	])('%s takes its handles from the shared module and defines no local one', (_name, path) => {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		// NewArtistDialog reaches it through $lib/registry-search's resultHandle.
		expect(source).toMatch(/from '\$lib\/(social-label|registry-search)'/);
		// Both spellings: a `const handle = (url) => …` is the same helper.
		expect(source).not.toMatch(/function handle\s*\(|(?:const|let)\s+handle\s*=\s*\(/);
	});

	// Repo-wide rather than a list of four: the next page to render a social is
	// not on that list, and a hand-rolled helper is recognizable by what it does
	// — splitting a path apart — in whatever form it is written.
	it('no component splits a URL path into a handle by hand', () => {
		const dir = new URL('../', import.meta.url).pathname;
		// The shared module itself is a .ts and so is never in this list.
		// VrAvatarForm splits a model URL down to its FILENAME, not a handle.
		const allowed = ['lib/components/VrAvatarForm.svelte'];
		const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
			(f) => f.endsWith('.svelte') && !allowed.includes(f)
		);
		expect(files.length).toBeGreaterThan(20); // the scan actually matched something
		const offenders = files.filter((f) =>
			/pathname\s*\.split|\.split\(['"]\/['"]\)/.test(readFileSync(dir + f, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});
});

describe('bare handles', () => {
	it('accepts a bare handle, as registry payloads carry them', () => {
		expect(socialHandle('twitter', 'taro')).toBe('taro');
		expect(socialHandle('twitter', '@taro')).toBe('taro');
		expect(socialHandle('bluesky', 'taro.bsky.social')).toBe('taro.bsky.social');
	});

	it('rejects an @ with nothing behind it', () => {
		expect(socialHandle('twitter', '@')).toBeNull();
		expect(socialLabel('twitter', '@')).toBe('Twitter');
	});
});
