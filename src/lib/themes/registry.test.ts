import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { THEMES, DEFAULT_THEME_ID } from './index.ts';
import { ALL_THEMES } from './all.ts';

// index.ts carries the picker list as a plain literal so the admin bundles do
// not pull in every palette (see the comment there). That only works while the
// literal and the data agree, which is what these asserts are for.

describe('the theme registry', () => {
	it('lists the same ids and labels as the theme data, in the same order', () => {
		expect(THEMES).toEqual(ALL_THEMES.map(({ id, label }) => ({ id, label })));
	});

	// Emission order is load-bearing: the default theme's blocks are the :root
	// floor every other theme falls back to, so it has to be first.
	it('puts the default theme first', () => {
		expect(ALL_THEMES[0].id).toBe(DEFAULT_THEME_ID);
	});

	// A theme file nobody listed is invisible: no CSS block, no contrast sweep,
	// and no picker entry — it just silently does not exist.
	it('lists every *.theme.ts file in this directory, and no others', () => {
		const dir = fileURLToPath(new URL('.', import.meta.url));
		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.theme.ts'))
			.map((f) => f.replace(/\.theme\.ts$/, ''))
			.sort();
		expect(files).toEqual(ALL_THEMES.map((t) => t.id).sort());
	});

	// `export { X } from './all.ts'` re-exports the palette and ships it just as
	// surely as an import, so the pattern matches both forms.
	// The second alternative is the bare side-effect form, `import './all.ts';`,
	// which has no `from` but still pulls the module into the graph.
	// Whole-statement type imports (`import type { X } from`, `export type { X }
	// from`) are erased at compile time and pull nothing into the bundle, so the
	// walk skips them; inline `type` specifiers inside braces still count.
	const fromClause = /^\s*(?:(?:import|export)\s(?!type\s)[^;]*?from\s*|import\s*)(['"])([^'"]+)\1/gm;
	const specifiers = (source: string) => [...source.matchAll(fromClause)].map((m) => m[2]);

	// The regex IS the guard: a pattern that stopped matching one of these forms
	// would report "imports no palette data" about a file that ships all of it.
	it('matches every form a palette import can take', () => {
		expect(specifiers(`export { ALL_THEMES } from './all.ts';`)).toEqual(['./all.ts']);
		expect(specifiers(`import { ALL_THEMES } from './all.ts';`)).toEqual(['./all.ts']);
		// Erased at compile time: neither form ships the module.
		expect(specifiers(`import type { ThemeDefinition } from './all.ts';`)).toEqual([]);
		expect(specifiers(`export type { ThemeDefinition } from './all.ts';`)).toEqual([]);
		// A bare side-effect import has no `from` clause and still ships the module.
		expect(specifiers(`import './all.ts';`)).toEqual(['./all.ts']);
		// Double quotes, which a differently configured formatter writes.
		expect(specifiers(`export { ALL_THEMES } from "./all.ts";`)).toEqual(['./all.ts']);
		expect(specifiers(`import { ALL_THEMES } from "./all.ts";`)).toEqual(['./all.ts']);
		// Wrapped across lines, the way a formatter writes a long specifier list.
		expect(specifiers(`import {\n\tALL_THEMES\n} from './all.ts';`)).toEqual(['./all.ts']);
		// And still found when it is not the first import in the file.
		expect(specifiers(`import { THEMES } from './x.ts';\nimport {\n\tALL_THEMES\n} from './all.ts';`)).toEqual([
			'./x.ts',
			'./all.ts'
		]);
	});

	// The literal above only earns its keep while index.ts imports no palette: one
	// `import { ALL_THEMES } from './all.ts'` added for convenience puts every hex
	// of every theme back into the admin bundles, and every assert in this file
	// still passes. Read the source rather than the module — an import that is
	// only used for types disappears at runtime but still ships if it is not
	// `import type`.
	it('imports no palette data', () => {
		const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
		const imported = specifiers(source);
		expect(imported.filter((s) => s.includes('/all') || /\.theme\.ts$/.test(s))).toEqual([]);
	});

	// The direct probe above only sees index.ts's own specifiers, so a module in
	// between — index.ts -> helper.ts -> all.ts — would pass it while shipping
	// every palette. This walk follows the specifiers transitively instead. A
	// static walk is enough for this module set because none of these files use
	// dynamic `import()`; if one ever does, the build-time grep for palette hexes
	// in the admin bundles stays the last line of defence.
	const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

	// Resolves the specifiers a bundler would follow into files: relative paths
	// against the importing file, and `$lib/` against src/lib, which is how this
	// repo aliases it. Packages and the `$app/`/`$env/` virtual modules carry no
	// palette data, so they are skipped.
	const resolveSpecifier = (spec: string, fromFile: string, root: string) => {
		let base: string;
		if (spec.startsWith('$lib/')) base = join(root, 'lib', spec.slice('$lib/'.length));
		else if (spec.startsWith('./') || spec.startsWith('../')) base = resolvePath(dirname(fromFile), spec);
		else return null;
		for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts')]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	};

	const reachableFrom = (entry: string, root: string) => {
		const seen = new Set<string>();
		const queue = [entry];
		while (queue.length > 0) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			for (const spec of specifiers(readFileSync(file, 'utf8'))) {
				const resolved = resolveSpecifier(spec, file, root);
				if (resolved && resolved.startsWith(root)) queue.push(resolved);
			}
		}
		return [...seen];
	};

	it('reaches no palette data through any chain of imports', () => {
		const reached = reachableFrom(fileURLToPath(new URL('./index.ts', import.meta.url)), srcRoot);
		const palette = reached.filter((f) => f.endsWith('/all.ts') || f.endsWith('.theme.ts'));
		expect(palette).toEqual([]);
	});

	// The walk IS the guard here too: one that stopped following an intermediate
	// module would report a clean chain about a file that ships every palette.
	it('reports palette data reached through an intermediate module', () => {
		const dir = mkdtempSync(join(tmpdir(), 'theme-walk-'));
		try {
			writeFileSync(join(dir, 'a.ts'), `import { b } from './b.ts';\nexport { b };\n`);
			writeFileSync(join(dir, 'b.ts'), `export { ALL_THEMES as b } from './all.ts';\n`);
			writeFileSync(join(dir, 'all.ts'), `export const ALL_THEMES = [];\n`);
			const reached = reachableFrom(join(dir, 'a.ts'), dir);
			expect(reached.filter((f) => f.endsWith('/all.ts'))).toEqual([join(dir, 'all.ts')]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
