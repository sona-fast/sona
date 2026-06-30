import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vite';

export default defineConfig({
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
