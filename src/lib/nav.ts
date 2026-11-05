// Which top-nav item (desktop header and phone bottom bar) the current page
// belongs to. Stickers and VR avatars are tabs of the gallery, so their pages
// sit in the Gallery section.

const GALLERY_PATHS = ['/gallery', '/stickers', '/vr'];

function within(pathname: string, base: string): boolean {
	return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * The aria-current value for a nav link: "page" on the item's own page,
 * "true" anywhere else in its section (a piece under /gallery, or /stickers,
 * is in the Gallery section but is not the Gallery page), else undefined.
 * Home ("/") matches only itself.
 */
export function navCurrent(href: string, pathname: string): 'page' | 'true' | undefined {
	if (pathname === href) return 'page';
	if (href === '/') return undefined;
	const paths = href === '/gallery' ? GALLERY_PATHS : [href];
	return paths.some((base) => within(pathname, base)) ? 'true' : undefined;
}
