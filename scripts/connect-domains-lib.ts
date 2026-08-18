/**
 * Pure helpers for the connect-domains CLI (scripts/connect-domains.ts), split
 * out so the zone/attachment classification, the mutation plan, and the doctor
 * ladder can be unit tested without a Cloudflare account or a live shell.
 *
 * The Cloudflare REST caller (`cfApi`) and the bare-host / image-resizing
 * helpers live in setup-lib.ts and are reused verbatim — this file adds only
 * new, self-contained functions so it rebases cleanly against branches that
 * also touch setup-lib.ts.
 */

/** `cdn.<host>` — the CDN subdomain we attach to the images R2 bucket. */
export function cdnHost(host: string): string {
	return `cdn.${host}`;
}

export interface WranglerConfig {
	/** Pages project name (`name = "..."`). */
	project: string;
	/** R2 images bucket (`bucket_name = "..."`). */
	bucket: string;
}

/**
 * Reads the Pages project name and R2 bucket from a rendered wrangler.toml (the
 * one `npm run setup` writes). connect-domains attaches THOSE resources' domains,
 * so it reads them from the same source of truth rather than re-prompting.
 * Throws with an actionable message when a field is missing.
 */
export function parseWranglerConfig(toml: string): WranglerConfig {
	const project = toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
	const bucket = toml.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
	if (!project) throw new Error('Could not find the Pages project name (`name = "..."`) in wrangler.toml.');
	if (!bucket) throw new Error('Could not find the R2 bucket (`bucket_name = "..."`) in wrangler.toml.');
	return { project, bucket };
}

export interface ZoneStatus {
	exists: boolean;
	active: boolean;
	id?: string;
	nameServers?: string[];
}

/**
 * Classifies the `GET /zones?name=<host>` result: whether the domain is a zone
 * in the account at all, and whether it is `active` (nameservers propagated).
 * Surfaces the zone id (for later attach calls) and the Cloudflare-assigned
 * nameservers (so the guidance can tell the operator the exact pair to set).
 */
export function classifyZone(result: unknown): ZoneStatus {
	const zone = (Array.isArray(result) ? result : [])[0] as
		| { id?: string; status?: string; name_servers?: string[] }
		| undefined;
	if (!zone) return { exists: false, active: false };
	return {
		exists: true,
		active: zone.status === 'active',
		id: zone.id,
		nameServers: zone.name_servers
	};
}

/**
 * Resolves the Cloudflare zone serving `host` by trying each candidate zone
 * name in order (most specific first — `sona.example.com`, then `example.com`),
 * because a subdomain is served by its registrable domain's zone and an exact
 * `GET /zones?name=<subdomain>` lookup finds nothing for it. Returns the first
 * candidate that exists as a zone. ANY failed lookup aborts the walk and is
 * surfaced as `errorStatus` for the caller's hard-error path — treating a
 * transient error (500/429/status 0) as "no zone for this candidate" could
 * silently pick a parent zone, or report "add your domain" for an API blip.
 */
export async function resolveZone(
	candidates: string[],
	lookup: (name: string) => Promise<{ ok: boolean; status: number; result?: unknown }>
): Promise<{ zone: ZoneStatus; zoneName: string | null; errorStatus: number | null }> {
	for (const name of candidates) {
		const res = await lookup(name);
		if (!res.ok)
			return { zone: { exists: false, active: false }, zoneName: null, errorStatus: res.status };
		const zone = classifyZone(res.result);
		if (zone.exists) return { zone, zoneName: name, errorStatus: null };
	}
	return { zone: { exists: false, active: false }, zoneName: null, errorStatus: null };
}

/**
 * Fail-soft precondition message for the zone, or null when it's active and we
 * can proceed. Not-a-zone and not-active are operator/registrar steps outside
 * any Cloudflare token, so connect-domains prints this and exits 0 rather than
 * erroring. `candidates` are the zone names the lookup tried (a subdomain's
 * host is NOT one someone can add as a site, so the message names what was
 * tried instead of telling them to add `host` itself).
 */
export function zoneGuidance(
	zone: ZoneStatus,
	host: string,
	candidates: string[] = [host]
): string | null {
	if (!zone.exists) {
		const tried =
			candidates.length > 1 ? ` (Looked for zones named ${candidates.join(', ')}.)` : '';
		return (
			`No Cloudflare zone found for ${host}. Add the root domain ` +
			`${candidates[candidates.length - 1]} to this Cloudflare account (dashboard → Add a site), ` +
			`point your registrar's nameservers at Cloudflare, then re-run.${tried}`
		);
	}
	if (!zone.active) {
		const ns = zone.nameServers?.length ? ` Assigned nameservers: ${zone.nameServers.join(', ')}.` : '';
		return (
			`Zone for ${host} exists but is not active yet.${ns} Set those nameservers at your ` +
			`registrar; propagation can take a few hours. Re-run once the zone shows Active.`
		);
	}
	return null;
}

interface BucketDomain {
	domain?: string;
	enabled?: boolean;
	status?: { ownership?: string; ssl?: string };
}

/**
 * Finds the images bucket's custom-domain entry for `name` in a
 * `GET /accounts/{a}/r2/buckets/{b}/domains/custom` result (which nests the list
 * under `domains`). Returns undefined when it isn't attached.
 */
export function findBucketDomain(result: unknown, name: string): BucketDomain | undefined {
	const list = ((result as { domains?: BucketDomain[] } | undefined)?.domains ??
		(Array.isArray(result) ? (result as BucketDomain[]) : [])) as BucketDomain[];
	return list.find((d) => d.domain === name);
}

/**
 * The bucket's state for `name`, distinguishing the four cases the caller must
 * treat differently: `attached` (enabled — nothing to do), `disabled` (present
 * but turned off — enable it in the dashboard, do NOT re-create), `absent` (not
 * there — safe to create), and `unknown` (the GET failed, e.g. the token lacks
 * Account · Workers R2 Storage · Read — we must NOT report this as "not attached").
 */
export type CdnDomainState = 'attached' | 'disabled' | 'absent' | 'unknown';

export function cdnDomainState(
	res: { ok: boolean; status: number; result?: unknown },
	name: string
): CdnDomainState {
	if (!res.ok) return 'unknown';
	const d = findBucketDomain(res.result, name);
	if (!d) return 'absent';
	return d.enabled === false ? 'disabled' : 'attached';
}

/** True when the bucket custom domain's TLS certificate has been issued (`status.ssl === 'active'`). */
export function bucketDomainTlsIssued(result: unknown, name: string): boolean {
	return findBucketDomain(result, name)?.status?.ssl === 'active';
}

/**
 * True when `host` is already attached to the Pages project in a
 * `GET /accounts/{a}/pages/projects/{p}/domains` result (idempotency guard).
 */
export function pagesDomainAttached(result: unknown, host: string): boolean {
	const list = (Array.isArray(result) ? result : []) as { name?: string }[];
	return list.some((d) => d.name === host);
}

/**
 * Classifies an HTTPS probe to `cdn.<domain>/`: `ok` for any real response
 * (a 4xx for a blank key still proves the domain + TLS are wired), `unreachable`
 * for a thrown fetch (status 0 — DNS/TLS never connected), and `edge-error` for
 * a 5xx/52x (the domain resolves but Cloudflare can't reach the R2 origin — a
 * broken custom-domain binding, NOT a healthy CDN).
 */
export type CdnProbe = 'ok' | 'unreachable' | 'edge-error';

export function classifyCdnProbe(status: number): CdnProbe {
	if (status <= 0) return 'unreachable';
	if (status >= 500) return 'edge-error';
	return 'ok';
}

export interface ConnectPlanInput {
	accountId: string;
	bucket: string;
	project: string;
	host: string;
	zoneId: string;
	/** The CDN custom domain already exists (attached OR disabled OR unverifiable) — don't create it. */
	cdnPresent: boolean;
	pagesAttached: boolean;
}

export interface PlannedMutation {
	method: 'POST';
	path: string;
	body: Record<string, unknown>;
	label: string;
}

/**
 * The exactly-two-mutations plan: attach `cdn.<host>` to the images bucket (R2
 * custom-domain API — auto-creates the DNS record + TLS cert) and attach `<host>`
 * to the Pages project. Each is emitted ONLY when the record isn't already
 * present, so a re-run after a partial success issues just the missing call
 * (idempotent) — and a present-but-disabled CDN domain is left for the operator
 * to re-enable rather than re-created. Adds nothing else to the zone.
 */
export function planConnect(i: ConnectPlanInput): PlannedMutation[] {
	const out: PlannedMutation[] = [];
	const cdn = cdnHost(i.host);
	if (!i.cdnPresent)
		out.push({
			method: 'POST',
			path: `/accounts/${i.accountId}/r2/buckets/${i.bucket}/domains/custom`,
			body: { domain: cdn, zoneId: i.zoneId, enabled: true, minTLS: '1.2' },
			label: `attach ${cdn} to the ${i.bucket} bucket`
		});
	if (!i.pagesAttached)
		out.push({
			method: 'POST',
			path: `/accounts/${i.accountId}/pages/projects/${i.project}/domains`,
			body: { name: i.host },
			label: `attach ${i.host} to the ${i.project} Pages project`
		});
	return out;
}

/**
 * Compares a `siteUrl` site-setting (read from D1, when present) against the
 * domain being connected. `checked: false` when the setting is absent or
 * unreadable so the caller skips the rung gracefully. Forward-compatible with
 * the siteUrl setting SONA-24 seeds.
 */
export function siteUrlMismatch(
	siteUrl: string | null | undefined,
	host: string
): { checked: boolean; mismatch: boolean; settingHost?: string } {
	const value = (siteUrl ?? '').trim();
	if (!value) return { checked: false, mismatch: false };
	const settingHost = value
		.replace(/^https?:\/\//i, '')
		.replace(/\/.*$/, '')
		.toLowerCase();
	return { checked: true, mismatch: settingHost !== host.toLowerCase(), settingHost };
}

export type RungStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Rung {
	id: string;
	label: string;
	status: RungStatus;
	/** Exact next action, present when the rung is not `pass`. */
	action?: string;
}

export interface LadderInputs {
	host: string;
	zoneExists: boolean;
	zoneActive: boolean;
	/** attached = healthy, absent = not there, disabled = present-but-off, unknown = R2 read failed. */
	cdnState: CdnDomainState;
	/** true = cert issued, false = still provisioning, null = couldn't verify (R2 read failed / not attached). */
	tlsIssued: boolean | null;
	/** true = on, false = off, null = couldn't verify (token lacks Zone Settings·Read). */
	imageTransforms: boolean | null;
	cdnLoad: CdnProbe;
	/** The RESOLVED zone's name (the parent zone for a subdomain host); null/absent when no zone matched. */
	zoneName?: string | null;
	/** The zone names the lookup tried, most specific first (last one is the root domain). */
	candidates?: string[];
}

/**
 * Builds the six-rung health ladder in order. It's a strict chain: the first
 * hard `fail` blocks every rung below it (marked `skip`), because a deeper check
 * can't be evaluated until the shallower one passes — so the FIRST failing rung
 * is always the one to act on. Non-`fail` states (`warn`, `skip`) do NOT block:
 * a can't-verify R2 read (unknown) or a present-but-disabled domain surfaces as
 * a warn without masking the rungs beneath it, and Image Transformations is
 * always a warn (raw images still load without it; only resized thumbnails are
 * affected).
 */
export function buildLadder(i: LadderInputs): Rung[] {
	const cdn = cdnHost(i.host);
	// The zone serving the host — its parent zone for a subdomain. Falls back to
	// the host itself when the lookup found nothing (or the caller didn't say).
	const zoneName = i.zoneName ?? i.host;
	const candidates = i.candidates?.length ? i.candidates : [i.host];
	const rootDomain = candidates[candidates.length - 1];
	const tried =
		candidates.length > 1 ? ` (Looked for zones named ${candidates.join(', ')}.)` : '';
	const rungs: Rung[] = [];
	let blocked = false;

	const step = (id: string, label: string, outcome: RungStatus, action?: string) => {
		const status = blocked ? 'skip' : outcome;
		const r: Rung = { id, label, status };
		if (status !== 'pass' && action) r.action = action;
		rungs.push(r);
		if (status === 'fail') blocked = true;
	};

	step(
		'zone-exists',
		`a zone serving ${i.host} is in this Cloudflare account`,
		i.zoneExists ? 'pass' : 'fail',
		`Add the root domain ${rootDomain} to this Cloudflare account (dashboard → Add a site) ` +
			`and point your registrar's nameservers at Cloudflare.${tried}`
	);
	step(
		'zone-active',
		`the ${zoneName} zone is active`,
		i.zoneActive ? 'pass' : 'fail',
		`Set the Cloudflare-assigned nameservers at your registrar; propagation can take a few hours.`
	);

	const cdnOutcome: RungStatus =
		i.cdnState === 'attached' ? 'pass' : i.cdnState === 'absent' ? 'fail' : 'warn';
	const cdnAction =
		i.cdnState === 'unknown'
			? `Couldn't verify — the token lacks Account · Workers R2 Storage · Read (or a transient API error). Check the bucket's Custom Domains in the dashboard.`
			: i.cdnState === 'disabled'
				? `${cdn} is attached but DISABLED — re-enable it in dashboard → R2 → your images bucket → Settings → Custom Domains.`
				: `Run \`npm run connect-domains\` (no --check) to attach ${cdn} to the images bucket.`;
	step('cdn-attached', `${cdn} is attached to the images bucket`, cdnOutcome, cdnAction);

	const tlsOutcome: RungStatus =
		i.tlsIssued === true ? 'pass' : i.tlsIssued === null ? 'skip' : 'fail';
	const tlsAction =
		i.tlsIssued === null
			? `Not verified — depends on the R2 custom domain being attached and readable.`
			: `Certificate is still provisioning for ${cdn}; wait a few minutes and re-run --check.`;
	step('tls-issued', `the ${cdn} TLS certificate is issued`, tlsOutcome, tlsAction);

	step(
		'image-transforms',
		`Image Transformations are enabled on the ${zoneName} zone`,
		i.imageTransforms === true ? 'pass' : 'warn',
		i.imageTransforms === null
			? `Couldn't verify Image Transformations (token lacks Zone Settings·Read); check dashboard → ${zoneName} → Images → Transformations.`
			: `Enable it: dashboard → ${zoneName} → Images → Transformations → "Enable for zone". Until on, thumbnails serve the full-size original or 404.`
	);

	const cdnLoadAction =
		i.cdnLoad === 'edge-error'
			? `https://${cdn}/ returned a 5xx/52x — the domain resolves but Cloudflare can't reach the R2 origin. Recheck the custom-domain binding and its certificate.`
			: `${cdn} isn't answering over HTTPS yet — recheck the R2 custom domain and that DNS resolves.`;
	step(
		'cdn-loads',
		`a request to https://${cdn}/ is served over HTTPS`,
		i.cdnLoad === 'ok' ? 'pass' : 'fail',
		cdnLoadAction
	);

	return rungs;
}

/** The first rung the operator must act on (first hard `fail`), or undefined when none fail. */
export function firstFailingRung(ladder: Rung[]): Rung | undefined {
	return ladder.find((r) => r.status === 'fail');
}

const RUNG_ICON: Record<RungStatus, string> = { pass: '✔', fail: '✖', warn: '⚠', skip: '·' };

/**
 * Renders the ladder as plain, secret-free lines safe to paste into a chat (no
 * token, no account id — the token is never an input here, only the domain and
 * the rung outcomes). The first failing rung's action is called out at the end,
 * or a note that only warnings remain / everything passes.
 */
export function renderLadder(ladder: Rung[]): string[] {
	const lines = ladder.map((r) => {
		const suffix = r.status !== 'pass' && r.action ? `\n      → ${r.action}` : '';
		return `  ${RUNG_ICON[r.status]} ${r.label}${suffix}`;
	});
	const first = firstFailingRung(ladder);
	lines.push('');
	if (first) lines.push(`Next action: ${first.action}`);
	else if (ladder.some((r) => r.status === 'warn' || r.status === 'skip'))
		lines.push('No blocking issues — review the warnings above.');
	else lines.push('All connect-domains checks pass.');
	return lines;
}
