// WCAG contrast between two computed CSS colors, for specs that check what the
// browser actually painted. Takes the rgb()/rgba() strings getComputedStyle
// returns; an alpha below 1 is refused, because the ratio of a translucent
// color depends on what is behind it.

function channels(color: string): [number, number, number] {
	const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
	if (!match) throw new Error(`not an rgb() color: ${color}`);
	const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
	if (parts.length === 4 && parts[3] < 1) throw new Error(`translucent color: ${color}`);
	return [parts[0], parts[1], parts[2]];
}

function luminance(color: string): number {
	const [r, g, b] = channels(color).map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
