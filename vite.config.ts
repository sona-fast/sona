import { realpathSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

// In a git worktree node_modules is a symlink into the main checkout, which
// falls outside Vite's default allow list — dev-server requests for framework
// client files then 403 and hydration never runs (so e.g. the Turnstile widget
// on /admin/login never renders). Allowing the RESOLVED node_modules keeps
// worktree dev/e2e working; in a normal checkout the realpath is
// ./node_modules, already allowed. realpathSync throws before `npm install`,
// where the literal path is the right (and only possible) answer.
function nodeModulesRealpath(): string {
	try {
		return realpathSync('node_modules');
	} catch {
		return 'node_modules';
	}
}

export default defineConfig({
	server: {
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), nodeModulesRealpath()]
		}
	},
	plugins: [
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			// No URL prefix: prefer a saved cookie (manual override), else the
			// visitor's browser language (auto-detect), else the base locale (en).
			strategy: ['cookie', 'preferredLanguage', 'baseLocale']
		})
	]
});
