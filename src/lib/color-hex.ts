// Hex color helpers for the sona palette editor. Pure TS — no DOM, unit-tested.

/**
 * Normalize a user-typed hex color to canonical `#RRGGBB` (uppercase).
 * Accepts 3- or 6-digit hex, with or without the leading `#`.
 * Returns null when the input isn't a valid hex color.
 */
export function normalizeHex(input: string): string | null {
	const raw = input.trim().replace(/^#/, '');
	if (/^[0-9a-fA-F]{3}$/.test(raw)) {
		return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
	}
	if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`.toUpperCase();
	return null;
}

/** `#RRGGBB` (uppercase) for an r/g/b triple; components are clamped to 0–255. */
export function rgbToHex(r: number, g: number, b: number): string {
	const c = (v: number) =>
		Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
