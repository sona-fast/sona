import { describe, it, expect } from 'vitest';
import { qrSvg } from './qr';
import { SOCIAL_ICON_ART, type SocialIconArt } from './social-icon-paths';
import { SOCIAL_PLATFORM_NAMES, type SocialPlatform } from './social-label';
import {
	conCardSvg,
	conCardFileBase,
	CON_CARD_WIDTH,
	CON_CARD_HEIGHT,
	type ConCardOptions
} from './con-card';

const LABELS = { species: 'Species', colors: 'Colors', online: 'Online' };

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

function card(overrides: Partial<ConCardOptions> = {}): string {
	return conCardSvg({
		variant: 'light',
		labels: LABELS,
		name: 'Taro',
		species: 'Red panda',
		colors: [
			{ name: 'Rust', hex: '#b45309' },
			{ name: 'Cream', hex: '#fef3c7' }
		],
		handles: [{ platform: 'bluesky', value: '@taro' }],
		connectUrl: 'https://taro.surf/connect',
		displayDomain: 'taro.surf',
		...overrides
	});
}

/** Every <text> body in document order, unescaped enough for assertions. */
function texts(svg: string): string[] {
	return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

describe('conCardSvg — the printed sheet', () => {
	it('names a Japanese family in the font stack, ahead of the generic tail', () => {
		const stack = card().match(/font-family="([^"]+)"/)?.[1] ?? '';
		// The labels are printed in the operator's own language, and the tools a
		// downloaded .svg is opened in do not all fall back past the stack.
		expect(stack).toMatch(/Hiragino Sans|Yu Gothic|Noto Sans JP/);
		expect(stack.indexOf('Hiragino Sans')).toBeLessThan(stack.lastIndexOf('sans-serif'));
	});
});

describe('conCardSvg — the QR target', () => {
	it('encodes the /connect URL it was given', () => {
		const svg = card();
		expect(svg).toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
	});

	it('never encodes /connect/qr — a printed card outlives the app', () => {
		const svg = card();
		expect(svg).not.toContain('/connect/qr');
		// The scan-target route encodes to a different code, so a copy-paste slip
		// in the caller would change the path this asserts is absent.
		expect(svg).not.toContain(`d="${qrSvg('https://taro.surf/connect/qr').path}"`);
	});

	it('prints the domain under the code for someone typing it instead', () => {
		expect(texts(card())).toContain('taro.surf');
	});
});

describe('conCardSvg — the art column', () => {
	it('bleeds the art off the left edge, clipped to the card', () => {
		const svg = card({ artHref: 'data:image/png;base64,AAAA', artCredit: 'Art by @nori' });
		expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
		expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
		expect(svg).toContain('clip-path="url(#cc-card)"');
		expect(texts(svg)).toContain('Art by @nori');
		// Rotated up the inner edge of the art.
		expect(svg).toMatch(/rotate\(-90\)/);
	});

	it('drops the art column entirely when there is no art, and widens the text', () => {
		const withArt = card({ artHref: 'data:image/png;base64,AAAA' });
		const without = card();
		expect(without).not.toContain('<image');
		// The name starts at the page padding rather than past the art column.
		expect(without).toContain('<text x="56" y="156"');
		expect(withArt).toContain('<text x="356" y="156"');
	});

	it('has no spine credit when the art carries no credit', () => {
		const svg = card({ artHref: 'data:image/png;base64,AAAA' });
		expect(svg).toContain('<image');
		expect(svg).not.toMatch(/rotate\(-90\)/);
	});
});

describe('conCardSvg — sections omit themselves', () => {
	it('drops the species row when there is no species', () => {
		expect(texts(card({ species: null }))).not.toContain('SPECIES');
		expect(texts(card())).toContain('SPECIES');
	});

	it('drops the colors row when the palette is empty', () => {
		expect(texts(card({ colors: [] }))).not.toContain('COLORS');
		// Swatches are the only rects carrying a palette hex.
		expect(card({ colors: [] })).not.toContain('#b45309');
	});

	it('drops the handles row when no handle is selected', () => {
		expect(texts(card({ handles: [] }))).not.toContain('ONLINE');
	});

	it('keeps the name and the QR when everything optional is gone', () => {
		const bare = card({ species: null, colors: [], handles: [], artHref: null });
		expect(texts(bare)).toEqual(['Taro', 'taro.surf']);
		expect(bare).toContain(`d="${qrSvg('https://taro.surf/connect').path}"`);
	});
});

describe('conCardSvg — handles', () => {
	it('renders one row per handle: the platform icon, then the handle', () => {
		const svg = card({
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
			const svg = card({ handles: [{ platform, value: '@taro' }] });
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
			const svg = card({ handles: [{ platform, value: '@taro' }] });
			const { viewBox } = art(platform);
			expect(svg, platform).toContain(`width="31" height="31" viewBox="0 0 ${viewBox} ${viewBox}"`);
		}
	});

	it('falls back to the platform name in text when there is no icon for it', () => {
		// Unreachable through the settings load, which only builds handles for
		// platforms the table covers. Kept because the id is load data: a row must
		// read as a row rather than as a handle with a hole where its icon goes.
		const svg = card({ handles: [{ platform: 'nowhere' as SocialPlatform, value: '@taro' }] });
		expect(texts(svg)).toContain('@taro');
		// The QR's is then the only nested <svg> on the card: no mark was drawn.
		expect([...svg.matchAll(/<svg x=/g)]).toHaveLength(1);
	});

	it('shrinks the rows past two handles rather than cutting the list', () => {
		const two = card({
			handles: [
				{ platform: 'bluesky', value: '@a' },
				{ platform: 'telegram', value: '@b' }
			]
		});
		// The full set the settings load can send, which is six.
		const all = card({
			handles: CARD_PLATFORMS.map((platform, i) => ({ platform, value: `@${i}` }))
		});
		expect(two).toContain('font-size="34"');
		expect(all).not.toContain('font-size="34"');
		expect(all).toContain('font-size="30"');
		expect(texts(all).filter((t) => t.startsWith('@'))).toHaveLength(CARD_PLATFORMS.length);
		// The icons shrink with the rows they sit on, whatever their own viewBox.
		expect(two).toContain(`width="31" height="31"`);
		for (const platform of CARD_PLATFORMS) {
			const { viewBox } = art(platform);
			expect(all, platform).toContain(`width="27" height="27" viewBox="0 0 ${viewBox} ${viewBox}"`);
		}
	});

	it('caps the swatch row at four, so a long palette still reads as a palette', () => {
		const hexes = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'];
		const svg = card({ colors: hexes.map((hex) => ({ name: hex, hex })) });
		expect(svg).toContain('#444444');
		expect(svg).not.toContain('#555555');
	});
});

describe('conCardSvg — variants', () => {
	it('uses a different ground and text colour for print and phone', () => {
		const light = card({ variant: 'light' });
		const dark = card({ variant: 'dark' });
		expect(light).toContain('fill="#ffffff"');
		expect(light).not.toContain('fill="#101014"');
		expect(dark).toContain('fill="#101014"');
		expect(dark).toContain('fill="#fafafa"');
		expect(light).not.toContain('fill="#fafafa"');
	});

	it('keeps the QR dark-on-light in BOTH variants — scanners refuse inverted codes', () => {
		for (const variant of ['light', 'dark'] as const) {
			const svg = card({ variant });
			const plate = svg.match(/<rect x="870"[^>]*fill="([^"]+)"/)?.[1];
			// Anchored on the QR's own nested <svg>: the handle rows draw platform
			// icons as paths too, and those come first in the document.
			const modules = svg.match(/<g transform="translate[^>]*><path d="[^"]*" fill="([^"]+)"/)?.[1];
			expect(plate, variant).toBe('#ffffff');
			expect(modules, variant).not.toBe('#ffffff');
		}
	});
});

describe('conCardSvg — the printed sheet', () => {
	it('carries inch dimensions and the 4x3 viewBox a badge holder expects', () => {
		const svg = card();
		expect(svg).toContain('width="4in" height="3in"');
		expect(svg).toContain(`viewBox="0 0 ${CON_CARD_WIDTH} ${CON_CARD_HEIGHT}"`);
		expect(CON_CARD_WIDTH / CON_CARD_HEIGHT).toBeCloseTo(4 / 3);
	});

	it('takes its accessible name from the caller, and omits the title without one', () => {
		expect(card({ title: 'Con card for Taro' })).toContain('<title>Con card for Taro</title>');
		// Handles carry a <title> per icon, so the card without one is the card
		// with nothing else to title.
		expect(card({ handles: [] })).not.toContain('<title>');
	});

	it('escapes operator-entered text rather than letting it close a tag', () => {
		const svg = card({ name: 'Taro & <Friends>', species: null, handles: [], colors: [] });
		expect(svg).toContain('Taro &amp; &lt;Friends&gt;');
		expect(svg).not.toContain('<Friends>');
	});

	it('truncates a name too long for its column instead of overrunning the QR', () => {
		const long = 'A'.repeat(120);
		const rendered = texts(card({ name: long }))[0];
		expect(rendered.length).toBeLessThan(long.length);
		expect(rendered.endsWith('…')).toBe(true);
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
