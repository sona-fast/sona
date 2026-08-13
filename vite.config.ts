import { realpathSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { repoUrlFromEnv } from './src/lib/build-info.ts';

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

// Build receipt for the footer (SONA-167): the commit this build came from and
// the repository it lives in. Deploys run through each fork's own GitHub
// Actions (deploy.yml), where these vars are always set — so every fork gets
// its OWN repo URL, never a hardcoded upstream link that would 404 on commits
// that only exist in the fork. Local/dev builds have neither var and the
// footer omits the line. The composition lives in build-info so it can be
// unit-tested; this file is only reachable through a real build.
const buildSha = process.env.GITHUB_SHA ?? '';
const buildRepoUrl = repoUrlFromEnv(process.env);

export default defineConfig({
	define: {
		__BUILD_COMMIT_SHA__: JSON.stringify(buildSha),
		__BUILD_REPO_URL__: JSON.stringify(buildRepoUrl)
	},
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
