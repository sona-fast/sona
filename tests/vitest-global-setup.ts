import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Recompile paraglide via the CLI before every vitest invocation. The vite
// plugin (vite.config.ts) compiles src/lib/paraglide with a strategy list that
// omits 'globalVariable', so any dev server, build, or Playwright webServer
// overwrites the runtime and deterministically breaks the setLocale()-driven
// tests until the CLI compile (which includes globalVariable) runs again.
// `npm test` already recompiles via the pretest script; this hook covers direct
// `npx vitest run` invocations, which bypass npm scripts. Keep the CLI args in
// sync with the `paraglide` script in package.json.
export default function setup(): void {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	execFileSync(
		'npx',
		[
			'paraglide-js',
			'compile',
			'--project',
			'./project.inlang',
			'--outdir',
			'./src/lib/paraglide',
			'--output-structure',
			'locale-modules'
		],
		{ cwd: repoRoot, stdio: 'inherit' }
	);
}
