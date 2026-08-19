// RSS 2.0 serializer for the site's combined "what's new" feed (SONA-172).
//
// Split out from the route so the XML shape is unit-testable without a database:
// the route decides WHICH rows a request may see (publication, NSFW gating,
// the fursuit license predicate), this module decides how any set of rows is
// spelled. Nothing here reads settings or the environment.
//
// RSS 2.0 rather than Atom because that is what the reader ecosystem this
// feature exists for (feed readers subscribing to an art gallery) universally
// accepts, and Media RSS — the only standard way to attach a thumbnail to an
// item — is defined against it.

/** Media RSS: the thumbnail and the artist credit ride here. */
const NS_MEDIA = 'http://search.yahoo.com/mrss/';
/** Dublin Core: dc:creator is what most readers show as the item's author. */
const NS_DC = 'http://purl.org/dc/elements/1.1/';
/** Atom, for `atom:link rel="self"` — the canonical address of this document. */
const NS_ATOM = 'http://www.w3.org/2005/Atom';

/**
 * The RTA self-labelling token, verbatim and case-sensitive. It is a fixed
 * string, not a template: filtering software matches it literally, so a typo
 * makes the label invisible rather than wrong-looking.
 */
export const RTA_LABEL = 'RTA-5042-1996-1400-1577-RTA';

/** Prefix on the title of an adult item, so a reader that renders nothing but
 * titles still warns before the thumbnail loads. */
const NSFW_TITLE_PREFIX = '[NSFW] ';

export interface FeedItem {
	/** Plain, unprefixed title — the NSFW prefix is applied here, not by callers. */
	title: string;
	/** Absolute URL of the page this entry is about. Also the guid. */
	link: string;
	/** ISO-8601 instant from the row's `created_at`. Invalid/empty → no pubDate. */
	createdAt: string;
	/** Plain-text description. Art has none until SONA-173 wires one in. */
	description?: string;
	/** Absolute image URL for media:content. Omitted when the row has no image. */
	imageUrl?: string;
	/** Artist / photographer credit, rendered as dc:creator and media:credit. */
	credit?: string;
	/** Whether this entry is adult. Only ever true on a keyed (NSFW) feed. */
	nsfw?: boolean;
}

export interface FeedChannel {
	title: string;
	/** Absolute site origin — the channel's `link`. */
	link: string;
	description: string;
	copyright: string;
	/** Absolute URL this document was served from, for atom:link rel="self".
	 * Optional: the element is omitted when naming the address would publish a
	 * credential inside the document (the keyed adult feed). */
	selfUrl?: string;
	/** RFC-822 `lastBuildDate`. Omitted when there are no items to date it by. */
	lastBuildDate?: string;
	/** True on the keyed feed: adds the channel-level RTA label. */
	adult?: boolean;
}

/**
 * Escape text for an XML text node or attribute value. All five predefined
 * entities, so one helper serves both positions and no caller has to remember
 * which context it is in.
 *
 * Control characters that XML 1.0 cannot represent at all (§2.2 allows only
 * tab, LF and CR below 0x20) are dropped rather than escaped — `&#x0;` is not
 * well-formed either, and a stray control byte in a stored title must not be
 * able to make the whole document unparseable for every subscriber.
 */
export function escapeXml(value: string): string {
	return value
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * An ISO instant as RSS wants it (RFC 822 with a 4-digit year, per the spec's
 * own note). `toUTCString` is exactly that form — "Sat, 01 Aug 2026 00:00:00
 * GMT" — and is locale-independent by definition, unlike toLocaleString.
 *
 * Returns null for anything unparseable, and callers omit the element rather
 * than emit "Invalid Date": a reader that cannot parse pubDate typically falls
 * back to fetch time, which is a far smaller lie than a broken date.
 */
export function rfc822(iso: string): string | null {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date.toUTCString();
}

function element(name: string, value: string, indent: string): string {
	return `${indent}<${name}>${escapeXml(value)}</${name}>`;
}

function renderItem(item: FeedItem): string {
	const lines: string[] = ['\t\t<item>'];
	lines.push(element('title', (item.nsfw ? NSFW_TITLE_PREFIX : '') + item.title, '\t\t\t'));
	lines.push(element('link', item.link, '\t\t\t'));
	// isPermaLink is the default, but stating it is what tells a reader the guid
	// is safe to resolve — and the guid IS the page URL, so dedupe survives a
	// title edit.
	lines.push(`\t\t\t<guid isPermaLink="true">${escapeXml(item.link)}</guid>`);
	const pubDate = rfc822(item.createdAt);
	if (pubDate) lines.push(element('pubDate', pubDate, '\t\t\t'));
	if (item.description) lines.push(element('description', item.description, '\t\t\t'));
	if (item.credit) {
		lines.push(element('dc:creator', item.credit, '\t\t\t'));
		lines.push(element('media:credit', item.credit, '\t\t\t'));
	}
	if (item.imageUrl) {
		lines.push(
			`\t\t\t<media:content url="${escapeXml(item.imageUrl)}" medium="image" />`,
			`\t\t\t<media:thumbnail url="${escapeXml(item.imageUrl)}" />`
		);
	}
	// The per-item half of the in-band NSFW marking. A reader that ignores the
	// channel rating still gets a category it can filter or badge on.
	if (item.nsfw) lines.push(element('category', 'NSFW', '\t\t\t'));
	lines.push('\t\t</item>');
	return lines.join('\n');
}

/**
 * The whole document. Deterministic: same inputs, byte-identical output — which
 * is what makes the route's ETag a hash of this string rather than of a
 * separately-assembled summary of the rows.
 */
export function renderFeed(channel: FeedChannel, items: FeedItem[]): string {
	const head: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<rss version="2.0" xmlns:media="${NS_MEDIA}" xmlns:dc="${NS_DC}" xmlns:atom="${NS_ATOM}">`,
		'\t<channel>',
		element('title', channel.title, '\t\t'),
		element('link', channel.link, '\t\t'),
		element('description', channel.description, '\t\t'),
		element('copyright', channel.copyright, '\t\t')
	];
	// rel="self" is optional in RSS, and a document whose address is a secret has
	// to leave it out: the body travels further than the subscription URL does.
	if (channel.selfUrl) {
		head.push(
			`\t\t<atom:link href="${escapeXml(channel.selfUrl)}" rel="self" type="application/rss+xml" />`
		);
	}
	if (channel.lastBuildDate) head.push(element('lastBuildDate', channel.lastBuildDate, '\t\t'));
	// Channel-level adult self-label. Never emitted on the public SFW document —
	// labelling the SFW feed adult would get the whole site filtered.
	if (channel.adult) head.push(element('rating', RTA_LABEL, '\t\t'));

	return [...head, ...items.map(renderItem), '\t</channel>', '</rss>', ''].join('\n');
}
