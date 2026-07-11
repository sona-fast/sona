import { describe, it, expect } from 'vitest';
import {
	cdnHost,
	parseWranglerConfig,
	classifyZone,
	zoneGuidance,
	findBucketDomain,
	cdnDomainState,
	bucketDomainTlsIssued,
	pagesDomainAttached,
	classifyCdnProbe,
	planConnect,
	siteUrlMismatch,
	buildLadder,
	firstFailingRung,
	renderLadder,
	type CdnDomainState,
	type CdnProbe
} from './connect-domains-lib.ts';

describe('cdnHost', () => {
	it('prefixes cdn. onto the bare host', () => {
		expect(cdnHost('taro.surf')).toBe('cdn.taro.surf');
	});
});

describe('parseWranglerConfig', () => {
	const toml = `name = "taro-surf"\ncompatibility_date = "2025-04-01"\n[[r2_buckets]]\nbinding = "IMAGES"\nbucket_name = "taro-surf-images"\n`;

	it('reads the project name and images bucket', () => {
		expect(parseWranglerConfig(toml)).toEqual({ project: 'taro-surf', bucket: 'taro-surf-images' });
	});

	it('throws when the project name is missing', () => {
		expect(() => parseWranglerConfig('bucket_name = "b"')).toThrow(/project name/);
	});

	it('throws when the bucket is missing', () => {
		expect(() => parseWranglerConfig('name = "p"')).toThrow(/bucket/);
	});
});

describe('classifyZone', () => {
	it('marks an active zone with its id and nameservers', () => {
		const z = classifyZone([{ id: 'z1', status: 'active', name_servers: ['a.ns.cf', 'b.ns.cf'] }]);
		expect(z).toEqual({ exists: true, active: true, id: 'z1', nameServers: ['a.ns.cf', 'b.ns.cf'] });
	});

	it('marks a pending zone as existing-but-inactive', () => {
		const z = classifyZone([{ id: 'z1', status: 'pending', name_servers: ['a.ns.cf'] }]);
		expect(z.exists).toBe(true);
		expect(z.active).toBe(false);
	});

	it('reports a missing zone when the result is empty', () => {
		expect(classifyZone([])).toEqual({ exists: false, active: false });
		expect(classifyZone(undefined)).toEqual({ exists: false, active: false });
	});
});

describe('zoneGuidance (fail-soft messages)', () => {
	it('tells the operator to add the zone when it does not exist', () => {
		expect(zoneGuidance({ exists: false, active: false }, 'taro.surf')).toMatch(
			/No Cloudflare zone found for taro\.surf/
		);
	});

	it('surfaces the assigned nameservers when the zone is pending', () => {
		const g = zoneGuidance(
			{ exists: true, active: false, nameServers: ['carter.ns.cf', 'fish.ns.cf'] },
			'taro.surf'
		);
		expect(g).toMatch(/not active/);
		expect(g).toContain('carter.ns.cf, fish.ns.cf');
	});

	it('returns null when the zone is active (proceed)', () => {
		expect(zoneGuidance({ exists: true, active: true, id: 'z1' }, 'taro.surf')).toBeNull();
	});
});

describe('cdnDomainState', () => {
	const ok = (domains: unknown[]) => ({ ok: true, status: 200, result: { domains } });

	it('is attached for an enabled custom domain', () => {
		expect(cdnDomainState(ok([{ domain: 'cdn.taro.surf', enabled: true }]), 'cdn.taro.surf')).toBe(
			'attached'
		);
	});

	it('is disabled for a present-but-off custom domain (do NOT re-create)', () => {
		expect(cdnDomainState(ok([{ domain: 'cdn.taro.surf', enabled: false }]), 'cdn.taro.surf')).toBe(
			'disabled'
		);
	});

	it('is absent when the domain is not in the list', () => {
		expect(cdnDomainState(ok([]), 'cdn.taro.surf')).toBe('absent');
	});

	it('is unknown — NOT absent — when the GET is forbidden (token lacks R2 read)', () => {
		expect(cdnDomainState({ ok: false, status: 403 }, 'cdn.taro.surf')).toBe('unknown');
		expect(cdnDomainState({ ok: false, status: 401 }, 'cdn.taro.surf')).toBe('unknown');
	});

	it('is unknown on a transient API failure too', () => {
		expect(cdnDomainState({ ok: false, status: 500 }, 'cdn.taro.surf')).toBe('unknown');
	});
});

describe('findBucketDomain / bucketDomainTlsIssued', () => {
	const result = {
		domains: [
			{ domain: 'cdn.taro.surf', enabled: true, status: { ownership: 'active', ssl: 'active' } },
			{ domain: 'old.taro.surf', enabled: false, status: { ownership: 'active', ssl: 'pending' } }
		]
	};

	it('finds a domain entry by name (undefined when absent)', () => {
		expect(findBucketDomain(result, 'cdn.taro.surf')?.enabled).toBe(true);
		expect(findBucketDomain(result, 'nope.taro.surf')).toBeUndefined();
	});

	it('reports TLS issued only when status.ssl is active', () => {
		expect(bucketDomainTlsIssued(result, 'cdn.taro.surf')).toBe(true);
		expect(bucketDomainTlsIssued(result, 'old.taro.surf')).toBe(false);
	});
});

describe('pagesDomainAttached', () => {
	it('is true when the host is in the Pages domains list', () => {
		expect(pagesDomainAttached([{ name: 'taro.surf' }, { name: 'www.taro.surf' }], 'taro.surf')).toBe(true);
	});

	it('is false when the host is absent or the list is empty', () => {
		expect(pagesDomainAttached([{ name: 'www.taro.surf' }], 'taro.surf')).toBe(false);
		expect(pagesDomainAttached(undefined, 'taro.surf')).toBe(false);
	});
});

describe('classifyCdnProbe', () => {
	it('is ok for any real 2xx/3xx/4xx response (a 4xx for a blank key still proves the domain)', () => {
		expect(classifyCdnProbe(200)).toBe('ok');
		expect(classifyCdnProbe(301)).toBe('ok');
		expect(classifyCdnProbe(404)).toBe('ok');
	});

	it('is unreachable for a thrown fetch (status 0)', () => {
		expect(classifyCdnProbe(0)).toBe('unreachable');
	});

	it('is edge-error for a 5xx / 52x / 530 (domain resolves but origin unreachable)', () => {
		expect(classifyCdnProbe(500)).toBe('edge-error');
		expect(classifyCdnProbe(522)).toBe('edge-error');
		expect(classifyCdnProbe(530)).toBe('edge-error');
	});
});

describe('planConnect', () => {
	const base = {
		accountId: 'acct1',
		bucket: 'taro-surf-images',
		project: 'taro-surf',
		host: 'taro.surf',
		zoneId: 'z1'
	};

	it('plans BOTH mutations with the correct paths and bodies when nothing is present', () => {
		const plan = planConnect({ ...base, cdnPresent: false, pagesAttached: false });
		expect(plan).toHaveLength(2);
		expect(plan[0]).toMatchObject({
			method: 'POST',
			path: '/accounts/acct1/r2/buckets/taro-surf-images/domains/custom',
			body: { domain: 'cdn.taro.surf', zoneId: 'z1', enabled: true, minTLS: '1.2' }
		});
		expect(plan[1]).toMatchObject({
			method: 'POST',
			path: '/accounts/acct1/pages/projects/taro-surf/domains',
			body: { name: 'taro.surf' }
		});
	});

	it('skips the CDN create when the domain is already present (idempotent)', () => {
		const plan = planConnect({ ...base, cdnPresent: true, pagesAttached: false });
		expect(plan).toHaveLength(1);
		expect(plan[0].path).toContain('/pages/projects/');
	});

	it('plans nothing when both records are already present', () => {
		expect(planConnect({ ...base, cdnPresent: true, pagesAttached: true })).toEqual([]);
	});

	it('does NOT plan a create for a present-but-disabled CDN domain', () => {
		const state = cdnDomainState(
			{ ok: true, status: 200, result: { domains: [{ domain: 'cdn.taro.surf', enabled: false }] } },
			'cdn.taro.surf'
		);
		expect(state).toBe('disabled');
		const plan = planConnect({ ...base, cdnPresent: state !== 'absent', pagesAttached: true });
		expect(plan).toEqual([]); // disabled ⇒ present ⇒ no re-create POST
	});
});

describe('siteUrlMismatch', () => {
	it('skips gracefully when the setting is absent', () => {
		expect(siteUrlMismatch(null, 'taro.surf')).toEqual({ checked: false, mismatch: false });
		expect(siteUrlMismatch('', 'taro.surf')).toEqual({ checked: false, mismatch: false });
	});

	it('warns when the deployed siteUrl host differs from the domain being connected', () => {
		expect(siteUrlMismatch('https://taro-surf.pages.dev', 'taro.surf')).toEqual({
			checked: true,
			mismatch: true,
			settingHost: 'taro-surf.pages.dev'
		});
	});

	it('does not warn when the hosts match (scheme/case/path ignored)', () => {
		expect(siteUrlMismatch('https://Taro.Surf/gallery', 'taro.surf')).toEqual({
			checked: true,
			mismatch: false,
			settingHost: 'taro.surf'
		});
	});
});

describe('buildLadder + firstFailingRung', () => {
	const healthy = {
		host: 'taro.surf',
		zoneExists: true,
		zoneActive: true,
		cdnState: 'attached' as CdnDomainState,
		tlsIssued: true as boolean | null,
		imageTransforms: true as boolean | null,
		cdnLoad: 'ok' as CdnProbe
	};

	it('is all-pass with no failing rung when everything is healthy', () => {
		const ladder = buildLadder(healthy);
		expect(ladder.every((r) => r.status === 'pass')).toBe(true);
		expect(firstFailingRung(ladder)).toBeUndefined();
	});

	it('names zone-exists first and skips everything below it', () => {
		const ladder = buildLadder({ ...healthy, zoneExists: false });
		expect(firstFailingRung(ladder)?.id).toBe('zone-exists');
		expect(ladder.filter((r) => r.status === 'skip')).toHaveLength(5);
	});

	it('names zone-active as the first failure when the zone is pending', () => {
		expect(firstFailingRung(buildLadder({ ...healthy, zoneActive: false }))?.id).toBe('zone-active');
	});

	it('names cdn-attached as the first failure when the bucket domain is absent', () => {
		expect(firstFailingRung(buildLadder({ ...healthy, cdnState: 'absent', tlsIssued: null }))?.id).toBe(
			'cdn-attached'
		);
	});

	it("renders an UNKNOWN R2 read as a non-blocking warn (couldn't verify), not a failure", () => {
		const ladder = buildLadder({ ...healthy, cdnState: 'unknown', tlsIssued: null });
		const cdn = ladder.find((r) => r.id === 'cdn-attached')!;
		expect(cdn.status).toBe('warn');
		expect(cdn.action).toMatch(/Couldn't verify/);
		// tls can't be evaluated, but the ladder is NOT blocked and does NOT fail.
		expect(ladder.find((r) => r.id === 'tls-issued')?.status).toBe('skip');
		expect(firstFailingRung(ladder)).toBeUndefined();
	});

	it('renders a DISABLED domain as a warn to re-enable (not a create)', () => {
		const cdn = buildLadder({ ...healthy, cdnState: 'disabled', tlsIssued: null }).find(
			(r) => r.id === 'cdn-attached'
		)!;
		expect(cdn.status).toBe('warn');
		expect(cdn.action).toMatch(/DISABLED/);
	});

	it('names tls-issued as the first failure when the cert has not issued', () => {
		expect(firstFailingRung(buildLadder({ ...healthy, tlsIssued: false }))?.id).toBe('tls-issued');
	});

	it('names cdn-loads as the first failure when the domain is unreachable', () => {
		expect(firstFailingRung(buildLadder({ ...healthy, cdnLoad: 'unreachable' }))?.id).toBe('cdn-loads');
	});

	it('fails cdn-loads on a 5xx/52x edge-error with edge-specific next-action text', () => {
		const ladder = buildLadder({ ...healthy, cdnLoad: 'edge-error' });
		const rung = ladder.find((r) => r.id === 'cdn-loads')!;
		expect(rung.status).toBe('fail');
		expect(rung.action).toMatch(/5xx\/52x/);
		expect(firstFailingRung(ladder)?.id).toBe('cdn-loads');
	});

	it('treats Image Transformations off/unknown as a non-blocking warn (cdn-loads still checked)', () => {
		const off = buildLadder({ ...healthy, imageTransforms: false });
		expect(off.find((r) => r.id === 'image-transforms')?.status).toBe('warn');
		expect(off.find((r) => r.id === 'cdn-loads')?.status).toBe('pass');
		expect(firstFailingRung(off)).toBeUndefined();

		const unknown = buildLadder({ ...healthy, imageTransforms: null });
		expect(unknown.find((r) => r.id === 'image-transforms')?.status).toBe('warn');
	});
});

describe('renderLadder secret-free output', () => {
	it('renders paste-safe lines that never contain the API token', () => {
		const token = 'v1.0-DEADBEEFdeadbeefsecrettoken';
		const lines = renderLadder(
			buildLadder({
				host: 'taro.surf',
				zoneExists: true,
				zoneActive: true,
				cdnState: 'absent',
				tlsIssued: null,
				imageTransforms: null,
				cdnLoad: 'unreachable'
			})
		).join('\n');
		expect(lines).not.toContain(token);
		expect(lines).toMatch(/Next action:/);
	});

	it('reports warnings-only when nothing fails but a warn remains', () => {
		const lines = renderLadder(
			buildLadder({
				host: 'taro.surf',
				zoneExists: true,
				zoneActive: true,
				cdnState: 'attached',
				tlsIssued: true,
				imageTransforms: false,
				cdnLoad: 'ok'
			})
		).join('\n');
		expect(lines).toContain('No blocking issues — review the warnings above.');
	});

	it('reports all-pass when no rung fails or warns', () => {
		const lines = renderLadder(
			buildLadder({
				host: 'taro.surf',
				zoneExists: true,
				zoneActive: true,
				cdnState: 'attached',
				tlsIssued: true,
				imageTransforms: true,
				cdnLoad: 'ok'
			})
		).join('\n');
		expect(lines).toContain('All connect-domains checks pass.');
	});
});
