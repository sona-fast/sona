import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Content-Security-Policy. SvelteKit auto-hashes its OWN inline hydration
		// <script> (hash mode) so script-src stays 'self' with NO 'unsafe-inline' —
		// that tightness is the whole point: it's the XSS-containment backstop for
		// the user-controlled data these pages render.
		//
		// script-src also pins the ONE hand-authored inline script in app.html (the
		// pre-paint theme resolver). SvelteKit only hashes scripts it injects, not
		// app.html's, so its sha256 is listed explicitly. If that script's bytes
		// change, recompute the hash or it will be blocked (theme flashes on load).
		//
		// style-src keeps 'unsafe-inline': Svelte emits inline style="" attributes
		// (e.g. app.html's display:contents, `style:` directives) that hashing can't
		// cover, and SvelteKit skips its own style hashing when 'unsafe-inline' is
		// present. Style injection is low-value to an attacker vs. script; scripts
		// stay locked. fonts.googleapis.com is the Google Fonts @import stylesheet.
		//
		// img-src / media-src are intentionally broad (https:): image and media
		// hosts are per-fork configurable (r2PublicUrl) and user-entered artist
		// avatars point at arbitrary external hosts (pbs.twimg.com, cdn.bsky.app,
		// UploadThing). Off-zone sources also bypass the same-origin /cdn-cgi/image
		// transform via rawFallback, loading the raw external URL directly. data: is
		// for the CSS chevron background and inline SVGs.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				// challenges.cloudflare.com: the Turnstile widget on /admin/login loads
				// its api.js (script-src) and renders its challenge in an iframe
				// (frame-src). The widget's own styles are injected inline, already
				// covered by style-src 'unsafe-inline'; it needs no connect-src (its
				// network runs inside the challenges.cloudflare.com frame).
				'script-src': [
					'self',
					'sha256-b+LZKZWtSdZmsS5XuXKlgFQg8sQ4LLl7/HzIR8xtLMo=',
					'https://challenges.cloudflare.com'
				],
				// Svelte's SSR emits a constant inline `onerror="this.__e=event"` /
				// `onload="this.__e=event"` shim on <img> etc. to capture events firing
				// before hydration (see replay_events). 'unsafe-hashes' scopes the allow
				// to exactly that one handler string — an injected onerror=... hashes
				// differently and stays blocked, so XSS containment holds.
				'script-src-attr': ['unsafe-hashes', 'sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I='],
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				// blob: is required, not a loosening: the admin upload page renders each
				// picked file through URL.createObjectURL(file) — both the preview
				// thumbnail AND getImageDimensions(), which reads naturalWidth/Height off
				// an image element. Without blob: that element fires onerror, dimensions
				// resolve to 0x0, and the form posts width/height the server stores as
				// NULL. So omitting it silently corrupts upload metadata, it doesn't
				// merely hide a thumbnail. A blob: URL is minted by this origin's own
				// script and is unguessable, so allowing it grants an attacker nothing
				// they couldn't already do with script execution.
				'img-src': ['self', 'https:', 'data:', 'blob:'],
				'media-src': ['self', 'https:'],
				'connect-src': ['self'],
				'frame-src': ['self', 'https://challenges.cloudflare.com'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'object-src': ['none'],
				'form-action': ['self']
			}
		},
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter({
			platformProxy: {
				// E2E tests override these (see playwright.config.ts) to run the dev
				// server against a throwaway local D1 in an isolated persist dir. The
				// SONA_E2E_ prefix keeps them from colliding with any real wrangler env.
				configPath: process.env.SONA_E2E_WRANGLER_CONFIG ?? 'wrangler.toml',
				persist: process.env.SONA_E2E_PERSIST_TO
					? { path: process.env.SONA_E2E_PERSIST_TO }
					: undefined
			}
		}),
		// Origin check is the real CSRF control for admin form POSTs (SameSite=Lax
		// alone is not enough). An empty trustedOrigins list is SvelteKit's strict
		// default (same-origin only), pinned explicitly so a later `['*']` — which
		// disables CSRF protection on every admin action — can't slip in silently.
		// (The deprecated `checkOrigin: true` expresses the same thing but warns on
		// every build and is slated for removal; trustedOrigins is its replacement.)
		csrf: { trustedOrigins: [] }
	}
};

export default config;
