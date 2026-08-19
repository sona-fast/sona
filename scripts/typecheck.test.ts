import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for SONA-189: a missing brace left scripts/setup.ts
// unparseable for a month with nothing noticing — the app tsconfig only
// includes src/, so `npm run check` never sees scripts/, and vitest
// transpiles test imports without typechecking. This test typechecks every
// non-test scripts/*.ts file through the TypeScript API so a syntax or type
// error in scripts/ fails the ordinary unit suite.
// The .mjs scripts are out of scope here; they are covered by their own unit
// tests (e.g. check-lockfile-security.test.ts).

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

const entryFiles = readdirSync(scriptsDir)
	.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
	.map((f) => join(scriptsDir, f));

// Mirrors the repo tsconfig where it matters for scripts/ (strict, bundler
// resolution, .ts-extension imports via tsx) without dragging in the
// svelte-kit generated config, which scripts/ deliberately lives outside of.
const compilerOptions: ts.CompilerOptions = {
	strict: true,
	noEmit: true,
	skipLibCheck: true,
	allowImportingTsExtensions: true,
	esModuleInterop: true,
	resolveJsonModule: true,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	target: ts.ScriptTarget.ESNext,
	types: ['node'],
	typeRoots: [join(rootDir, 'node_modules', '@types')],
	paths: {
		'$app/environment': [join(rootDir, 'vitest-stubs', 'app-environment.ts')],
		'$lib/*': [join(rootDir, 'src', 'lib', '*')]
	}
};

describe('scripts/ typecheck', () => {
	it('found the script entry points', () => {
		expect(entryFiles.length).toBeGreaterThan(0);
	});

	it('every scripts/*.ts file typechecks cleanly', () => {
		const program = ts.createProgram(entryFiles, compilerOptions);
		const diagnostics = [
			...program.getSyntacticDiagnostics(),
			...program.getSemanticDiagnostics()
		];
		const formatted = diagnostics.map((d) => {
			const where = d.file
				? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
				: '(no file)';
			return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
		});
		expect(formatted).toEqual([]);
	});
});
