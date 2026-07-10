// Deterministic monogram colors for artist avatars that have no image.
//
// Shared spec — sona-registry implements the SAME algorithm so an avatar-less
// artist gets an identical monogram on a fork and in the registry UI. Keep this
// portable (plain integer math + a small HSL→luminance helper); do not reach for
// anything language-specific:
//   hue        = (sum of the trimmed name's UTF-16 code units) mod 360
//   background = hsl(hue, 65%, 45%)          — S and L are fixed, theme-independent
//   text       = white when the chip's relative luminance <= 0.18, else black
// The fixed 65%/45% plus the luminance-picked text keep the text/background
// contrast >= 4.5:1 (WCAG AA) for every hue; avatar-color.test.ts pins that.

const SATURATION = 65;
const LIGHTNESS = 45;
const TEXT_LIGHT = '#ffffff';
const TEXT_DARK = '#000000';
// Any threshold in [0.175, 0.183] leaves both branches >= 4.5:1 against #fff/#000.
const LUMINANCE_THRESHOLD = 0.18;

export function avatarHue(name: string): number {
	const trimmed = name.trim();
	let sum = 0;
	for (let i = 0; i < trimmed.length; i++) sum += trimmed.charCodeAt(i);
	return sum % 360;
}

export interface AvatarColor {
	hue: number;
	/** CSS hsl() background for the chip. */
	bg: string;
	/** '#ffffff' or '#000000' — whichever clears 4.5:1 on the background. */
	fg: string;
}

export function avatarColor(name: string): AvatarColor {
	const hue = avatarHue(name);
	const bg = `hsl(${hue}, ${SATURATION}%, ${LIGHTNESS}%)`;
	const fg =
		hslLuminance(hue, SATURATION, LIGHTNESS) <= LUMINANCE_THRESHOLD ? TEXT_LIGHT : TEXT_DARK;
	return { hue, bg, fg };
}

/** Up to two initials, uppercased — the one consolidated initials rule. */
export function avatarInitials(name: string): string {
	return name
		.trim()
		.split(/\s+/)
		.map((w) => w[0] ?? '')
		.join('')
		.toUpperCase()
		.slice(0, 2);
}

// WCAG relative luminance of an hsl() color, for the text-color pick above.
function hslLuminance(h: number, s: number, l: number): number {
	const [r, g, b] = hslToRgb(h, s / 100, l / 100);
	const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// HSL (h in degrees, s/l in 0..1) to RGB channels in 0..1.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = l - c / 2;
	return [r + m, g + m, b + m];
}
