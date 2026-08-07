import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SONA-143: the marketing "//" eyebrow/comment device was removed from the
// theme (the last core holdouts were the gallery "// formerly" lines). Guard
// the markup so it can't creep back in; code comments inside <script>/<style>
// blocks are fine and excluded.
function svelteFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) svelteFiles(path, out);
		else if (name.endsWith('.svelte')) out.push(path);
	}
	return out;
}

const stripBlocks = (src: string) =>
	src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

describe('the "//" slash device stays out of rendered markup', () => {
	it('no svelte template opens a text node with "// "', () => {
		for (const file of svelteFiles(join(__dirname, 'routes'))) {
			const markup = stripBlocks(readFileSync(file, 'utf8'));
			// URLs ("://") live inside quoted attribute values, not after a tag
			// boundary, so the ">// " match cannot false-positive on them.
			expect(markup, `${file} renders the // device`).not.toMatch(/>\/\/[ {]/);
		}
	});
});
