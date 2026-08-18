import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { socialAtHandle, socialHandle, socialLabel, type SocialPlatform } from './social-label';

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
	it.each([
		['a profile URL', 'handle'],
		['a deep link', 'deepLink'],
		['a trailing slash', 'trailingSlash'],
		['a www. host', 'www']
	] as const)('reads the handle from %s', (_desc, key) => {
		expect(socialHandle(p.platform, p[key])).toBe('taro');
		expect(socialAtHandle(p.platform, p[key])).toBe('@taro');
		expect(socialLabel(p.platform, p[key])).toBe('@taro');
	});

	it('falls back to the platform name for a pathless URL', () => {
		expect(socialHandle(p.platform, p.pathless)).toBeNull();
		expect(socialAtHandle(p.platform, p.pathless)).toBeNull();
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

	it('puts the @ on in one place, so no surface can render a bare handle', () => {
		// Every surface that shows a handle calls socialAtHandle: /about's chips,
		// /connect's and /share's rows, and registry-search's result rows. None of
		// them writes its own '@', so this is the only assertion the rule needs —
		// and socialLabel is built on the same call, which is why the two can no
		// longer disagree about the prefix.
		for (const p of PLATFORMS) {
			const at = socialAtHandle(p.platform, p.handle);
			expect(at).toBe(`@${socialHandle(p.platform, p.handle)}`);
			expect(socialLabel(p.platform, p.handle)).toBe(at);
		}
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

	it('never renders an opaque token as a handle', () => {
		// Neither names an account: the Patreon form carries the id in the query
		// string, and '+' opens a Telegram invite hash — no platform here allows
		// it in a username.
		expect(socialLabel('patreon', 'https://www.patreon.com/user?u=12345')).toBe('Patreon');
		expect(socialLabel('patreon', 'https://patreon.com/user')).toBe('Patreon');
		expect(socialLabel('telegram', 'https://t.me/+AbCdEf')).toBe('Telegram');
		// The ordinary forms still read, so neither rule swallowed a real handle.
		expect(socialLabel('patreon', 'https://patreon.com/taro')).toBe('@taro');
		expect(socialLabel('telegram', 'https://t.me/taro')).toBe('@taro');
	});

	it('never renders one of the sections this app itself links to', () => {
		// t.me/addstickers/<pack> is the URL the sticker importer consumes (see
		// server/telegram.ts), so pasting one into the Telegram setting is a
		// realistic slip — and it used to read as "@addstickers".
		expect(socialLabel('telegram', 'https://t.me/addstickers/SonaPack')).toBe('Telegram');
		expect(socialLabel('telegram', 'https://t.me/share/url?url=x')).toBe('Telegram');
		expect(socialLabel('twitter', 'https://twitter.com/compose/tweet')).toBe('Twitter');
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

	it('reads every aliased host the platform lists in the table', () => {
		// x.com and mobile.twitter.com are Twitter's own, each with a prefix of its
		// own in HOST_PREFIXES, so both resolve like twitter.com does.
		expect(socialHandle('twitter', 'https://x.com/taro')).toBe('taro');
		expect(socialHandle('twitter', 'https://mobile.twitter.com/taro')).toBe('taro');
	});

	it('reads a subdomain of a listed host', () => {
		// The host match is by suffix, so the subdomains a platform actually serves
		// profiles on resolve through the same profile prefix.
		expect(socialHandle('furaffinity', 'https://sfw.furaffinity.net/user/taro')).toBe('taro');
		expect(socialHandle('bluesky', 'https://staging.bsky.app/profile/taro')).toBe('taro');
	});

	it('derives nothing from a host the platform does not serve', () => {
		// A third-party front end, or a URL filed under the wrong setting: the path
		// is not this platform's, so its first segment is nobody's handle here.
		expect(socialLabel('twitter', 'https://nitter.net/taro')).toBe('Twitter');
		expect(socialLabel('bluesky', 'https://deer.social/profile/taro.bsky.social')).toBe('Bluesky');
		expect(socialHandle('instagram', 'https://evil.example/taro')).toBeNull();
	});

	it('never reads one of the platform own sections as an account', () => {
		// Instagram's own "Copy link" produces the /p/ form, and these platforms'
		// profile prefix is the bare domain, so nothing in the path tells a post
		// from an account except the section name itself.
		expect(socialLabel('instagram', 'https://www.instagram.com/p/C8xYzAbCdEf/')).toBe('Instagram');
		expect(socialLabel('instagram', 'https://instagram.com/reel/C8xYzAbCdEf')).toBe('Instagram');
		expect(socialLabel('instagram', 'https://instagram.com/explore/tags/fursuit')).toBe(
			'Instagram'
		);
		expect(socialLabel('twitter', 'https://x.com/i/communities/123')).toBe('Twitter');
		expect(socialLabel('twitter', 'https://twitter.com/search?q=taro')).toBe('Twitter');
		expect(socialLabel('patreon', 'https://www.patreon.com/posts/some-post-123')).toBe('Patreon');
		expect(socialLabel('deviantart', 'https://www.deviantart.com/tag/fursuit')).toBe('DeviantArt');
		// Case-insensitively, and including the degenerate prefix-without-a-name
		// forms that the longest-first prefix list would otherwise collapse.
		expect(socialLabel('instagram', 'https://instagram.com/Reels/C8xYz')).toBe('Instagram');
		expect(socialLabel('telegram', 'https://t.me/s')).toBe('Telegram');
		expect(socialLabel('patreon', 'https://patreon.com/c')).toBe('Patreon');
	});

	it('covers the browse and account sections these two platforms also serve', () => {
		// Same rule, sections that were missing from the table: both platforms put
		// their own navigation on the bare domain, so a copied browse or sign-in URL
		// read as an account.
		expect(socialLabel('deviantart', 'https://www.deviantart.com/search?q=fursuit')).toBe(
			'DeviantArt'
		);
		expect(socialLabel('deviantart', 'https://www.deviantart.com/shop/art')).toBe('DeviantArt');
		expect(socialLabel('deviantart', 'https://www.deviantart.com/daily-deviations')).toBe(
			'DeviantArt'
		);
		expect(socialLabel('patreon', 'https://www.patreon.com/login')).toBe('Patreon');
		expect(socialLabel('patreon', 'https://www.patreon.com/home')).toBe('Patreon');
		expect(socialLabel('patreon', 'https://www.patreon.com/search?q=fursuit')).toBe('Patreon');
		expect(socialLabel('patreon', 'https://www.patreon.com/explore/anime')).toBe('Patreon');
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

	it('reads past the deep link on an aliased host too', () => {
		expect(socialLabel('twitter', 'https://x.com/taro/status/123')).toBe('@taro');
		expect(socialLabel('twitter', 'https://mobile.twitter.com/taro')).toBe('@taro');
		expect(socialLabel('furaffinity', 'https://sfw.furaffinity.net/user/taro/gallery')).toBe(
			'@taro'
		);
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

	it('refuses a segment carrying characters that hide what it says', () => {
		// Registry socials are proxied unmodified from a remote registry, so a
		// segment can decode to a bidi override or a zero-width character and make
		// an admin's search row read as somebody else's account — the art then
		// gets credited to the wrong artist. Stripping them would render a handle
		// the URL does not support: twitter.com/ta<ZWSP>ro is not @taro, and a row
		// reading "@taro" that links elsewhere is the whole attack. So the label
		// falls back to the platform name instead.
		const hidden = [
			['%E2%80%AEorat', 'RLO, U+202E'],
			['ta%E2%80%8Bro', 'zero-width space, U+200B'],
			['ta%EF%BB%BFro', 'zero-width no-break space, U+FEFF'],
			['ta%C2%ADro', 'soft hyphen, U+00AD'],
			['ta%D8%9Cro', 'Arabic letter mark, U+061C'],
			['ta%E1%A0%8Ero', 'Mongolian vowel separator, U+180E'],
			['ta%E2%81%A0ro', 'word joiner, U+2060'],
			['ta%E2%81%A3ro', 'invisible separator, U+2063'],
			['ta%EF%B8%80ro', 'variation selector, U+FE00'],
			['ta%E1%85%9Fro', 'Hangul choseong filler, U+115F'],
			['ta%E1%85%A0ro', 'Hangul jungseong filler, U+1160'],
			['ta%E3%85%A4ro', 'Hangul filler, U+3164'],
			['ta%E2%80%A8ro', 'line separator, U+2028'],
			['ta%E2%80%A9ro', 'paragraph separator, U+2029'],
			['ta%F3%A0%80%81ro', 'language tag, U+E0001'],
			['taro%0Aevil', 'newline'],
			['taro%00', 'NUL'],
			// No platform here allows a space in a username, and a trailing one
			// collapses in an inline box: the row would read "@taro" while linking
			// to a different account.
			['taro%20', 'trailing space, U+0020'],
			['ta%C2%A0ro', 'no-break space, U+00A0'],
			['ta%E3%80%80ro', 'ideographic space, U+3000'],
			['ta%E2%80%89ro', 'thin space, U+2009'],
			['taro%E2%A0%80', 'Braille pattern blank, U+2800'],
			['%20', 'a space alone, which would render the bare label "@ "'],
			// Default-ignorable but not \p{Cf}, and so missed by every hand-written
			// list: these are why the check names a Unicode property instead.
			['taro%F3%A0%84%80', 'variation selector supplement, U+E0100'],
			['taro%EF%BE%A0', 'halfwidth Hangul filler, U+FFA0'],
			['ta%E1%A0%8Bro', 'Mongolian free variation selector, U+180B'],
			['ta%CD%8Fro', 'combining grapheme joiner, U+034F']
		] as const;
		for (const [segment, what] of hidden) {
			expect(socialHandle('twitter', `https://twitter.com/${segment}`), what).toBeNull();
			expect(socialLabel('twitter', `https://twitter.com/${segment}`), what).toBe('Twitter');
		}
	});

	it('falls back when the segment decodes to nothing at all', () => {
		expect(socialHandle('twitter', 'https://twitter.com/%E2%80%AE')).toBeNull();
		expect(socialLabel('twitter', 'https://twitter.com/%E2%80%AE')).toBe('Twitter');
	});

	it('does not let a decoded delimiter extend the handle', () => {
		expect(socialLabel('twitter', 'https://twitter.com/a%2Fb')).toBe('@a');
	});
});

describe('scheme-less values', () => {
	it('reads a protocol-relative URL, as registry matching does', () => {
		// normalizeHandle strips the leading '//' (see handle-classify's tests), so
		// display has to as well — otherwise the module header's claim that the two
		// agree about where a handle starts is false for a shape the registry hands
		// us routinely, and the admin's search row silently shows no handle.
		expect(socialHandle('twitter', '//twitter.com/taro')).toBe('taro');
		expect(socialLabel('twitter', '//www.twitter.com/taro')).toBe('@taro');
		expect(socialLabel('twitter', '//twitter.com')).toBe('Twitter');
	});

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

	it('refuses slash-bearing junk rather than reading a host out of it', () => {
		// The scheme-less retry only applies to text that opens with something
		// host-shaped. Otherwise the registry value "n/a" parses as the host "n"
		// with the handle "a".
		expect(socialLabel('twitter', 'n/a')).toBe('Twitter');
		expect(socialLabel('twitter', 'taro/photos')).toBe('Twitter');
		expect(socialLabel('twitter', 'see my profile/here')).toBe('Twitter');
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
		// Rule 1's @ comes from socialAtHandle, never from the surface. A page that
		// interpolates its own prefix carries the rule only until someone edits that
		// line, and /share did exactly that until this scan went in.
		expect(source).not.toMatch(/'@'\s*\+|`@\$\{/);
	});

	// Repo-wide rather than a list of four: the next page to render a social is
	// not on that list, and a hand-rolled helper is recognizable by what it does
	// — splitting a path apart — in whatever form it is written.
	it('no component splits a URL path into a handle by hand', () => {
		// fileURLToPath, not .pathname: the latter is percent-encoded, so a checkout
		// under a path with a space in it would fail this scan for reasons that
		// have nothing to do with drift.
		const dir = fileURLToPath(new URL('../', import.meta.url));
		// The shared module itself is a .ts and so is never in this list.
		// VrAvatarForm splits a model URL down to its FILENAME, not a handle.
		const allowed = ['lib/components/VrAvatarForm.svelte'];
		const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
			(f) => f.endsWith('.svelte') && !allowed.includes(f)
		);
		expect(files.length).toBeGreaterThan(20); // the scan actually matched something
		const offenders = files.filter((f) =>
			/pathname\s*\.split|\.split\(['"]\/['"]\)/.test(readFileSync(join(dir, f), 'utf8'))
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

	it('renders the platform name for another platform’s bare domain', () => {
		// A pathless bare domain is a scheme-less URL whoever owns it, so rule 2
		// applies whether or not it is this platform's own host. Filing a Twitter
		// link under the Telegram setting is an ordinary slip, and the scheme-less
		// spelling used to read as the handle "@twitter.com".
		expect(socialHandle('telegram', 'twitter.com')).toBeNull();
		expect(socialLabel('telegram', 'twitter.com')).toBe('Telegram');
		// Both spellings of the same value have to agree; only the second one did.
		expect(socialLabel('telegram', 'https://twitter.com')).toBe('Telegram');
		expect(socialLabel('instagram', 'bsky.app')).toBe('Instagram');
	});

	it('still reads a domain-shaped handle as a handle', () => {
		// The rejection is of hostnames these platforms live on, not of dots:
		// Bluesky handles are domains, and most of them belong to nobody here.
		expect(socialHandle('bluesky', 'taro.bsky.social')).toBe('taro.bsky.social');
		expect(socialLabel('bluesky', 'taro.example.com')).toBe('@taro.example.com');
	});

	it('rejects an @ with nothing behind it', () => {
		expect(socialHandle('twitter', '@')).toBeNull();
		expect(socialLabel('twitter', '@')).toBe('Twitter');
	});
});
