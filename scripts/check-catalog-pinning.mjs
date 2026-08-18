#!/usr/bin/env node
// Fails when a built client chunk carries most of the paraglide message
// catalog (SONA-169). A computed-key lookup into '$lib/paraglide/messages'
// defeats tree-shaking and pins all ~1,300 messages into whichever route
// imports it — /admin/settings paid 198 KB raw for a one-line label helper.
// Static property access (m.some_message) tree-shakes fine — the fixed build
// tops out at a few dozen ids in any one chunk (the exact split varies per
// build) — so the threshold below only trips on a re-pin.
//
// Run after `npm run build`: node scripts/check-catalog-pinning.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(repo, '.svelte-kit', 'output', 'client', '_app', 'immutable');
if (!existsSync(clientDir)) {
	console.error(`check-catalog-pinning: ${clientDir} not found — run \`npm run build\` first`);
	process.exit(1);
}

const ids = Object.keys(
	JSON.parse(readFileSync(join(repo, 'messages', 'en.json'), 'utf-8'))
).filter((key) => !key.startsWith('$'));
// Measured ceiling is a few dozen ids/chunk in the fixed build; a re-pin
// carries nearly the whole catalog. A quarter of the catalog (capped at 300)
// keeps a wide margin over legitimate chunks yet still arms if the catalog
// shrinks — the /4 arm assumes the catalog stays well above ~100 ids.
const LIMIT = Math.min(300, Math.ceil(ids.length / 4));

const offenders = [];
let scanned = 0;
// Surfaced in the output so a run against a stale build is visible — the
// scan can only vouch for whatever `npm run build` last produced.
let newestMtime = 0;
for (const rel of readdirSync(clientDir, { recursive: true })) {
	const relPath = String(rel);
	if (!relPath.endsWith('.js')) continue;
	scanned++;
	const path = join(clientDir, relPath);
	newestMtime = Math.max(newestMtime, statSync(path).mtimeMs);
	const text = readFileSync(path, 'utf-8');
	const count = ids.reduce((n, id) => (text.includes(id) ? n + 1 : n), 0);
	if (count > LIMIT) offenders.push({ relPath, count });
}

if (scanned === 0) {
	console.error(
		`check-catalog-pinning: no .js files found under ${clientDir} — ` +
			`stale or incomplete build? Run \`npm run build\` first`
	);
	process.exit(1);
}

if (offenders.length > 0) {
	console.error(
		`check-catalog-pinning: ${offenders.length} client chunk(s) contain more than ` +
			`${LIMIT} of the ${ids.length} message ids. A computed-key lookup into ` +
			`'$lib/paraglide/messages' is probably pinning the catalog (see SONA-169); ` +
			`replace it with a static property access.`
	);
	for (const { relPath, count } of offenders) {
		console.error(`  ${relPath}: ${count} message ids`);
	}
	process.exit(1);
}
console.log(
	`check-catalog-pinning: OK — no chunk over ${LIMIT}/${ids.length} message ids ` +
		`(${scanned} scanned, build output from ${new Date(newestMtime).toISOString()})`
);
