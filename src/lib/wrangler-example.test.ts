import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// wrangler.toml.example is the committed template forks copy to wrangler.toml.
// It must (a) NOT set keep_vars — Pages configs reject it, so every wrangler
// command that loads the file fails — and (b) NOT pin FURTRACK_MODE, which is
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

	it('does not set keep_vars (Pages configs reject it, failing every wrangler command)', () => {
		expect(example).not.toMatch(/^\s*keep_vars\s*=/m);
	});

	it('does not pin FURTRACK_MODE (it would stomp the dashboard variable)', () => {
		// No `FURTRACK_MODE = …` assignment on any line (a mention in a comment is
		// fine). Anchored so a commented-out example wouldn't slip through either.
		expect(example).not.toMatch(/^\s*#?\s*FURTRACK_MODE\s*=/m);
	});
});
