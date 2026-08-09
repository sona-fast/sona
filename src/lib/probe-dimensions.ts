/**
 * Intrinsic dimensions of a picked media File, probed client-side via an
 * object URL (Image element for stills, <video> metadata for clips). Resolves
 * {null, null} rather than rejecting on undecodable input — dimensions are
 * best-effort metadata, not a validation gate.
 *
 * Lives in $lib as THE dimension probe (SP4): the admin upload page and
 * sticker form carry older image-only copies that can migrate here later.
 */
export function probeDimensions(file: File): Promise<{ width: number | null; height: number | null }> {
	return new Promise((resolve) => {
		const objectUrl = URL.createObjectURL(file);
		const done = (width: number | null, height: number | null) => {
			URL.revokeObjectURL(objectUrl);
			resolve({ width, height });
		};
		if (file.type.startsWith('video/')) {
			const probe = document.createElement('video');
			probe.preload = 'metadata';
			probe.onloadedmetadata = () => done(probe.videoWidth || null, probe.videoHeight || null);
			probe.onerror = () => done(null, null);
			probe.src = objectUrl;
		} else {
			const probe = new Image();
			probe.onload = () => done(probe.naturalWidth || null, probe.naturalHeight || null);
			probe.onerror = () => done(null, null);
			probe.src = objectUrl;
		}
	});
}
