import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SONA-143: the marketing "//" eyebrow/comment device was removed from the
// theme (the last core holdouts were the gallery "// formerly" lines). Guard
// the markup so it can't creep back in. <script>/<style> blocks are stripped
// first: a `<script>` open tag followed by an indented JS comment would match
// the tag-anchored pattern. Inline-expression JS comments remain in the
// scanned text, which is why the pattern must stay anchored to a tag boundary
// (">") rather than line start.
const srcDir = fileURLToPath(new URL('.', import.meta.url));
// readdirSync recursive (Node 20.1+) rather than fs.globSync (Node 22+) — the
// fork deploy CI runs the suite on Node 20.
const files = readdirSync(srcDir, { recursive: true })
	.map((p) => String(p))
	.filter((p) => p.endsWith('.svelte'))
	.sort();

const stripBlocks = (src: string) =>
	src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

describe('the "//" slash device stays out of rendered markup', () => {
	it('finds the svelte files to check', () => {
		// Coverage floor: src carries ~75 .svelte files; a drop below means the
		// scan silently stopped covering some.
		expect(files.length).toBeGreaterThanOrEqual(60);
	});

	it('no svelte template opens a text node with "//"', () => {
		for (const file of files) {
			const markup = stripBlocks(readFileSync(join(srcDir, file), 'utf8'));
			// URLs ("://") live inside quoted attribute values, not after a tag
			// boundary, so the ">//" match cannot false-positive on them. \s* also
			// catches the line-wrapped form (">\n\t// {m...}").
			expect(markup, `${file} renders the // device`).not.toMatch(/>\s*\/\/[ \t{]/);
		}
	});

	it('no message catalog value starts with "// "', () => {
		for (const locale of ['en', 'ja']) {
			const catalog = JSON.parse(
				readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8')
			) as Record<string, unknown>;
			for (const [key, value] of Object.entries(catalog)) {
				if (typeof value !== 'string') continue;
				expect(value, `messages/${locale}.json ${key} carries the // device`).not.toMatch(/^\/\/ /);
			}
		}
	});
});
