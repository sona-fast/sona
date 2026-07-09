import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// wrangler.toml.example is the committed template forks copy to wrangler.toml.
// A local `wrangler pages deploy` applies this file, including deleting any
// production var/secret it doesn't declare — so it must (a) set keep_vars so
// dashboard-managed vars survive, and (b) NOT pin FURTRACK_MODE, which is
// managed via the GitHub Actions repo variable (pinning "off" here stomped a
// live deployment). No TOML parser is vendored, so assert on the raw text.
const example = readFileSync(
	fileURLToPath(new URL('../../wrangler.toml.example', import.meta.url)),
	'utf8'
);

describe('wrangler.toml.example', () => {
	it('is still a well-formed Pages config template', () => {
		expect(example).toMatch(/^name\s*=/m);
		expect(example).toMatch(/^pages_build_output_dir\s*=/m);
	});

	it('sets keep_vars = true so local deploys keep dashboard-managed vars', () => {
		expect(example).toMatch(/^keep_vars\s*=\s*true\s*$/m);
	});

	it('does not pin FURTRACK_MODE (it would stomp the dashboard variable)', () => {
		// No `FURTRACK_MODE = …` assignment on any line (a mention in a comment is
		// fine). Anchored so a commented-out example wouldn't slip through either.
		expect(example).not.toMatch(/^\s*#?\s*FURTRACK_MODE\s*=/m);
	});
});
