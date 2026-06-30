import { json } from '@sveltejs/kit';
import { UTApi } from 'uploadthing/server';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform }) => {
	const token = platform?.env.UPLOADTHING_TOKEN;
	if (!token) return json({ exists: false });

	const { fileName, fileSize } = await request.json();
	if (!fileName || !fileSize) return json({ exists: false });

	try {
		const utapi = new UTApi({ token });
		const { files } = await utapi.listFiles({ limit: 100 });

		const duplicate = files.find(
			(f) => f.name === fileName && f.size === fileSize && f.status === 'Uploaded'
		);

		return json({ exists: !!duplicate, existingKey: duplicate?.key || null });
	} catch {
		return json({ exists: false });
	}
};
