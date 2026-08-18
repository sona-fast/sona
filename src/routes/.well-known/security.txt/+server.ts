import type { RequestHandler } from './$types';

// RFC 9116 security.txt, served by the app itself so every deployment gets a
// vulnerability-reporting path with zero per-fork configuration (SONA-171).
//
// Contact points UPSTREAM, not at the fork operator: platform bugs are
// upstream bugs, every instance runs this same code, and a fork operator has
// no way to fix a vulnerability anyway — they'd only relay it. Private
// channels only: a public issue containing a working vulnerability is itself
// a disclosure against the whole fleet, so the GitHub link goes to private
// vulnerability reporting, never the issue tracker.
//
// Expires is computed per request (rolling, ~6 months) rather than pinned in
// the file: RFC 9116 requires the field, a hardcoded date would need a
// recurring human edit across every deployment, and a stale Expires tells a
// researcher the whole file may be abandoned — the exact signal that made the
// TailTag researcher publish.
const CONTACTS = [
	'https://github.com/sona-fast/sona/security/advisories/new',
	'mailto:security@sona.fast'
];
const POLICY = 'https://github.com/sona-fast/sona/blob/main/SECURITY.md';
const EXPIRES_DAYS = 180;

export const GET: RequestHandler = ({ url }) => {
	const expires = new Date(Date.now() + EXPIRES_DAYS * 24 * 60 * 60 * 1000);
	const lines = [
		...CONTACTS.map((c) => `Contact: ${c}`),
		`Expires: ${expires.toISOString()}`,
		// Canonical names THIS deployment's copy, so a researcher probing a fork
		// domain sees the file claims the domain it's served from (RFC 9116 §2.5.4).
		`Canonical: ${url.origin}/.well-known/security.txt`,
		`Policy: ${POLICY}`,
		'Preferred-Languages: en'
	];
	return new Response(lines.join('\n') + '\n', {
		headers: {
			// text/plain is required by the RFC; a day of edge caching keeps the
			// rolling Expires fresh enough while sparing the Function.
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
