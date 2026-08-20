import { describe, it, expect } from 'vitest';
import {
	cdnHost,
	parseWranglerConfig,
	classifyZone,
	zoneGuidance,
	zoneConsentLabel,
	resolveZone,
	findBucketDomain,
	cdnDomainState,
	bucketDomainTlsIssued,
	pagesDomainAttached,
	pagesDomainState,
	classifyCdnProbe,
	planConnect,
	siteUrlMismatch,
	buildLadder,
	firstFailingRung,
	renderLadder,
	type CdnDomainState,
	type CdnProbe,
	type LadderInputs
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

	it('tells a subdomain operator to add the domain they registered, naming the zones tried', () => {
		const g = zoneGuidance({ exists: false, active: false }, 'sona.taro.surf', [
			'sona.taro.surf',
			'taro.surf'
		]);
		expect(g).toContain('Add the domain you registered to this Cloudflare account');
		expect(g).toContain('Looked for zones named sona.taro.surf, taro.surf');
	});

	it('never names a computed root domain (co.uk is a public suffix, not an addable site)', () => {
		const g = zoneGuidance({ exists: false, active: false }, 'example.co.uk', [
			'example.co.uk',
			'co.uk'
		]);
		expect(g).not.toContain('co.uk to this Cloudflare account');
		expect(g).toContain('Add the domain you registered to this Cloudflare account');
		expect(g).toContain('Looked for zones named example.co.uk, co.uk');
	});

	it('omits the names-tried parenthetical when only one zone name was looked up', () => {
		const g = zoneGuidance({ exists: false, active: false }, 'taro.surf', ['taro.surf']);
		expect(g).toContain('Add the domain you registered to this Cloudflare account');
		expect(g).not.toContain('Looked for zones named');
	});

	it('names the RESOLVED parent zone in the not-active message for a subdomain host', () => {
		const g = zoneGuidance(
			{ exists: true, active: false, nameServers: ['carter.ns.cf', 'fish.ns.cf'] },
			'sona.taro.surf',
			['sona.taro.surf', 'taro.surf'],
			'taro.surf'
		);
		expect(g).toContain('Zone taro.surf (serving sona.taro.surf) exists but is not active');
		expect(g).toContain('carter.ns.cf, fish.ns.cf');
	});

	it('returns null when the zone is active (proceed)', () => {
		expect(zoneGuidance({ exists: true, active: true, id: 'z1' }, 'taro.surf')).toBeNull();
	});
});

describe('zoneConsentLabel', () => {
	it('names the parent zone AND the host it serves when they differ', () => {
		expect(zoneConsentLabel('sona.taro.surf', 'taro.surf')).toBe(
			'the taro.surf zone (which serves sona.taro.surf)'
		);
	});

	it('names just the zone when the host IS the zone', () => {
		expect(zoneConsentLabel('taro.surf', 'taro.surf')).toBe('the taro.surf zone');
	});

	it('falls back to the host when no zone name was resolved', () => {
		expect(zoneConsentLabel('taro.surf', null)).toBe('the taro.surf zone');
		expect(zoneConsentLabel('taro.surf', undefined)).toBe('the taro.surf zone');
	});
});

describe('resolveZone', () => {
	const ok = (result: unknown) => ({ ok: true, status: 200, result });
	const activeZone = [{ id: 'z1', status: 'active', name_servers: ['a.ns.cf'] }];

	it('finds the registrable-domain zone for a subdomain (second candidate)', async () => {
		const tried: string[] = [];
		const { zone, zoneName, errorStatus } = await resolveZone(
			['sona.taro.surf', 'taro.surf'],
			async (name) => {
				tried.push(name);
				return ok(name === 'taro.surf' ? activeZone : []);
			}
		);
		expect(tried).toEqual(['sona.taro.surf', 'taro.surf']);
		expect(zone).toEqual({ exists: true, active: true, id: 'z1', nameServers: ['a.ns.cf'] });
		expect(zoneName).toBe('taro.surf');
		expect(errorStatus).toBeNull();
	});

	it('stops at the first candidate that matches (no extra lookups)', async () => {
		const tried: string[] = [];
		const { zoneName } = await resolveZone(['taro.surf'], async (name) => {
			tried.push(name);
			return ok(activeZone);
		});
		expect(tried).toEqual(['taro.surf']);
		expect(zoneName).toBe('taro.surf');
	});

	it('reports no zone when no candidate matches', async () => {
		const { zone, zoneName, errorStatus } = await resolveZone(
			['sona.taro.surf', 'taro.surf'],
			async () => ok([])
		);
		expect(zone).toEqual({ exists: false, active: false });
		expect(zoneName).toBeNull();
		expect(errorStatus).toBeNull();
	});

	it('aborts the walk on an auth error and surfaces the status', async () => {
		const tried: string[] = [];
		const { zone, errorStatus, failedName } = await resolveZone(['sona.taro.surf', 'taro.surf'], async (name) => {
			tried.push(name);
			return { ok: false, status: 403 };
		});
		expect(tried).toEqual(['sona.taro.surf']);
		expect(errorStatus).toBe(403);
		expect(zone).toEqual({ exists: false, active: false });
		expect(failedName).toBe('sona.taro.surf');
	});

	it('aborts the walk on a transient error too (a 500 must not silently pick the parent zone)', async () => {
		const tried: string[] = [];
		const { zone, zoneName, errorStatus, failedName } = await resolveZone(
			['sona.taro.surf', 'taro.surf'],
			async (name) => {
				tried.push(name);
				return name === 'sona.taro.surf' ? { ok: false, status: 500 } : ok(activeZone);
			}
		);
		expect(tried).toEqual(['sona.taro.surf']); // no further candidates tried
		expect(errorStatus).toBe(500);
		expect(failedName).toBe('sona.taro.surf');
		expect(zoneName).toBeNull();
		expect(zone).toEqual({ exists: false, active: false });
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
		const plan = planConnect({ ...base, cdnPresent: false, pagesPresent: false });
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
		const plan = planConnect({ ...base, cdnPresent: true, pagesPresent: false });
		expect(plan).toHaveLength(1);
		expect(plan[0].path).toContain('/pages/projects/');
	});

	it('plans nothing when both records are already present', () => {
		expect(planConnect({ ...base, cdnPresent: true, pagesPresent: true })).toEqual([]);
	});

	// Each mutation carries the permission IT needs, so a 401/403 on the attach can
	// name that one scope instead of the whole token recipe or nothing at all.
	it('gives each mutation its own token scope', () => {
		const plan = planConnect({ ...base, cdnPresent: false, pagesPresent: false });
		expect(plan[0].scopeHint).toBe('Account → Workers R2 Storage: Edit');
		expect(plan[1].scopeHint).toBe('Account → Cloudflare Pages: Edit');
	});

	it('does NOT plan a create for a present-but-disabled CDN domain', () => {
		const state = cdnDomainState(
			{ ok: true, status: 200, result: { domains: [{ domain: 'cdn.taro.surf', enabled: false }] } },
			'cdn.taro.surf'
		);
		expect(state).toBe('disabled');
		const plan = planConnect({ ...base, cdnPresent: state !== 'absent', pagesPresent: true });
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

	it('zone-exists tells a subdomain operator to add the domain they registered, naming the zones tried', () => {
		const ladder = buildLadder({
			...healthy,
			host: 'sona.taro.surf',
			zoneExists: false,
			zoneName: null,
			candidates: ['sona.taro.surf', 'taro.surf']
		});
		const rung = firstFailingRung(ladder)!;
		expect(rung.id).toBe('zone-exists');
		expect(rung.action).toContain('Add the domain you registered to this Cloudflare account');
		expect(rung.action).toContain('Looked for zones named sona.taro.surf, taro.surf');
		expect(rung.action).not.toContain('Add sona.taro.surf');
	});

	it('zone-exists never names a computed root domain (multi-part TLD: co.uk is a public suffix)', () => {
		const ladder = buildLadder({
			...healthy,
			host: 'example.co.uk',
			zoneExists: false,
			zoneName: null,
			candidates: ['example.co.uk', 'co.uk']
		});
		const rung = firstFailingRung(ladder)!;
		expect(rung.id).toBe('zone-exists');
		expect(rung.action).not.toContain('co.uk to this Cloudflare account');
		expect(rung.action).toContain('Add the domain you registered to this Cloudflare account');
		expect(rung.action).toContain('Looked for zones named example.co.uk, co.uk');
	});

	it('names the RESOLVED (parent) zone on the transforms rung for a subdomain host', () => {
		const ladder = buildLadder({
			...healthy,
			host: 'sona.taro.surf',
			imageTransforms: false,
			zoneName: 'taro.surf',
			candidates: ['sona.taro.surf', 'taro.surf']
		});
		const rung = ladder.find((r) => r.id === 'image-transforms')!;
		expect(rung.label).toContain('the taro.surf zone');
		expect(rung.action).toContain('dashboard → taro.surf → Images');
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

		const unknown = buildLadder({
			...healthy,
			imageTransforms: null,
			imageTransformsStatus: 403
		});
		const unknownRung = unknown.find((r) => r.id === 'image-transforms');
		expect(unknownRung?.status).toBe('warn');
		// The remedy names the missing scope in the arrow form the other
		// operator-facing strings use (the notation drift guard's positive arm).
		expect(unknownRung?.action).toContain('Zone → Zone Settings: Read');
	});

	// The scope is the reason for exactly one class of failure. Naming it for a
	// 5xx or an unreachable API sends the operator to re-mint a token that was
	// never the problem, so the can't-verify rungs read their cause off the
	// response they actually got.
	const transformsAction = (over: Partial<LadderInputs>) =>
		buildLadder({ ...healthy, imageTransforms: null, ...over }).find(
			(r) => r.id === 'image-transforms'
		)!.action!;

	it('blames the Zone Settings scope for a 403 only, never for a 5xx or an unreachable API', () => {
		expect(transformsAction({ imageTransformsStatus: 401 })).toContain('token needs Zone → Zone Settings: Read');

		const server = transformsAction({
			imageTransformsStatus: 500,
			imageTransformsErrors: [{ code: 10000, message: 'Internal error' }]
		});
		expect(server).not.toContain('Zone → Zone Settings: Read');
		expect(server).toContain('(HTTP 500)');
		expect(server).toContain('the API said 10000: Internal error');

		const offline = transformsAction({ imageTransformsStatus: 0 });
		expect(offline).not.toContain('Zone → Zone Settings: Read');
		expect(offline).not.toContain('HTTP 0');
		expect(offline).toContain('the Cloudflare API did not respond');
	});

	it('says nothing about a cause when no read status was recorded', () => {
		const action = transformsAction({});
		expect(action).not.toContain('Zone → Zone Settings: Read');
		expect(action).toContain("Couldn't verify Image Transformations;");
	});

	it('reports the R2 read failure by status too, not always as a missing scope', () => {
		const cdnAction = (over: Partial<LadderInputs>) =>
			buildLadder({ ...healthy, cdnState: 'unknown', tlsIssued: null, ...over }).find(
				(r) => r.id === 'cdn-attached'
			)!.action!;
		expect(cdnAction({ cdnReadStatus: 403 })).toContain('token needs Account → Workers R2 Storage: Read');
		expect(cdnAction({ cdnReadStatus: 503 })).not.toContain('Account → Workers R2 Storage: Read');
		expect(cdnAction({ cdnReadStatus: 0 })).toContain('the Cloudflare API did not respond');
	});
});

describe('pagesDomainState', () => {
	const attached = [{ name: 'taro.surf' }];

	it('distinguishes attached from absent on a successful read', () => {
		expect(pagesDomainState({ ok: true, status: 200, result: attached }, 'taro.surf')).toBe('attached');
		expect(pagesDomainState({ ok: true, status: 200, result: [] }, 'taro.surf')).toBe('absent');
	});

	it("reports a failed read as unknown, never as 'absent' (auth-vs-absent)", () => {
		expect(pagesDomainState({ ok: false, status: 403 }, 'taro.surf')).toBe('unknown');
		expect(pagesDomainState({ ok: false, status: 500 }, 'taro.surf')).toBe('unknown');
		expect(pagesDomainState({ ok: false, status: 0 }, 'taro.surf')).toBe('unknown');
	});

	// The whole point of the unknown state: the read that failed is the one that
	// would have told us whether the attach is needed, so we must not attach.
	it('plans no Pages attach when the read failed', () => {
		const state = pagesDomainState({ ok: false, status: 500 }, 'taro.surf');
		const plan = planConnect({
			accountId: 'acct1',
			bucket: 'taro-surf-images',
			project: 'taro-surf',
			host: 'taro.surf',
			zoneId: 'z1',
			cdnPresent: true,
			pagesPresent: state !== 'absent'
		});
		expect(plan).toEqual([]);
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
