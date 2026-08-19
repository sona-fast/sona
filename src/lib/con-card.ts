import { qrSvg } from '$lib/qr';
import { SOCIAL_ICON_ART, type SocialIconArt } from '$lib/social-icon-paths';
import { SOCIAL_PLATFORM_NAMES, type SocialPlatform } from '$lib/social-label';

/**
 * The con card: the operator's site as a physical object, sized for a badge
 * holder (4in x 3in, laid out at 300dpi so the print download is a real 4x3).
 *
 * Pure string building, no DOM: the settings page inlines the light variant as
 * a preview, the "save to phone" path rasterizes the dark one through a canvas,
 * and the tests read the markup directly. Anything that needs a browser (the
 * canvas, the data-URI embedding of the art) lives in ConCard.svelte.
 *
 * The QR encodes /connect and never /connect/qr: a printed card outlives the
 * app, and /connect is the one route that is never gated.
 */

export type ConCardVariant = 'light' | 'dark';

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

/** The three field headings. Localized by the caller: the card is printed in
 *  the operator's own language, so no string on it may be hardcoded here. */
export interface ConCardLabels {
	species: string;
	colors: string;
	online: string;
}

export interface ConCardOptions {
	variant: ConCardVariant;
	labels: ConCardLabels;
	/** The operator's display name — the only field the card can't omit. */
	name: string;
	species?: string | null;
	colors?: ConCardColor[];
	handles?: ConCardHandle[];
	/** Reference art for the left edge: a data URI, or a same-origin URL. An
	 *  external href does not draw when the SVG is rasterized through a canvas,
	 *  so the PNG path embeds the art as a data URI before calling this. */
	artHref?: string | null;
	/** Spine line over the art ("Art by @handle · taro.surf"). */
	artCredit?: string | null;
	/** What the QR encodes. Must be the fork's /connect URL. */
	connectUrl: string;
	/** The domain printed under the QR, for someone typing it instead. */
	displayDomain: string;
	/** Accessible name, localized by the caller. Omitted → no <title>. */
	title?: string;
}

/** Card geometry in user units; 300 per printed inch. */
export const CON_CARD_WIDTH = 1200;
export const CON_CARD_HEIGHT = 900;

const PAD = 56;
const RADIUS = 36;
/** Width of the art column. The image bleeds off the left edge. */
const ART_W = 300;
const QR_SIZE = 260;
const QR_X = CON_CARD_WIDTH - PAD - QR_SIZE;
const QR_Y = 292;
/** Gutter between the text column and the QR column. */
const QR_GUTTER = 48;

/** At most four swatches read as a palette; more reads as a gradient strip. */
const MAX_CARD_COLORS = 4;
/** Above this the handle rows shrink so a longer list still fits the column. */
const COMFORTABLE_HANDLES = 2;
/** Icon edge as a share of the row's font size, and the gap after it. */
const ICON_SIZE_RATIO = 0.9;
const ICON_GAP_RATIO = 0.4;
/** How far the icon box rises above the text baseline it sits on. Brand marks
 *  fill their box, so this centers one against cap height rather than against
 *  the em box, which would ride high. */
const ICON_LIFT_RATIO = 0.78;

// CJK families named explicitly: the print .svg is opened in tools that do not
// resolve the css generic keywords, and Arial has no Japanese glyphs. They sit
// AFTER the Latin families on purpose: fallback is per glyph, so Latin keeps
// Helvetica while Japanese falls through to a family that has it.
const FONT =
	"ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, 'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif";

/**
 * The two palettes. The QR keeps dark modules on a light plate in BOTH — an
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
		swatchEdge: 'rgba(0,0,0,0.16)',
		spineText: '#ffffff',
		spineScrim: 'rgba(0,0,0,0.42)',
		qrPlate: '#ffffff',
		qrModule: '#18181b'
	},
	dark: {
		bg: '#101014',
		border: '#2a2a31',
		fg: '#fafafa',
		muted: '#a1a1aa',
		rule: '#2a2a31',
		swatchEdge: 'rgba(255,255,255,0.22)',
		spineText: '#ffffff',
		spineScrim: 'rgba(0,0,0,0.5)',
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
		.replaceAll('"', '&quot;');
}

/**
 * SVG text does not wrap, so long values are measured and then cut. The 0.56em
 * average advance is a heuristic for a sans-serif at these sizes: it errs
 * narrow, which costs a little air rather than a clipped name.
 */
const AVG_ADVANCE = 0.56;

function fitsIn(body: string, size: number, width: number): boolean {
	return body.length * size * AVG_ADVANCE <= width;
}

/** The largest size in [min, base] that fits, stepping by 2. */
function fitSize(body: string, width: number, base: number, min: number): number {
	let size = base;
	while (size > min && !fitsIn(body, size, width)) size -= 2;
	return size;
}

/** Cut to what fits at `size`, with an ellipsis stating that it was cut. */
function clampText(body: string, size: number, width: number): string {
	if (fitsIn(body, size, width)) return body;
	const max = Math.max(1, Math.floor(width / (size * AVG_ADVANCE)) - 1);
	return `${body.slice(0, max).trimEnd()}…`;
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

/** A field heading: small, tracked out, upper case. */
function fieldLabel(x: number, y: number, body: string, fill: string): string {
	return `<text x="${x}" y="${y}" font-size="24" font-weight="600" letter-spacing="4" fill="${fill}">${esc(body.toUpperCase())}</text>`;
}

/** The whole card as standalone SVG markup. */
export function conCardSvg(opts: ConCardOptions): string {
	const c = PALETTES[opts.variant];
	const colors = (opts.colors ?? []).slice(0, MAX_CARD_COLORS);
	const handles = opts.handles ?? [];

	const contentX = opts.artHref ? ART_W + PAD : PAD;
	const contentW = QR_X - QR_GUTTER - contentX;

	const parts: string[] = [];

	// Card ground. The clip is what makes the art honour the rounded corner.
	parts.push(
		`<clipPath id="cc-card"><rect x="0" y="0" width="${CON_CARD_WIDTH}" height="${CON_CARD_HEIGHT}" rx="${RADIUS}"/></clipPath>`
	);
	parts.push(
		`<rect x="0" y="0" width="${CON_CARD_WIDTH}" height="${CON_CARD_HEIGHT}" rx="${RADIUS}" fill="${c.bg}"/>`
	);

	if (opts.artHref) {
		parts.push('<g clip-path="url(#cc-card)">');
		// slice: fill the column and crop, rather than letterbox a ref sheet.
		parts.push(
			`<image href="${esc(opts.artHref)}" x="0" y="0" width="${ART_W}" height="${CON_CARD_HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`
		);
		if (opts.artCredit) {
			// Rotated up the inner edge of the art, on its own scrim: the sheet
			// underneath can be any colour, so the credit can't rely on contrast
			// with it.
			const credit = clampText(opts.artCredit, 22, CON_CARD_HEIGHT - PAD * 2);
			const scrimW = credit.length * 22 * AVG_ADVANCE + 36;
			parts.push(`<g transform="translate(${ART_W - 34} ${CON_CARD_HEIGHT / 2}) rotate(-90)">`);
			parts.push(
				`<rect x="${-scrimW / 2}" y="-19" width="${scrimW}" height="38" rx="19" fill="${c.spineScrim}"/>`
			);
			parts.push(text(0, 8, credit, { size: 22, fill: c.spineText, weight: 500, anchor: 'middle' }));
			parts.push('</g>');
		}
		parts.push('</g>');
	}

	// Name, then the rule that separates it from the labelled fields.
	const nameSize = fitSize(opts.name, contentW, 56, 34);
	parts.push(
		text(contentX, 156, clampText(opts.name, nameSize, contentW), {
			size: nameSize,
			fill: c.fg,
			weight: 700
		})
	);
	parts.push(
		`<line x1="${contentX}" y1="196" x2="${contentX + contentW}" y2="196" stroke="${c.rule}" stroke-width="2"/>`
	);

	// The fields stack from one cursor, so an omitted section closes its own gap
	// rather than leaving a hole where it would have been.
	let y = 268;

	if (opts.species) {
		parts.push(fieldLabel(contentX, y, opts.labels.species, c.muted));
		parts.push(text(contentX, y + 46, clampText(opts.species, 38, contentW), { size: 38, fill: c.fg }));
		y += 110;
	}

	if (colors.length) {
		parts.push(fieldLabel(contentX, y, opts.labels.colors, c.muted));
		const size = 56;
		const gap = 18;
		colors.forEach((color, i) => {
			parts.push(
				`<rect x="${contentX + i * (size + gap)}" y="${y + 16}" width="${size}" height="${size}" rx="14" fill="${esc(color.hex)}" stroke="${c.swatchEdge}" stroke-width="2"/>`
			);
		});
		y += 110;
	}

	if (handles.length) {
		parts.push(fieldLabel(contentX, y, opts.labels.online, c.muted));
		// The mock's two-handle guidance is a recommendation, not a limit — past
		// it the rows shrink instead of the list being cut.
		const size = handles.length > COMFORTABLE_HANDLES ? 30 : 34;
		const icon = Math.round(size * ICON_SIZE_RATIO);
		const gap = Math.round(size * ICON_GAP_RATIO);
		handles.forEach((handle, i) => {
			const baseline = y + 44 + i * (size + 12);
			const art = SOCIAL_ICON_ART[handle.platform];
			const name = SOCIAL_PLATFORM_NAMES[handle.platform] ?? '';
			if (!art) {
				// No artwork for this platform: the row reads as the platform name and
				// the handle, rather than as a handle with a hole where its icon goes.
				const line = name ? `${name} ${handle.value}` : handle.value;
				parts.push(text(contentX, baseline, clampText(line, size, contentW), { size, fill: c.fg }));
				return;
			}
			// Muted, like the field headings: the icon says which platform, the
			// handle beside it is the part a stranger has to read and type.
			parts.push(socialIcon(contentX, baseline, icon, art, name, c.muted));
			const textX = contentX + icon + gap;
			parts.push(
				text(textX, baseline, clampText(handle.value, size, contentX + contentW - textX), {
					size,
					fill: c.fg
				})
			);
		});
	}

	// QR column. The plate is drawn under the modules in both variants so the
	// code stays dark-on-light however the card is themed.
	const qr = qrSvg(opts.connectUrl);
	parts.push(
		`<rect x="${QR_X - 14}" y="${QR_Y - 14}" width="${QR_SIZE + 28}" height="${QR_SIZE + 28}" rx="20" fill="${c.qrPlate}"/>`
	);
	parts.push(
		`<svg x="${QR_X}" y="${QR_Y}" width="${QR_SIZE}" height="${QR_SIZE}" viewBox="${qr.viewBox}"><g transform="translate(${qr.translate} ${qr.translate})"><path d="${qr.path}" fill="${c.qrModule}"/></g></svg>`
	);
	parts.push(
		text(QR_X + QR_SIZE / 2, QR_Y + QR_SIZE + 52, clampText(opts.displayDomain, 28, QR_SIZE + 60), {
			size: 28,
			fill: c.muted,
			weight: 500,
			anchor: 'middle'
		})
	);

	// Hairline over everything, so it reads as a card edge rather than a border
	// the art can paint over.
	parts.push(
		`<rect x="1" y="1" width="${CON_CARD_WIDTH - 2}" height="${CON_CARD_HEIGHT - 2}" rx="${RADIUS - 1}" fill="none" stroke="${c.border}" stroke-width="2"/>`
	);

	// Inches on the root element so the print download lands at 4x3 rather than
	// at whatever a printer infers from the viewBox alone.
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="3in" viewBox="0 0 ${CON_CARD_WIDTH} ${CON_CARD_HEIGHT}" font-family="${FONT}" role="img">`,
		opts.title ? `<title>${esc(opts.title)}</title>` : '',
		...parts,
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
