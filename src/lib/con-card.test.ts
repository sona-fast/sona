import { describe, it, expect } from 'vitest';
import { qrSvg } from './qr';
import {
	conCardSvg,
	conCardFileBase,
	CON_CARD_WIDTH,
	CON_CARD_HEIGHT,
	type ConCardOptions
} from './con-card';

const LABELS = { species: 'Species', colors: 'Colors', online: 'Online' };

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
		handles: [{ label: 'Bluesky', value: '@taro' }],
		connectUrl: 'https://taro.surf/connect',
		displayDomain: 'taro.surf',
		...overrides
	});
}

/** Every <text> body in document order, unescaped enough for assertions. */
function texts(svg: string): string[] {
	return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

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
	it('renders one row per handle, platform then handle', () => {
		const svg = card({
			handles: [
				{ label: 'Bluesky', value: '@taro' },
				{ label: 'Telegram', value: '@taro_tg' }
			]
		});
		expect(texts(svg)).toEqual(
			expect.arrayContaining(['Bluesky @taro', 'Telegram @taro_tg'])
		);
	});

	it('shrinks the rows past two handles rather than cutting the list', () => {
		const two = card({
			handles: [
				{ label: 'Bluesky', value: '@a' },
				{ label: 'Telegram', value: '@b' }
			]
		});
		const four = card({
			handles: [
				{ label: 'Bluesky', value: '@a' },
				{ label: 'Telegram', value: '@b' },
				{ label: 'Twitter', value: '@c' },
				{ label: 'Instagram', value: '@d' }
			]
		});
		expect(two).toContain('font-size="34"');
		expect(four).not.toContain('font-size="34"');
		expect(four).toContain('font-size="30"');
		expect(texts(four).filter((t) => t.startsWith('@') || t.includes(' @'))).toHaveLength(4);
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
			const modules = svg.match(/<path d="[^"]*" fill="([^"]+)"/)?.[1];
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
		expect(card()).not.toContain('<title>');
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
