// CI runs the Playwright suite as one job per group below: ci.yml's e2e-shard
// matrix sets SONA_E2E_SHARD=<i>/<n>, and playwright.config.ts keeps only that
// group's projects and boots only their dev servers. Booting all fourteen
// servers on one runner took about seven minutes before the first test ran.
//
// Grouped by measured run time on CI (summed test time, October 2026): upload
// (~16 min, one worker) is the longest and runs alone; commissions (~11) and
// chromium plus the tag specs (~10 wall, two workers) come next.
export const E2E_SHARDS: string[][] = [
	['upload'],
	['commissions', 'commissions-gated'],
	[
		'chromium',
		'tag-suggestions',
		'suggest-tags',
		'stickers-content',
		'passport',
		'passport-empty',
		'recovery'
	],
	['registry-sync', 'conventions-event', 'ut-stat', 'theme-picker']
];

/** The projects to run for SONA_E2E_SHARD (`<i>/<n>`), or every project when
* it's unset. Throws when a project sits in no group, in two groups, or a group
* names a project that doesn't exist, so a new project can't be skipped on CI
* without anyone noticing; and when <n> isn't the number of groups, so the
* matrix in ci.yml can't fall out of step with E2E_SHARDS. */
export function shardProjects(
	spec: string | undefined,
	projects: string[],
	shards: string[][] = E2E_SHARDS
): string[] {
	const grouped = shards.flat();
	const missing = projects.filter((p) => !grouped.includes(p));
	if (missing.length)
		throw new Error(
			`e2e projects in no shard: ${missing.join(', ')}. Add them to E2E_SHARDS in scripts/e2e-shards.ts.`
		);
	const unknown = grouped.filter((p) => !projects.includes(p));
	if (unknown.length)
		throw new Error(`E2E_SHARDS names unknown projects: ${unknown.join(', ')}`);
	const twice = grouped.filter((p, i) => grouped.indexOf(p) !== i);
	if (twice.length)
		throw new Error(`E2E_SHARDS lists projects twice: ${twice.join(', ')}`);

	if (!spec) return projects;
	const m = /^(\d+)\/(\d+)$/.exec(spec);
	if (!m) throw new Error(`SONA_E2E_SHARD must look like 2/4, got: ${spec}`);
	const [i, n] = [Number(m[1]), Number(m[2])];
	if (n !== shards.length)
		throw new Error(
			`SONA_E2E_SHARD says ${n} shards but E2E_SHARDS has ${shards.length}. Update the matrix in ci.yml.`
		);
	if (i < 1 || i > n)
		throw new Error(`SONA_E2E_SHARD index out of range: ${spec}`);
	return shards[i - 1];
}
