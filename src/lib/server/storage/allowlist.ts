// The raster content-type allowlist, in its own module so the scrubbing
// decorator can consult it without importing index.ts — which builds providers
// and would otherwise close a cycle (index → scrub → index).

// Content-types accepted for stored, publicly-served images. Deliberately raster
// only — NOT image/svg+xml or any document/active type. Stored objects are served
// from the R2 custom domain (which serves them directly with their stored
// content-type, bypassing the worker's security headers), so an SVG with a <script>
// or a text/html payload would execute in that origin. Keep this strict.
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif'
]);

/** Whether a content-type is a safe raster image we'll store and serve publicly. */
export function isAllowedImageType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	return ALLOWED_IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}
