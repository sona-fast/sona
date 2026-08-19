import { describe, it, expect } from 'vitest';
import { qrSvg } from './qr';
import { SOCIAL_ICON_ART, type SocialIconArt } from './social-icon-paths';
import { SOCIAL_PLATFORM_NAMES, type SocialPlatform } from './social-label';
import {
	conCardFaceSvg,
	conCardPrintSheetSvg,
	conCardFileBase,
	CON_CARD_WIDTH,
	CON_CARD_HEIGHT,
	CON_CARD_SHEET_WIDTH,
	CON_CARD_SHEET_HEIGHT,
	type ConCardFace,
	type ConCardOptions
} from './con-card';

/** Every platform the settings load can put on a card, in the order it sends
 *  them. All six draw a mark; none falls through to the text row. */
const CARD_PLATFORMS = [
	'bluesky',
	'telegram',
	'twitter',
	'furaffinity',
	'furtrack',
	'instagram'
] as const;

function art(platform: SocialPlatform): SocialIconArt {
	const entry = SOCIAL_ICON_ART[platform];
	if (!entry) throw new Error(`no icon art for ${platform}`);
	return entry;
}

const BASE: ConCardOptions = {
	variant: 'light',
	name: 'Taro',
	species: 'Red panda',
	colors: [
		{ name: 'Rust', hex: '#b45309' },
		{ name: 'Cream', hex: '#fef3c7' }
	],
	handles: [{ platform: 'bluesky', value: '@taro' }],
	connectUrl: 'https://taro.surf/connect',
	displayDomain: 'taro.surf',
	madeWith: 'Made with Sona'
};

function face(which: ConCardFace, overrides: Partial<ConCardOptions> = {}): string {
	return conCardFaceSvg(which, { ...BASE, ...overrides });
}

const front = (overrides: Partial<ConCardOptions> = {}) => face('front', overrides);
const back = (overrides: Partial<ConCardOptions> = {}) => face('back', overrides);

function sheet(overrides: Partial<Omit<ConCardOptions, 'variant'>> = {}): string {
	const { variant: _variant, ...rest } = BASE;
	return conCardPrintSheetSvg({ ...rest, ...overrides });
}

/** Every <text> body in document order, unescaped enough for assertions. */
function texts(svg: string): string[] {
	return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

/** Every <text> with the size it was rendered at, for the fit/shrink math. */
function sized(svg: string): Array<{ body: string; size: number }> {
	return [...svg.matchAll(/<text[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({
		size: Number(m[1]),
		body: m[2]
	}));
}

describe('conCardFaceSvg — the badge', () => {
	it('is a CR80 portrait card whose viewBox matches its printed inches', () => {
		for (const which of ['front', 'back'] as const) {
			const svg = face(which);
			expect(svg, which).toContain('width="2.125in" height="3.375in"');
			expect(svg, which).toContain(`viewBox="0 0 ${CON_CARD_WIDTH} ${CON_CARD_HEIGHT}"`);
		}
		// A viewBox ratio that drifts from the inch ratio letterboxes the card
		// inside its own sheet, so the two are pinned to agree exactly.
		expect(CON_CARD_WIDTH / CON_CARD_HEIGHT).toBe(2.125 / 3.375);
	});

	it('names a Japanese family in the font stack, ahead of the generic tail', () => {
		const stack = front().match(/font-family="([^"]+)"/)?.[1] ?? '';
		// The card is printed in the operator's own language, and the tools a
		// downloaded .svg is opened in do not all fall back past the stack.
		expect(stack).toMatch(/Hiragino Sans|Yu Gothic|Noto Sans JP/);
		expect(stack.indexOf('Hiragino Sans')).toBeLessThan(stack.lastIndexOf('monospace'));
	});

	it('takes its accessible name from the caller, and omits the title without one', () => {
		expect(front({ title: 'Front of Taro' })).toContain('<title>Front of Taro</title>');
		// Handles carry a <title> per icon, so the face without one is the face
		// with nothing else to title.
		expect(front()).not.toContain('<title>');
	});

	it('escapes operator-entered text rather than letting it close a tag', () => {
		const svg = front({ name: 'Taro & <Friends>', species: null, colors: [] });
		expect(svg).toContain('Taro &amp; &lt;Friends&gt;');
		expect(svg).not.toContain('<Friends>');
		// Both quote forms, since a value can also land inside an attribute (the
		// avatar href, a colour hex).
		expect(front({ name: `Taro's "friend"`, species: null })).toContain(
			'Taro&#39;s &quot;friend&quot;'
		);
	});
});

describe('conCardFaceSvg — the front', () => {
	it('runs the sona colors as bands across the top, one per colour', () => {
		const svg = front({ colors: [{ name: 'Rust', hex: '#b45309' }, { name: 'Cream', hex: '#fef3c7' }] });
		const bands = [...svg.matchAll(/<rect x="0" y="(\d+)" width="850" height="(\d+)" fill="(#[0-9a-f]+)"\/>/g)];
		expect(bands.map((b) => b[3])).toEqual(['#b45309', '#fef3c7']);
		// Between them the bands fill the stripe field with no seam and no gap.
		expect(Number(bands[0][1])).toBe(0);
		expect(Number(bands[0][1]) + Number(bands[0][2])).toBe(Number(bands[1][1]));
	});

	it('falls back to one neutral band when the colours are turned off', () => {
		const svg = front({ colors: [] });
		// Without a band the face would float on an empty top half, so the front
		// still composes: one neutral band, and none of the palette on it.
		expect(svg).toContain('<rect x="0" y="0" width="850" height="742" fill="#e4e4e7"/>');
		expect(svg).not.toContain('#b45309');
	});

	it('holds the persona avatar in a ringed circle, cropped rather than squashed', () => {
		const svg = front({ avatarHref: 'data:image/png;base64,AAAA' });
		expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
		expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
		expect(svg).toContain('clip-path="url(#cc-front-face)"');
		expect(svg).toContain('stroke="#ffffff" stroke-width="18"');
	});

	it('draws the name initial in the ring when there is no avatar', () => {
		const svg = front();
		expect(svg).not.toContain('<image');
		expect(texts(svg)).toContain('T');
	});

	it('keeps a ZWJ emoji whole as the initial', () => {
		const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
		const svg = front({ name: `${family} Taro`, avatarHref: null });
		// The cluster has to BE one of the drawn texts. A substring match over the
		// whole SVG passes on the name line alone, which carries the family emoji
		// whatever the initial ends up being.
		expect(texts(svg)).toContain(family);
	});

	it('splits the initial by code point, so an astral first glyph survives', () => {
		// A name starting with an emoji is one code point and two code units; a
		// charAt fallback would put half a surrogate pair on a printed card.
		expect(texts(front({ name: '🦊 Taro' }))).toContain('🦊');
	});

	it('carries the name and the species, and nothing else the back owns', () => {
		const svg = front({ artCredit: 'Art by @nori', handles: [{ platform: 'bluesky', value: '@taro' }] });
		expect(texts(svg)).toEqual(expect.arrayContaining(['Taro', 'Red panda']));
		// The front is worn all day: no QR, no handles, no credit line on it.
		expect(texts(svg)).not.toContain('@taro');
		expect(texts(svg)).not.toContain('Art by @nori');
		expect(svg).not.toContain('taro.surf');
		expect(svg).not.toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
	});

	it('drops the species line when the species is turned off', () => {
		expect(texts(front({ species: null }))).not.toContain('Red panda');
		expect(texts(front())).toContain('Red panda');
	});

	it('measures a Japanese name at full width, so it shrinks like a wide Latin one', () => {
		// A CJK glyph is drawn on a square em by every family in the card's stack.
		// Measured at the Latin 0.6em it passes the fit at the base size and then
		// clips off the edge of a printed card.
		const avatarHref = 'data:image/png;base64,AAAA';
		const jp = sized(front({ name: 'タロウのなまえ', species: null, avatarHref }));
		const latin = sized(front({ name: 'Tarooma', species: null, avatarHref }));
		// Same seven code points; only the Japanese one is too wide for the base.
		expect(latin[0].size).toBe(152);
		expect(jp[0].size).toBeLessThan(latin[0].size);
		// Whole, not cut, and inside the content column under the weighted measure.
		expect(jp[0].body).toBe('タロウのなまえ');
		expect(7 * jp[0].size).toBeLessThanOrEqual(CON_CARD_WIDTH - 56 * 2);
	});

	it('applies the same measure to the species line', () => {
		// Fixed size, so a species too wide is cut rather than shrunk. Fifteen
		// full-width glyphs overrun the column that fifteen Latin ones fit inside.
		const wide = texts(front({ species: 'あ'.repeat(15) }));
		const narrow = texts(front({ species: 'a'.repeat(15) }));
		expect(wide.some((t) => t.startsWith('あ') && t.endsWith('…'))).toBe(true);
		expect(narrow).toContain('a'.repeat(15));
	});

	it('cuts by grapheme cluster, so a clamped name never ends in half a surrogate pair', () => {
		// A lone surrogate makes the markup unencodable: encodeURIComponent, which
		// the raster path runs the whole SVG through, throws on one.
		//
		// The leading 'A' is load-bearing. Without it every cut offset in the string
		// is even, so a code-unit slice lands on a pair boundary by coincidence and
		// the assertion passes against the very bug it exists for.
		const svg = front({
			name: `A${'🦊'.repeat(40)}`,
			species: null,
			avatarHref: 'data:image/png;base64,AAAA'
		});
		const clamped = texts(svg).find((t) => t.startsWith('A')) ?? '';
		expect(clamped.endsWith('…')).toBe(true);
		expect(clamped).not.toMatch(/[\uD800-\uDFFF]/u);
		expect(() => encodeURIComponent(svg)).not.toThrow();
	});

	it('measures an emoji at a full em, so a row of them shrinks instead of overrunning', () => {
		// An emoji is drawn on the same square em a CJK glyph is. Eight of them at
		// the base size are 1216 units wide in a 738 unit column; measured at the
		// Latin 0.6em they came to 730 and sailed through the fit.
		const avatarHref = 'data:image/png;base64,AAAA';
		const [rendered] = sized(front({ name: '🦊'.repeat(8), species: null, avatarHref }));
		expect(rendered.size).toBeLessThan(152);
		// Shrunk, not cut, and inside the content column under the weighted measure.
		expect(rendered.body).toBe('🦊'.repeat(8));
		expect(8 * rendered.size).toBeLessThanOrEqual(CON_CARD_WIDTH - 56 * 2);
	});

	it('measures a keycap at a full em, though the digit it starts with is narrow', () => {
		// The one cluster its base code point does not describe: '1' is Latin and
		// narrow, and '1️⃣' is drawn as a square-em emoji. Weighed by the
		// base alone, eight of them measured 730 units and fit the 738 unit column
		// at the base size, then printed 1216 units wide.
		const avatarHref = 'data:image/png;base64,AAAA';
		const KEYCAP = '1️⃣';
		const [rendered] = sized(front({ name: KEYCAP.repeat(8), species: null, avatarHref }));
		expect(rendered.size).toBeLessThan(152);
		expect(rendered.body).toBe(KEYCAP.repeat(8));
		expect(8 * rendered.size).toBeLessThanOrEqual(CON_CARD_WIDTH - 56 * 2);
	});

	it('counts a ZWJ family emoji as the one glyph it draws as, and never cuts inside it', () => {
		// Seven code points, one cluster. Counted by code point the four families
		// below measure 16.8em, get shrunk to the size floor, and are then cut
		// through the middle of a family; counted by cluster they are 4em and fit
		// the column at the base size.
		const avatarHref = 'data:image/png;base64,AAAA';
		const FAMILY = '👨‍👩‍👧‍👦';
		const [four] = sized(front({ name: FAMILY.repeat(4), species: null, avatarHref }));
		expect(four.size).toBe(152);
		expect(four.body).toBe(FAMILY.repeat(4));

		// And where it genuinely does not fit, the cut lands between families: a
		// whole number of them, no dangling ZWJ, no half of a surrogate pair.
		const [many] = sized(front({ name: FAMILY.repeat(12), species: null, avatarHref }));
		expect(many.body.endsWith('…')).toBe(true);
		const cut = many.body.slice(0, -1);
		const kept = cut.length / FAMILY.length;
		expect(cut).toBe(FAMILY.repeat(kept));
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(12);
		expect(many.body).not.toMatch(/[\uD800-\uDFFF]/u);
	});

	it('shrinks a name too long for the card instead of running it off the edge', () => {
		const long = 'A'.repeat(120);
		// With an avatar, so the ring's initial is not also an 'A' text node.
		const rendered =
			texts(front({ name: long, avatarHref: 'data:image/png;base64,AAAA' })).find((t) =>
				t.startsWith('A')
			) ?? '';
		expect(rendered.length).toBeLessThan(long.length);
		expect(rendered.endsWith('…')).toBe(true);
	});
});

describe('conCardFaceSvg — the back', () => {
	it('encodes the /connect URL it was given', () => {
		expect(back()).toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
	});

	it('never encodes /connect/qr — a printed card outlives the app', () => {
		const svg = back();
		expect(svg).not.toContain('/connect/qr');
		// The scan-target route encodes to a different code, so a copy-paste slip
		// in the caller would change the path this asserts is absent.
		expect(svg).not.toContain(`d="${qrSvg('https://taro.surf/connect/qr').path}"`);
	});

	it('prints the domain under the code for someone typing it instead', () => {
		expect(texts(back())).toContain('taro.surf');
	});

	it('signs the bottom edge with the art credit and the made-with line', () => {
		const svg = back({ artCredit: 'Art by @nori · taro.surf' });
		expect(texts(svg)).toEqual(
			expect.arrayContaining(['Art by @nori · taro.surf', 'Made with Sona'])
		);
	});

	it('drops the credit line when the art credit is turned off', () => {
		const svg = back({ artCredit: null });
		expect(texts(svg)).not.toContain('Art by @nori · taro.surf');
		// The made-with line is not a toggle and stays either way.
		expect(texts(svg)).toContain('Made with Sona');
	});

	it('keeps the QR, the domain and the made-with line when everything else is gone', () => {
		const bare = back({ handles: [], artCredit: null });
		expect(texts(bare)).toEqual(['taro.surf', 'Made with Sona']);
		expect(bare).toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
	});
});

describe('conCardFaceSvg — handles', () => {
	it('renders one row per handle: the platform icon, then the handle', () => {
		const svg = back({
			handles: [
				{ platform: 'bluesky', value: '@taro' },
				{ platform: 'telegram', value: '@taro_tg' }
			]
		});
		expect(texts(svg)).toEqual(expect.arrayContaining(['@taro', '@taro_tg']));
		// The platform reads as its mark, not as its name.
		expect(texts(svg).join(' ')).not.toContain('Bluesky');
		expect(svg).toContain(art('bluesky').shapes);
		expect(svg).toContain(art('telegram').shapes);
	});

	it('draws each platform its own icon, named for a screen reader', () => {
		// Every platform the settings load can put on a card, FurTrack among them:
		// its mark is a dozen shapes, and a fragment carries those as well as it
		// carries the single-shape ones.
		for (const platform of CARD_PLATFORMS) {
			const svg = back({ handles: [{ platform, value: '@taro' }] });
			expect(svg, platform).toContain(art(platform).shapes);
			expect(svg, platform).toContain(`<title>${SOCIAL_PLATFORM_NAMES[platform]}</title>`);
			// The name is the icon's alone: the row does not also spell it out.
			expect(texts(svg), platform).not.toContain(`${SOCIAL_PLATFORM_NAMES[platform]} @taro`);
			// Every other platform's mark stays off this card.
			for (const other of CARD_PLATFORMS) {
				if (other !== platform)
					expect(svg, `${platform}/${other}`).not.toContain(art(other).shapes);
			}
		}
	});

	it('scales every mark to the same size from its own viewBox', () => {
		// A mark drawn on a grid other than 24 would otherwise render at whatever
		// fraction of the row that grid implies.
		for (const platform of CARD_PLATFORMS) {
			const svg = back({ handles: [{ platform, value: '@taro' }] });
			const { viewBox } = art(platform);
			expect(svg, platform).toContain(`width="50" height="50" viewBox="0 0 ${viewBox} ${viewBox}"`);
		}
	});

	it('falls back to the platform name in text when there is no icon for it', () => {
		// Unreachable through the settings load, which only builds handles for
		// platforms the table covers. Kept because the id is load data: a row must
		// read as a row rather than as a handle with a hole where its icon goes.
		const svg = back({ handles: [{ platform: 'nowhere' as SocialPlatform, value: '@taro' }] });
		expect(texts(svg)).toContain('@taro');
		// The QR's is then the only nested <svg> on the face: no mark was drawn.
		expect([...svg.matchAll(/<svg x=/g)]).toHaveLength(1);
	});

	it('shrinks the rows past two handles rather than cutting the list', () => {
		const two = back({
			handles: [
				{ platform: 'bluesky', value: '@a' },
				{ platform: 'telegram', value: '@b' }
			]
		});
		// The full set the settings load can send, which is six.
		const all = back({
			handles: CARD_PLATFORMS.map((platform, i) => ({ platform, value: `@${i}` }))
		});
		expect(two).toContain('font-size="56"');
		expect(all).not.toContain('font-size="56"');
		expect(all).toContain('font-size="44"');
		expect(texts(all).filter((t) => t.startsWith('@'))).toHaveLength(CARD_PLATFORMS.length);
		// The icons shrink with the rows they sit on, whatever their own viewBox.
		expect(two).toContain('width="50" height="50"');
		for (const platform of CARD_PLATFORMS) {
			const { viewBox } = art(platform);
			expect(all, platform).toContain(`width="40" height="40" viewBox="0 0 ${viewBox} ${viewBox}"`);
		}
	});

	it('caps the bands at six, so a long palette still reads as a flag', () => {
		const hexes = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777'];
		const svg = front({ colors: hexes.map((hex) => ({ name: hex, hex })) });
		expect(svg).toContain('#666666');
		expect(svg).not.toContain('#777777');
	});
});

describe('conCardFaceSvg — variants', () => {
	it('uses a different ground and text colour for print and phone', () => {
		const light = front({ variant: 'light' });
		const dark = front({ variant: 'dark' });
		expect(light).toContain('fill="#ffffff"');
		expect(light).not.toContain('fill="#101014"');
		expect(dark).toContain('fill="#101014"');
		expect(dark).toContain('fill="#fafafa"');
		expect(light).not.toContain('fill="#fafafa"');
	});

	it('keeps the QR dark-on-light in BOTH variants — scanners refuse inverted codes', () => {
		for (const variant of ['light', 'dark'] as const) {
			const svg = back({ variant });
			const plate = svg.match(/<rect x="120"[^>]*rx="24" fill="([^"]+)"/)?.[1];
			// Anchored on the QR's own nested <svg>: the handle rows draw platform
			// icons as paths too, and those come first in the document.
			const modules = svg.match(/<g transform="translate[^>]*><path d="[^"]*" fill="([^"]+)"/)?.[1];
			expect(plate, variant).toBe('#ffffff');
			expect(modules, variant).not.toBe('#ffffff');
		}
	});
});

describe('conCardPrintSheetSvg', () => {
	it('puts both faces on one sheet at true physical size', () => {
		const svg = sheet({ avatarHref: 'data:image/png;base64,AAAA' });
		// 2.125in + 2.125in of card, plus the gap and margins the marks live in.
		expect(svg).toContain('width="5in" height="3.875in"');
		expect(svg).toContain(`viewBox="0 0 ${CON_CARD_SHEET_WIDTH} ${CON_CARD_SHEET_HEIGHT}"`);
		// The front by its avatar and its ring, the back by its QR and its domain.
		expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
		expect(svg).toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
		expect(texts(svg)).toEqual(expect.arrayContaining(['Taro', 'taro.surf']));
		// Side by side, each face translated to its own column.
		expect(svg).toContain('<g transform="translate(100 100)">');
		expect(svg).toContain('<g transform="translate(1050 100)">');
	});

	it('marks both cards for the knife, outside the trim line', () => {
		const svg = sheet();
		// Two marks per corner, four corners, two cards.
		const marks = [...svg.matchAll(/<line x1="\d+" y1="\d+" x2="\d+" y2="\d+"\/>/g)];
		expect(marks).toHaveLength(16);
		// The top-left corner of the front card, marked from outside it.
		expect(svg).toContain('<line x1="80" y1="100" x2="40" y2="100"/>');
		expect(svg).toContain('<line x1="100" y1="80" x2="100" y2="40"/>');
	});

	it('prints the light card whatever the phone is set to', () => {
		// Heavy ink coverage bleeds on a home printer and costs a cartridge per
		// sheet, so the dark ground never reaches paper.
		const svg = sheet();
		expect(svg).toContain('fill="#ffffff"');
		expect(svg).not.toContain('#101014');
	});

	it('keeps the two faces from sharing a clip path id', () => {
		// Both faces land in one document here; a shared id would clip one face
		// with the other's shape.
		const svg = sheet({ avatarHref: 'data:image/png;base64,AAAA' });
		const ids = [...svg.matchAll(/<clipPath id="([^"]+)">/g)].map((m) => m[1]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('conCardFileBase', () => {
	it('slugs the operator name', () => {
		expect(conCardFileBase('Taro')).toBe('taro-con-card');
		expect(conCardFileBase('Taro the Red Panda!')).toBe('taro-the-red-panda-con-card');
	});

	it('falls back when the name slugs to nothing', () => {
		expect(conCardFileBase('タロウ')).toBe('con-card');
		expect(conCardFileBase('')).toBe('con-card');
	});
});
