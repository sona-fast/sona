import { describe, expect, it } from 'vitest';
import { shardProjects } from './e2e-shards';

const projects = ['a', 'b', 'c'];
const shards = [['a'], ['b', 'c']];

describe('shardProjects', () => {
	it('runs every project when no shard is set', () => {
		expect(shardProjects(undefined, projects, shards)).toEqual(projects);
	});

	it('runs only the named group', () => {
		expect(shardProjects('1/2', projects, shards)).toEqual(['a']);
		expect(shardProjects('2/2', projects, shards)).toEqual(['b', 'c']);
	});

	it('refuses a project that no group runs, even with no shard set', () => {
		expect(() => shardProjects(undefined, [...projects, 'd'], shards)).toThrow(
			/in no shard: d/
		);
	});

	it('refuses a group that names a project that does not exist', () => {
		expect(() => shardProjects(undefined, ['a', 'b'], shards)).toThrow(
			/unknown projects: c/
		);
	});

	it('refuses a project listed in two groups', () => {
		expect(() =>
			shardProjects(undefined, projects, [
				['a', 'b'],
				['b', 'c']
			])
		).toThrow(/twice: b/);
	});

	it('refuses a shard count that does not match the groups', () => {
		expect(() => shardProjects('1/3', projects, shards)).toThrow(
			/E2E_SHARDS has 2/
		);
	});

	it('refuses a malformed or out-of-range shard', () => {
		expect(() => shardProjects('2', projects, shards)).toThrow(
			/must look like/
		);
		expect(() => shardProjects('0/2', projects, shards)).toThrow(
			/out of range/
		);
		expect(() => shardProjects('3/2', projects, shards)).toThrow(
			/out of range/
		);
	});
});
