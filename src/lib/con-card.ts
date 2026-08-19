import { qrSvg } from '$lib/qr';
import { SOCIAL_ICON_ART, type SocialIconArt } from '$lib/social-icon-paths';
import { SOCIAL_PLATFORM_NAMES, type SocialPlatform } from '$lib/social-label';

/**
 * The con card: the operator's site as a physical object, laid out as a two
 * sided badge at CR80 portrait size (2.125in by 3.375in), so it drops into a
 * lanyard holder without being trimmed.
 *
 * The front is what a stranger reads across a table all day: the sona colors as
 * stripe bands, the persona's face on them, the name below. The back is the ten
 * second handoff: the QR, the domain under it, the handles. Splitting them is
 * the point of two faces; neither moment has to share a crowded side.
 *
 * Pure string building, no DOM: the settings page inlines the light variant of
 * both faces as its preview, the "save to phone" path rasterizes the dark back
 * through a canvas, and the tests read the markup directly. Anything needing a
 * browser (the canvas, the data URI embedding of the avatar) lives in
 * ConCard.svelte.
 *
 * The QR encodes /connect and never /connect/qr: a printed card outlives the
 * app, and /connect is the one route that is never gated.
 */

export type ConCardVariant = 'light' | 'dark';
export type ConCardFace = 'front' | 'back';

export interface ConCardColor {
	name: string;
	hex: string;
}

export interface ConCardHandle {
	/** Which platform the row stands for; the card draws its icon. */
	platform: SocialPlatform;
	/** The handle itself, already carrying its @ (see social-label's rule 1). */
	value: string;
}

export interface ConCardOptions {
	variant: ConCardVariant;
	/** The operator's display name; the only field the card can't omit. */
	name: string;
	species?: string | null;
	/** Drawn as stripe bands behind the face, not as swatches. */
	colors?: ConCardColor[];
	handles?: ConCardHandle[];
	/** The persona's face for the front: a data URI, or a same-origin URL. An
	 *  external href does not draw when the SVG is rasterized through a canvas,
	 *  so the download paths embed the avatar as a data URI before calling this.
	 *  Without one the ring holds the name's initial. */
	avatarHref?: string | null;
	/** Art credit microtext on the back ("Art by @handle · taro.surf"). */
	artCredit?: string | null;
	/** What the QR encodes. Must be the fork's /connect URL. */
	connectUrl: string;
	/** The domain printed under the QR, for someone typing it instead. */
	displayDomain: string;
	/** The back's second microtext line. Localized by the caller: the card is
	 *  printed in the operator's own language, so no string on it is hardcoded
	 *  here. */
	madeWith: string;
	/** Accessible name, localized by the caller. Omitted → no <title>. */
	title?: string;
}

/** Card geometry in user units; 400 per printed inch, which is the largest
 *  scale that puts both CR80 edges on whole units (2.125in → 850,
 *  3.375in → 1350). A viewBox whose ratio drifts from the inch dimensions
 *  letterboxes the card inside its own sheet. */
export const CON_CARD_WIDTH = 850;
export const CON_CARD_HEIGHT = 1350;
const CARD_WIDTH_IN = '2.125in';
const CARD_HEIGHT_IN = '3.375in';
/** User units per printed inch, for the sheet's own inch dimensions. */
const PER_INCH = 400;

const PAD = 56;
/** CR80's corner is 1/8in. */
const RADIUS = 50;

// Front.
/** The stripe bands fill the upper half and a bit, which is what leaves the
 *  name room to sit on plain card ground rather than on a colour. */
const STRIPE_H = 742;
const FACE_R = 234;
const FACE_CX = CON_CARD_WIDTH / 2;
const FACE_CY = STRIPE_H / 2;
/** The ring reads as the cut edge of a sticker, and keeps the face off a band
 *  it might be the same colour as. */
const FACE_RING = 18;
const NAME_BASELINE = 1016;
const SPECIES_BASELINE = 1086;

// Back.
const QR_SIZE = 554;
const QR_X = (CON_CARD_WIDTH - QR_SIZE) / 2;
const QR_Y = 84;
/** White margin around the modules. Scanners need the quiet zone, and the plate
 *  is what supplies it when the card ground is dark. */
const QR_PLATE_PAD = 28;
const DOMAIN_BASELINE = 746;
const DIVIDER_Y = 812;
const HANDLES_TOP = 880;
const MICRO_SIZE = 26;
const MADE_BASELINE = CON_CARD_HEIGHT - PAD;
const CREDIT_BASELINE = MADE_BASELINE - 42;

/** Past six the bands stop reading as a flag and start reading as a gradient. */
const MAX_CARD_COLORS = 6;
/** Above this the handle rows shrink so a longer list still fits the column. */
const COMFORTABLE_HANDLES = 2;
/** Icon edge as a share of the row's font size, the gap after it, and the
 *  baseline-to-baseline distance between two rows. */
const ICON_SIZE_RATIO = 0.9;
const ICON_GAP_RATIO = 0.4;
const ICON_ROW_PITCH = 1.45;
/** How far the icon box rises above the text baseline it sits on. Brand marks
 *  fill their box, so this centers one against cap height rather than against
 *  the em box, which would ride high. */
const ICON_LIFT_RATIO = 0.78;

// Monospace, because a badge is read the way a label is: the handles and the
// domain are strings a stranger has to copy by eye, and even advance widths are
// what stop an l and a 1 from trading places at arm's length.
//
// CJK families named explicitly: the print .svg is opened in tools that do not
// resolve the css generic keywords, and Menlo has no Japanese glyphs. They sit
// AFTER the Latin families on purpose: fallback is per glyph, so Latin keeps its
// monospace while Japanese falls through to a family that has it.
const FONT =
	"ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', monospace";

/**
 * The two palettes. The QR keeps dark modules on a light plate in BOTH: an
 * inverted code is out of spec and a good share of phone scanners refuse it,
 * which on a printed card is a failure nobody can debug in a hallway.
 */
const PALETTES: Record<ConCardVariant, Record<string, string>> = {
	light: {
		bg: '#ffffff',
		border: '#d4d4d8',
		fg: '#18181b',
		muted: '#71717a',
		rule: '#e4e4e7',
		/** Stands in for the bands when the operator prints without colours. */
		stripeFallback: '#e4e4e7',
		ring: '#ffffff',
		initial: '#52525b',
		qrPlate: '#ffffff',
		qrModule: '#18181b'
	},
	dark: {
		bg: '#101014',
		border: '#2a2a31',
		fg: '#fafafa',
		muted: '#a1a1aa',
		rule: '#2a2a31',
		stripeFallback: '#2a2a31',
		ring: '#ffffff',
		initial: '#d4d4d8',
		qrPlate: '#ffffff',
		qrModule: '#101014'
	}
};

/** XML-escape. Every value on the card is operator-entered text. */
function esc(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/**
 * SVG text does not wrap, so long values are measured and then cut. Monospace
 * makes the measure honest: 0.6em is the advance of every glyph in the Latin
 * families above, so the fit is arithmetic rather than a guess.
 *
 * A Japanese name is not measured by that number. East Asian Wide and Fullwidth
 * code points are drawn on a square em by every family in the stack above, so a
 * seven-glyph name measured at 0.6em passes the fit and then clips off the edge
 * of a printed card. They count as a full em instead, and so does an emoji,
 * which is drawn on the same square em.
 *
 * The unit of the measure is the GRAPHEME CLUSTER, not the code point. A ZWJ
 * family emoji is seven code points and one drawn glyph: counted as seven it
 * measures four times its real width, and gets shrunk to the size floor and
 * then cut through the middle of the family. Segmenting first also makes the
 * cut safe by construction, since a cluster boundary is never inside a
 * surrogate pair.
 */
const AVG_ADVANCE = 0.6;
const WIDE_ADVANCE = 1;
/** East Asian Wide / Fullwidth: Hangul jamo, CJK radicals and punctuation, kana,
 *  the CJK ideograph blocks (incl. the astral extensions), Hangul syllables,
 *  compatibility ideographs, and the fullwidth forms. Plus the pictographs, and
 *  the regional indicators a flag is built from: both square-em drawn. */
const WIDE =
	/[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic}/u;

/** Intl.Segmenter is in workerd and in node, which is everywhere this file
 *  runs. Built once: a segmenter per measured string would be the expensive
 *  part of drawing a card. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clusters(body: string): string[] {
	return [...GRAPHEMES.segment(body)].map((part) => part.segment);
}

/** Advance of one grapheme cluster, in em, decided by its BASE code point: the
 *  ZWJ, variation-selector and combining tail behind that base draws inside the
 *  base's own box rather than beside it, so the whole cluster is one unit. */
function advanceOf(cluster: string): number {
	const base = cluster.codePointAt(0);
	if (base === undefined) return 0;
	return WIDE.test(String.fromCodePoint(base)) ? WIDE_ADVANCE : AVG_ADVANCE;
}

/** Advance of a whole string, in em. */
function advanceEm(body: string): number {
	let em = 0;
	for (const cluster of clusters(body)) em += advanceOf(cluster);
	return em;
}

function fitsIn(body: string, size: number, width: number): boolean {
	return advanceEm(body) * size <= width;
}

/** The largest size in [min, base] that fits, stepping by 2. */
function fitSize(body: string, width: number, base: number, min: number): number {
	let size = base;
	while (size > min && !fitsIn(body, size, width)) size -= 2;
	return size;
}

/** Cut to what fits at `size`, with an ellipsis stating that it was cut. Cut by
 *  GRAPHEME CLUSTER, never by code unit: half a surrogate pair makes the markup
 *  unencodable, and encodeURIComponent (the raster path) throws on it. A cut
 *  inside a ZWJ sequence is legal markup and still wrong: it prints a stray
 *  member of the family. */
function clampText(body: string, size: number, width: number): string {
	if (fitsIn(body, size, width)) return body;
	// The ellipsis takes an advance of its own out of the budget.
	const budget = width / size - AVG_ADVANCE;
	const kept: string[] = [];
	let em = 0;
	for (const cluster of clusters(body)) {
		const next = em + advanceOf(cluster);
		// A width too narrow for even one cluster still keeps that one cluster.
		if (next > budget && kept.length > 0) break;
		kept.push(cluster);
		em = next;
	}
	return `${kept.join('').trimEnd()}…`;
}

interface TextOpts {
	size: number;
	fill: string;
	weight?: number;
	anchor?: 'middle';
	tracking?: number;
}

function text(x: number, y: number, body: string, o: TextOpts): string {
	const attrs = [
		`x="${x}"`,
		`y="${y}"`,
		`font-size="${o.size}"`,
		`fill="${o.fill}"`,
		o.weight ? `font-weight="${o.weight}"` : '',
		o.anchor === 'middle' ? 'text-anchor="middle"' : '',
		o.tracking ? `letter-spacing="${o.tracking}"` : ''
	].filter(Boolean);
	return `<text ${attrs.join(' ')}>${esc(body)}</text>`;
}

/**
 * A platform mark on a handle row: the icon component's artwork, scaled by a
 * nested <svg> rather than by transform arithmetic. Scaled from the art's OWN
 * viewBox, so a mark drawn on a different grid still lands at the same optical
 * size as the rest. The fill sits on the wrapper because a mark can be any
 * number of shapes, and fill inherits. The <title> carries the platform name,
 * which the row no longer spells out in text.
 */
function socialIcon(
	x: number,
	baseline: number,
	size: number,
	art: SocialIconArt,
	name: string,
	fill: string
): string {
	const top = Math.round(baseline - size * ICON_LIFT_RATIO);
	return [
		`<svg x="${x}" y="${top}" width="${size}" height="${size}" viewBox="0 0 ${art.viewBox} ${art.viewBox}" fill="${fill}" role="img">`,
		`<title>${esc(name)}</title>`,
		art.shapes,
		'</svg>'
	].join('');
}

/** The card ground plus the hairline edge both faces end with. */
function cardGround(fill: string): string {
	return `<rect x="0" y="0" width="${CON_CARD_WIDTH}" height="${CON_CARD_HEIGHT}" rx="${RADIUS}" fill="${fill}"/>`;
}

function cardEdge(stroke: string): string {
	// Over everything, so it reads as a card edge rather than a border the
	// stripe bands can paint across.
	return `<rect x="1" y="1" width="${CON_CARD_WIDTH - 2}" height="${CON_CARD_HEIGHT - 2}" rx="${RADIUS - 1}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
}

/** The first character of the name, for the ring with no avatar in it. Split by
 *  code point: a name starting with an emoji or an astral CJK glyph must not be
 *  cut in half. */
function initialOf(name: string): string {
	return [...name.trim()][0]?.toUpperCase() ?? '';
}

/** The front: colours, face, name. Worn all day, read from across a table. */
function frontParts(opts: ConCardOptions, ids: string): string[] {
	const c = PALETTES[opts.variant];
	const colors = (opts.colors ?? []).slice(0, MAX_CARD_COLORS);
	const parts: string[] = [];

	parts.push(
		`<clipPath id="${ids}-card"><rect x="0" y="0" width="${CON_CARD_WIDTH}" height="${CON_CARD_HEIGHT}" rx="${RADIUS}"/></clipPath>`
	);
	parts.push(cardGround(c.bg));

	// The bands run edge to edge, clipped to the card so they honour its corners.
	// With colours turned off a single neutral band still gives the face a ground
	// to sit on, rather than leaving the top of the card empty.
	parts.push(`<g clip-path="url(#${ids}-card)">`);
	const bands = colors.length ? colors.map((color) => color.hex) : [c.stripeFallback];
	bands.forEach((hex, i) => {
		const top = Math.round((STRIPE_H * i) / bands.length);
		const bottom = Math.round((STRIPE_H * (i + 1)) / bands.length);
		parts.push(
			`<rect x="0" y="${top}" width="${CON_CARD_WIDTH}" height="${bottom - top}" fill="${esc(hex)}"/>`
		);
	});
	parts.push('</g>');

	// The face sits on the bands, which is what makes the card read as this
	// person rather than as a palette with a name under it.
	if (opts.avatarHref) {
		parts.push(
			`<clipPath id="${ids}-face"><circle cx="${FACE_CX}" cy="${FACE_CY}" r="${FACE_R}"/></clipPath>`
		);
		// slice: fill the circle and crop, rather than letterbox a portrait.
		parts.push(
			`<image href="${esc(opts.avatarHref)}" x="${FACE_CX - FACE_R}" y="${FACE_CY - FACE_R}" width="${FACE_R * 2}" height="${FACE_R * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${ids}-face)"/>`
		);
	} else {
		parts.push(
			`<circle cx="${FACE_CX}" cy="${FACE_CY}" r="${FACE_R}" fill="${c.bg}"/>`,
			text(FACE_CX, FACE_CY + FACE_R * 0.36, initialOf(opts.name), {
				size: Math.round(FACE_R),
				fill: c.initial,
				weight: 700,
				anchor: 'middle'
			})
		);
	}
	parts.push(
		`<circle cx="${FACE_CX}" cy="${FACE_CY}" r="${FACE_R}" fill="none" stroke="${c.ring}" stroke-width="${FACE_RING}"/>`
	);

	const contentW = CON_CARD_WIDTH - PAD * 2;
	const nameSize = fitSize(opts.name, contentW, 152, 72);
	parts.push(
		text(FACE_CX, NAME_BASELINE, clampText(opts.name, nameSize, contentW), {
			size: nameSize,
			fill: c.fg,
			weight: 700,
			anchor: 'middle'
		})
	);
	if (opts.species) {
		parts.push(
			text(FACE_CX, SPECIES_BASELINE, clampText(opts.species, 52, contentW), {
				size: 52,
				fill: c.muted,
				anchor: 'middle'
			})
		);
	}

	parts.push(cardEdge(c.border));
	return parts;
}

/** The back: the ten second handoff. QR, domain, handles, microtext. */
function backParts(opts: ConCardOptions, ids: string): string[] {
	const c = PALETTES[opts.variant];
	const handles = opts.handles ?? [];
	const contentW = CON_CARD_WIDTH - PAD * 2;
	const parts: string[] = [];

	parts.push(cardGround(c.bg));

	const qr = qrSvg(opts.connectUrl);
	const plate = QR_SIZE + QR_PLATE_PAD * 2;
	parts.push(
		`<rect x="${QR_X - QR_PLATE_PAD}" y="${QR_Y - QR_PLATE_PAD}" width="${plate}" height="${plate}" rx="24" fill="${c.qrPlate}"/>`
	);
	parts.push(
		`<svg x="${QR_X}" y="${QR_Y}" width="${QR_SIZE}" height="${QR_SIZE}" viewBox="${qr.viewBox}"><g transform="translate(${qr.translate} ${qr.translate})"><path d="${qr.path}" fill="${c.qrModule}"/></g></svg>`
	);
	parts.push(
		text(FACE_CX, DOMAIN_BASELINE, clampText(opts.displayDomain, 44, contentW), {
			size: 44,
			fill: c.muted,
			anchor: 'middle'
		})
	);

	parts.push(
		`<line x1="${PAD}" y1="${DIVIDER_Y}" x2="${CON_CARD_WIDTH - PAD}" y2="${DIVIDER_Y}" stroke="${c.rule}" stroke-width="2"/>`
	);

	// The mock's two-handle guidance is a recommendation, not a limit: past it
	// the rows shrink instead of the list being cut.
	const size = handles.length > COMFORTABLE_HANDLES ? 44 : 56;
	const icon = Math.round(size * ICON_SIZE_RATIO);
	const gap = Math.round(size * ICON_GAP_RATIO);
	// Pitch scales with the row so six handles still clear the microtext.
	const pitch = Math.round(size * ICON_ROW_PITCH);
	handles.forEach((handle, i) => {
		const baseline = HANDLES_TOP + i * pitch;
		const art = SOCIAL_ICON_ART[handle.platform];
		const name = SOCIAL_PLATFORM_NAMES[handle.platform] ?? '';
		if (!art) {
			// No artwork for this platform: the row reads as the platform name and
			// the handle, rather than as a handle with a hole where its icon goes.
			const line = name ? `${name} ${handle.value}` : handle.value;
			parts.push(text(PAD, baseline, clampText(line, size, contentW), { size, fill: c.fg }));
			return;
		}
		// Muted, like the domain: the icon says which platform, the handle beside
		// it is the part a stranger has to read and type.
		parts.push(socialIcon(PAD, baseline, icon, art, name, c.muted));
		const textX = PAD + icon + gap;
		parts.push(
			text(textX, baseline, clampText(handle.value, size, CON_CARD_WIDTH - PAD - textX), {
				size,
				fill: c.fg
			})
		);
	});

	// Microtext at the bottom edge: there to be found by someone who goes looking
	// for it, not to compete with the QR.
	if (opts.artCredit) {
		parts.push(
			text(FACE_CX, CREDIT_BASELINE, clampText(opts.artCredit, MICRO_SIZE, contentW), {
				size: MICRO_SIZE,
				fill: c.muted,
				anchor: 'middle'
			})
		);
	}
	parts.push(
		text(FACE_CX, MADE_BASELINE, clampText(opts.madeWith, MICRO_SIZE, contentW), {
			size: MICRO_SIZE,
			fill: c.muted,
			anchor: 'middle'
		})
	);

	parts.push(cardEdge(c.border));
	return parts;
}

function faceParts(face: ConCardFace, opts: ConCardOptions): string[] {
	// The id prefix is the face name: a sheet holds exactly one of each, so that
	// is enough to keep two clipPaths in one document from colliding.
	return face === 'front' ? frontParts(opts, 'cc-front') : backParts(opts, 'cc-back');
}

/** One face as standalone SVG markup, at true card size. */
export function conCardFaceSvg(face: ConCardFace, opts: ConCardOptions): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH_IN}" height="${CARD_HEIGHT_IN}" viewBox="0 0 ${CON_CARD_WIDTH} ${CON_CARD_HEIGHT}" font-family="${FONT}" role="img">`,
		opts.title ? `<title>${esc(opts.title)}</title>` : '',
		...faceParts(face, opts),
		'</svg>'
	]
		.filter(Boolean)
		.join('');
}

/** Margin around the pair, wide enough to hold a crop mark outside each card. */
const SHEET_MARGIN = 100;
/** Gap between the two faces, so a knife between them cuts neither. */
const SHEET_GAP = 100;
/** Crop mark length, and how far it stands off the corner it marks. */
const MARK = 40;
const MARK_GAP = 20;
export const CON_CARD_SHEET_WIDTH = SHEET_MARGIN * 2 + SHEET_GAP + CON_CARD_WIDTH * 2;
export const CON_CARD_SHEET_HEIGHT = SHEET_MARGIN * 2 + CON_CARD_HEIGHT;

/** Eight marks around one card: two per corner, standing off the trim line so
 *  the knife has something to line up against without drawing on the card. */
function cropMarks(x: number, y: number, stroke: string): string {
	const right = x + CON_CARD_WIDTH;
	const bottom = y + CON_CARD_HEIGHT;
	const lines: Array<[number, number, number, number]> = [];
	for (const [cx, dx] of [
		[x, -1],
		[right, 1]
	] as const) {
		for (const [cy, dy] of [
			[y, -1],
			[bottom, 1]
		] as const) {
			lines.push([cx + dx * MARK_GAP, cy, cx + dx * (MARK_GAP + MARK), cy]);
			lines.push([cx, cy + dy * MARK_GAP, cx, cy + dy * (MARK_GAP + MARK)]);
		}
	}
	const drawn = lines
		.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
		.join('');
	return `<g stroke="${stroke}" stroke-width="2">${drawn}</g>`;
}

/**
 * Both faces side by side on one sheet, at true physical size, with crop marks.
 * Inches on the root element so the print lands at real scale rather than at
 * whatever a printer infers from the viewBox alone.
 *
 * Always the light card: the dark ground is for a phone screen, and at this
 * coverage it bleeds on a home printer and costs a cartridge per sheet.
 */
export function conCardPrintSheetSvg(opts: Omit<ConCardOptions, 'variant'>): string {
	const faceOpts: ConCardOptions = { ...opts, variant: 'light' };
	const c = PALETTES.light;
	const backX = SHEET_MARGIN + CON_CARD_WIDTH + SHEET_GAP;
	const widthIn = CON_CARD_SHEET_WIDTH / PER_INCH;
	const heightIn = CON_CARD_SHEET_HEIGHT / PER_INCH;

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${widthIn}in" height="${heightIn}in" viewBox="0 0 ${CON_CARD_SHEET_WIDTH} ${CON_CARD_SHEET_HEIGHT}" font-family="${FONT}" role="img">`,
		opts.title ? `<title>${esc(opts.title)}</title>` : '',
		// Opaque: the card is white, and a transparent sheet hides its own edges
		// against the white page it prints on.
		`<rect x="0" y="0" width="${CON_CARD_SHEET_WIDTH}" height="${CON_CARD_SHEET_HEIGHT}" fill="${c.bg}"/>`,
		cropMarks(SHEET_MARGIN, SHEET_MARGIN, c.fg),
		cropMarks(backX, SHEET_MARGIN, c.fg),
		`<g transform="translate(${SHEET_MARGIN} ${SHEET_MARGIN})">`,
		...faceParts('front', faceOpts),
		'</g>',
		`<g transform="translate(${backX} ${SHEET_MARGIN})">`,
		...faceParts('back', faceOpts),
		'</g>',
		'</svg>'
	]
		.filter(Boolean)
		.join('');
}

/** Filename stem for a downloaded card: `taro-con-card`. */
export function conCardFileBase(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug ? `${slug}-con-card` : 'con-card';
}
