import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// setup.ts is main()-only: it self-executes and prompts, so there is nothing to
// import. The rules below are wiring the CLI can silently lose, so pin them at the
// source level — the same way connect-domains.test.ts pins its own main() contracts.
// Behavior lives in setup-lib.test.ts (isValidResourceName, buildSeedSql).
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.ts'), 'utf8');

// Operator answers reach wrangler through argv, never a shell command line. On a
// command line `my$site-images` arrives as `my-images` while wrangler.toml keeps
// the raw answer, so the bucket and the IMAGES binding name different things and
// setup still reports success. Nothing about that failure is loud.
describe('setup.ts ↔ no operator answer on a shell command line', () => {
	it('creates the Pages project, D1 database and R2 bucket via runArgs', () => {
		expect(src).toMatch(/runArgs\('npx', \['wrangler', 'pages', 'project', 'create', project,/);
		expect(src).toMatch(/runArgs\('npx', \['wrangler', 'd1', 'create', dbName\]/);
		expect(src).toMatch(/runArgs\('npx', \['wrangler', 'r2', 'bucket', 'create', bucket\]/);
	});

	it('runs both d1 execute calls via runArgs with a --file= argument', () => {
		const executes = src.match(/'wrangler', 'd1', 'execute', dbName, '--remote', `--file=\$\{\w+\}`/g);
		expect(executes).toHaveLength(2);
	});

	it('sets Pages secrets with execFileSync, not a shell string', () => {
		expect(src).toMatch(/execFileSync\('npx', args, \{ input:/);
		expect(src).toMatch(/const args = \['wrangler', 'pages', 'secret', 'put', name, '--project-name', project\]/);
	});

	it('never passes an interpolated name to the shell-string runner', () => {
		// run() still serves the fixed commands (whoami, git remote). A `${...}`
		// inside one of its command strings would be an answer back on a shell line.
		for (const [, cmd] of src.matchAll(/\brun\(`([^`]*)`/g)) {
			expect(cmd, cmd).not.toContain('${');
		}
	});
});

// The seed carries operator answers and is escaped for SQL only, so it goes to
// wrangler in a temp file — the migration step's own pattern, cleanup included.
describe('setup.ts ↔ the seed never rides a command line', () => {
	it('writes the seed to a temp file instead of --command', () => {
		expect(src).not.toContain('--command');
		expect(src).toMatch(/writeFileSync\(seedPath, seed\)/);
		expect(src).toMatch(/`--file=\$\{seedPath\}`/);
	});

	it('removes the seed temp file in a finally, like the migration file', () => {
		expect(src).toMatch(/\} finally \{\s*try \{\s*unlinkSync\(seedPath\);/);
	});
});

// A name is validated as ANSWERED, not just as defaulted: sanitizeProjectName only
// ever shaped the prompt default, which the operator is free to overwrite.
describe('setup.ts ↔ resource names are validated', () => {
	it('asks for all three names through askName', () => {
		expect(src).toMatch(/const project = await askName\(/);
		expect(src).toMatch(/const dbName = await askName\('D1 database name'/);
		expect(src).toMatch(/const bucket = await askName\('R2 bucket name'/);
	});

	it('re-prompts on a rejected name and gives up only without a TTY', () => {
		expect(src).toMatch(/if \(isValidResourceName\(answer\)\) return answer;/);
		expect(src).toMatch(/if \(!stdin\.isTTY\) return null;/);
	});

	it('stops setup when a name could not be re-asked', () => {
		expect(src).toMatch(/if \(project === null\) return nameAbort\(\);/);
		expect(src).toMatch(/if \(dbName === null\) return nameAbort\(\);/);
		expect(src).toMatch(/if \(bucket === null\) return nameAbort\(\);/);
	});
});

// Every untrusted path segment is encoded, matching the zone-lookup call above it
// and the waf-lib / turnstile-lib calls.
describe('setup.ts ↔ API path segments are encoded', () => {
	it('encodes the project name in the Pages-project PATCH path', () => {
		expect(src).toContain('/pages/projects/${encodeURIComponent(project)}');
	});
});
