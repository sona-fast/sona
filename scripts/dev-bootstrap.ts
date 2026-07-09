/**
 * `predev` hook (package.json): make local dev "just work" on a fresh clone by
 * ensuring a wrangler.toml + migrated local D1 exist before `vite dev` boots.
 * All the logic — and its tests — live in dev-bootstrap-lib.ts.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bootstrapDevConfig } from './dev-bootstrap-lib.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = bootstrapDevConfig({ repoRoot });
if (result === 'created') {
	console.log('Local dev is ready (wrangler.toml + local D1). Starting the dev server…');
}
