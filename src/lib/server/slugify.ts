export function slugify(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60);

	const suffix = Math.random().toString(36).slice(2, 6);
	return `${base}-${suffix}`;
}
