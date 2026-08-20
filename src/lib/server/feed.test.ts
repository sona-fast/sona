import { describe, it, expect } from 'vitest';
import { renderFeed, escapeXml, rfc822, RTA_LABEL, type FeedItem } from './feed';

// The serializer's whole job is producing a document a feed reader can parse, so
// these tests tokenize the output rather than substring-match it: asserting the
// string CONTAINS "<title>" would pass on output no reader could read.
//
// The tokenizer below is deliberately minimal — the repo carries no XML parser
// and this change is not the place to add a dependency — but it is a real check,
// not a regex: it fails on unbalanced tags and on any `&` that is not a
// well-formed entity reference, which are the two ways a serializer that
// forgets to escape actually breaks.

interface Node {
	name: string;
	attrs: Record<string, string>;
	text: string;
	children: Node[];
}

const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
// The trailing group is `/` on a self-closing element and `?` on the XML
// declaration, which is why it is a class rather than a bare `/?`.
const TOKEN = /<([?!/]?)([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*([/?]?)>/g;

/** Unescape the five predefined entities, so an assertion compares the ORIGINAL
 * text a reader would render. */
function unescape(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/**
 * Parse a rendered feed into a tree, throwing on anything a conforming parser
 * would reject: a stray `<` or `&` in character data, a mismatched close tag, or
 * an unclosed element at end of document.
 */
function parse(xml: string): Node {
	// Every ampersand must open a valid entity reference. Blanking the valid ones
	// first means a survivor is a raw `&` the serializer failed to escape.
	const withoutEntities = xml.replace(ENTITY, '');
	if (withoutEntities.includes('&')) throw new Error('unescaped & in output');

	const root: Node = { name: '#document', attrs: {}, text: '', children: [] };
	const stack: Node[] = [root];
	let cursor = 0;
	let match: RegExpExecArray | null;
	TOKEN.lastIndex = 0;
	while ((match = TOKEN.exec(xml))) {
		const [raw, prefix, name, attrText, selfClose] = match;
		// Character data between the previous tag and this one belongs to the open
		// element. A `<` here is markup the tokenizer could not read as a tag.
		const chars = xml.slice(cursor, match.index);
		if (chars.includes('<')) throw new Error('unescaped < in character data');
		stack[stack.length - 1].text += unescape(chars);
		cursor = match.index + raw.length;

		// <?xml ...?> and any declaration are not elements.
		if (prefix === '?' || prefix === '!') continue;
		if (prefix === '/') {
			const open = stack.pop();
			if (!open || open.name !== name) throw new Error(`close </${name}> does not match open`);
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const [, key, value] of attrText.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
			attrs[key] = unescape(value);
		}
		const node: Node = { name, attrs, text: '', children: [] };
		stack[stack.length - 1].children.push(node);
		if (!selfClose) stack.push(node);
	}
	if (stack.length !== 1) throw new Error(`${stack.length - 1} unclosed element(s)`);
	return root;
}

const child = (node: Node, name: string): Node | undefined =>
	node.children.find((c) => c.name === name);
const children = (node: Node, name: string): Node[] =>
	node.children.filter((c) => c.name === name);
/** An element's text content, or undefined when the element is absent — so a
 * test can tell "empty value" from "element not emitted". */
const textOf = (node: Node, name: string): string | undefined => child(node, name)?.text;

function channelOf(xml: string): Node {
	const rss = child(parse(xml), 'rss');
	if (!rss) throw new Error('no <rss> root');
	const channel = child(rss, 'channel');
	if (!channel) throw new Error('no <channel>');
	return channel;
}

const CHANNEL = {
	title: 'Taro Surf',
	link: 'https://taro.surf',
	description: 'New work.',
	copyright: 'All artwork belongs to their respective artists.',
	selfUrl: 'https://taro.surf/feed.xml'
};

const ITEM: FeedItem = {
	title: 'Parent Piece',
	link: 'https://taro.surf/gallery/parent-piece',
	createdAt: '2026-07-01T00:00:00.000Z',
	credit: 'Artist',
	imageUrl: 'https://taro.surf/img/parent.png'
};

describe('the test tokenizer itself', () => {
	// A validator that accepts everything would make every assertion below
	// vacuous, so prove it rejects the two failures it exists to catch.
	it('rejects a raw ampersand and a mismatched close tag', () => {
		expect(() => parse('<a>Ben & Jerry</a>')).toThrow(/unescaped &/);
		expect(() => parse('<a><b></a></b>')).toThrow(/does not match/);
		expect(() => parse('<a><b></b>')).toThrow(/unclosed/);
	});
});

describe('renderFeed — document shape', () => {
	it('produces a well-formed RSS 2.0 document with the channel fields', () => {
		const channel = channelOf(renderFeed(CHANNEL, [ITEM]));
		const rss = child(parse(renderFeed(CHANNEL, [ITEM])), 'rss')!;
		expect(rss.attrs.version).toBe('2.0');
		expect(textOf(channel, 'title')).toBe('Taro Surf');
		expect(textOf(channel, 'link')).toBe('https://taro.surf');
		expect(textOf(channel, 'description')).toBe('New work.');
		expect(textOf(channel, 'copyright')).toBe('All artwork belongs to their respective artists.');
	});

	it('names its own address in atom:link rel=self', () => {
		const channel = channelOf(renderFeed(CHANNEL, [ITEM]));
		const self = child(channel, 'atom:link')!;
		expect(self.attrs.href).toBe('https://taro.surf/feed.xml');
		expect(self.attrs.rel).toBe('self');
		expect(self.attrs.type).toBe('application/rss+xml');
	});

	it('omits atom:link when no address is given', () => {
		// The keyed adult feed passes none: its address is a credential, and
		// rel="self" would print it in the body. Still well-formed without it.
		const channel = channelOf(renderFeed({ ...CHANNEL, selfUrl: undefined }, [ITEM]));
		expect(child(channel, 'atom:link')).toBeUndefined();
		expect(textOf(channel, 'title')).toBe('Taro Surf');
	});

	it('declares every namespace the items actually use', () => {
		// A reader that meets media:content under an undeclared prefix is entitled
		// to reject the whole document, so prefixes and declarations ship together.
		const rss = child(parse(renderFeed(CHANNEL, [ITEM])), 'rss')!;
		expect(rss.attrs['xmlns:media']).toBe('http://search.yahoo.com/mrss/');
		expect(rss.attrs['xmlns:dc']).toBe('http://purl.org/dc/elements/1.1/');
		expect(rss.attrs['xmlns:atom']).toBe('http://www.w3.org/2005/Atom');
	});

	it('renders an empty channel that still parses', () => {
		// A brand-new fork with nothing published must serve a valid document
		// rather than a truncated one, or a reader records a permanent parse error.
		const channel = channelOf(renderFeed(CHANNEL, []));
		expect(children(channel, 'item')).toHaveLength(0);
		expect(textOf(channel, 'title')).toBe('Taro Surf');
		// Nothing to date the build by, so the element is absent rather than epoch.
		expect(textOf(channel, 'lastBuildDate')).toBeUndefined();
	});
});

describe('renderFeed — item fields', () => {
	const only = (item: FeedItem) => children(channelOf(renderFeed(CHANNEL, [item])), 'item')[0];

	it('carries the link as both link and a permalink guid', () => {
		const entry = only(ITEM);
		expect(textOf(entry, 'link')).toBe('https://taro.surf/gallery/parent-piece');
		const guid = child(entry, 'guid')!;
		expect(guid.text).toBe('https://taro.surf/gallery/parent-piece');
		expect(guid.attrs.isPermaLink).toBe('true');
	});

	it('renders the credit as both dc:creator and media:credit', () => {
		const entry = only(ITEM);
		expect(textOf(entry, 'dc:creator')).toBe('Artist');
		expect(textOf(entry, 'media:credit')).toBe('Artist');
	});

	it('attaches the image as media:content and media:thumbnail', () => {
		const entry = only(ITEM);
		expect(child(entry, 'media:content')!.attrs.url).toBe('https://taro.surf/img/parent.png');
		expect(child(entry, 'media:thumbnail')!.attrs.url).toBe('https://taro.surf/img/parent.png');
	});

	it('converts createdAt to an RFC-822 pubDate', () => {
		expect(textOf(only(ITEM), 'pubDate')).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
	});

	it('omits every optional element the row has no value for', () => {
		// Absent, not empty: `<description></description>` reads as "this work has a
		// description and it is blank", which some readers render as a gap.
		const bare = only({ title: 'Bare', link: 'https://taro.surf/x', createdAt: '' });
		expect(textOf(bare, 'description')).toBeUndefined();
		expect(textOf(bare, 'dc:creator')).toBeUndefined();
		expect(child(bare, 'media:content')).toBeUndefined();
		// An unparseable createdAt drops pubDate rather than emitting "Invalid Date".
		expect(textOf(bare, 'pubDate')).toBeUndefined();
	});

	it('preserves the order it was given (the route owns the sort)', () => {
		const items = children(
			channelOf(renderFeed(CHANNEL, [{ ...ITEM, title: 'First' }, { ...ITEM, title: 'Second' }])),
			'item'
		);
		expect(items.map((i) => textOf(i, 'title'))).toEqual(['First', 'Second']);
	});

	it('dates the channel from the newest entry it was handed', () => {
		const channel = channelOf(renderFeed({ ...CHANNEL, lastBuildDate: 'Wed, 01 Jul 2026 00:00:00 GMT' }, [ITEM]));
		expect(textOf(channel, 'lastBuildDate')).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
	});
});

describe('renderFeed — escaping', () => {
	it('escapes markup in a title rather than emitting it', () => {
		const xml = renderFeed(CHANNEL, [{ ...ITEM, title: 'A & B <script>x</script>' }]);
		expect(xml).not.toContain('<script>');
		// ...and the original text survives a round trip intact.
		const entry = children(channelOf(xml), 'item')[0];
		expect(textOf(entry, 'title')).toBe('A & B <script>x</script>');
	});

	it('escapes quotes inside attribute values', () => {
		const xml = renderFeed(CHANNEL, [{ ...ITEM, imageUrl: 'https://taro.surf/a"b.png' }]);
		const entry = children(channelOf(xml), 'item')[0];
		expect(child(entry, 'media:content')!.attrs.url).toBe('https://taro.surf/a"b.png');
	});

	it('escapes an ampersand in a URL, which query strings make routine', () => {
		const xml = renderFeed({ ...CHANNEL, selfUrl: 'https://taro.surf/feed.xml?a=1&b=2' }, []);
		expect(child(channelOf(xml), 'atom:link')!.attrs.href).toBe(
			'https://taro.surf/feed.xml?a=1&b=2'
		);
	});

	it('strips control characters XML 1.0 cannot represent at all', () => {
		// Escaping is not an option — `&#x0;` is not well-formed either — so a
		// stray control byte in a stored title is dropped rather than allowed to
		// break the document for every subscriber.
		expect(escapeXml('a\x00b\x1Fc')).toBe('abc');
		expect(() => parse(renderFeed(CHANNEL, [{ ...ITEM, title: 'x\x00y' }]))).not.toThrow();
	});

	it('keeps the whitespace XML does allow', () => {
		expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
	});
});

describe('renderFeed — NSFW marking', () => {
	it('adds no adult markers to a SFW document', () => {
		const xml = renderFeed(CHANNEL, [ITEM]);
		expect(xml).not.toContain(RTA_LABEL);
		expect(xml).not.toContain('<rating>');
		expect(xml).not.toContain('[NSFW]');
		expect(xml).not.toContain('<category>NSFW</category>');
	});

	it('labels the channel and every adult item on the adult document', () => {
		const channel = channelOf(
			renderFeed({ ...CHANNEL, adult: true }, [
				{ ...ITEM, nsfw: true },
				{ ...ITEM, title: 'Tame' }
			])
		);
		expect(textOf(channel, 'rating')).toBe(RTA_LABEL);
		const [adult, tame] = children(channel, 'item');
		expect(textOf(adult, 'title')).toBe('[NSFW] Parent Piece');
		expect(textOf(adult, 'category')).toBe('NSFW');
		// A SFW entry riding the adult feed stays unmarked — the marker means
		// "this one is adult", not "this feed is".
		expect(textOf(tame, 'title')).toBe('Tame');
		expect(textOf(tame, 'category')).toBeUndefined();
	});
});

describe('rfc822', () => {
	it('formats an ISO instant as RSS wants it', () => {
		expect(rfc822('2026-07-01T12:34:56.000Z')).toBe('Wed, 01 Jul 2026 12:34:56 GMT');
	});

	it('returns null for anything unparseable, so callers omit the element', () => {
		expect(rfc822('')).toBeNull();
		expect(rfc822('not a date')).toBeNull();
	});
});
