// Default Privacy Policy and Terms of Service content for a Sona site.
//
// These defaults describe what the Sona application *actually* does with data
// (see below). The one data practice a fork can toggle — the optional built-in
// visitor analytics (issue #6/#149, off unless OBSERVABILITY_ENABLED is set) —
// is disclosed conditionally in the "Information we collect" section, so the
// text stays accurate whether or not a given fork enables it. An owner who
// changes their site's data practices beyond that (e.g. adds third-party
// analytics) should override the text via the admin Settings → Legal fields,
// which replace these defaults on /privacy and /terms.
//
// Kept as English content constants (not paraglide UI messages) because this is
// long-form, jurisdiction-sensitive prose an owner edits/localizes per site,
// like `aboutText` — not app chrome. Translating the defaults is a future item.
//
// NOT legal advice. Sensible starting text, not a substitute for counsel.

export interface LegalSection {
	heading: string;
	/** Paragraphs; rendered as separate <p> elements (auto-escaped plain text). */
	body: string[];
}

// Date (YYYY-MM-DD) the built-in default Privacy Policy / Terms text below last
// changed materially. This is the "Last updated" date shown on a stock fork that
// hasn't overridden the legal pages — a per-release constant, so it stays honest
// on every fork by construction (a build/deploy date would falsely advance on a
// redeploy that didn't touch the text). Bump this whenever you edit
// defaultPrivacyPolicy or defaultTerms.
export const LEGAL_DEFAULTS_UPDATED = '2026-08-19';

/**
 * Resolve the "Last updated" date to show on a legal page from a *stable* source
 * — never `new Date()` at render time, which would always read "today".
 *
 * An owner override shows `legalUpdatedAt`, the date it was last saved (stamped
 * server-side on save). The built-in defaults show `LEGAL_DEFAULTS_UPDATED`.
 */
export function legalUpdatedDate(override: string, legalUpdatedAt: string): string {
	// Override with no save stamp (config-seeded, or a pre-existing install not yet
	// re-saved): its true edit date is unknown, so return '' and let LegalPage hide
	// the line rather than claim the built-in defaults' date for custom text.
	if (override.trim()) return legalUpdatedAt;
	return LEGAL_DEFAULTS_UPDATED;
}

/**
 * Split owner-override plain text into paragraphs on blank lines, for rendering
 * as separate auto-escaped <p> elements. CRLF is normalized first — browsers
 * submit <textarea> line breaks as \r\n, so a blank line arrives as \r\n\r\n
 * and would otherwise never split.
 */
export function splitParagraphs(text: string): string[] {
	return text
		.replace(/\r\n?/g, '\n')
		.trim()
		.split(/\n\s*\n/);
}

/**
 * Meta description for a legal-style page: cut at a word boundary and add an
 * ellipsis only when something was actually removed, so a share card never
 * ends mid-word. Shared by /privacy, /terms and /ai.
 */
export function metaDescription(text: string, limit = 200): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	const cut = trimmed.slice(0, limit);
	const lastSpace = cut.lastIndexOf(' ');
	return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}\u2026`;
}

export interface LegalOptions {
	siteName: string;
	/** From the `contactEmail` setting; empty falls back to a generic phrase. */
	contactEmail: string;
	/**
	 * Whether this site publishes the /ai disclosure (the `aiPageEnabled`
	 * setting). An owner who declined that page has told us they do not stand
	 * behind its claims, so the processor paragraph naming the AI development
	 * tools is omitted here too — otherwise the opt-out would hide the page
	 * while the legal document kept naming processors they may not use. Owners
	 * whose practice differs either way set their own text in Settings → Legal.
	 */
	aiToolsDisclosed?: boolean;
	/**
	 * Whether this site publishes the RSS feed (the `rssFeedEnabled` setting).
	 * The feed paragraph below describes something a visitor can subscribe to and
	 * a fact about it they cannot undo — that feed readers keep their own copies
	 * — so a fork with the feed turned off must not carry it. Undefined means
	 * published, matching the setting's own default-ON polarity.
	 */
	feedPublished?: boolean;
}

function contactLine(opts: LegalOptions): string {
	return opts.contactEmail
		? `You can reach us at ${opts.contactEmail}.`
		: 'You can reach us using the contact options provided on this site.';
}

/** Code-accurate default Privacy Policy. */
export function defaultPrivacyPolicy(opts: LegalOptions): LegalSection[] {
	const site = opts.siteName;
	return [
		{
			heading: 'Overview',
			body: [
				`${site} is a personal art gallery. This policy explains what information the site handles and your choices. We aim to collect as little as possible.`
			]
		},
		{
			heading: 'Information we collect',
			body: [
				"From visitors, we do not require an account and do not require you to provide personal information to browse. The site stores a small preference cookie for your light/dark theme and a browser-local setting for your preferred gallery layout. It sets no advertising or analytics cookies. On the public pages, the third-party scripts and files the site loads set no cookies for advertising or cross-site tracking.",
				'When the site owner signs in to manage the site, an administrative session cookie is set for the owner only.',
				'Our hosting and content-delivery provider (Cloudflare) may process limited technical data such as IP address and request metadata to serve and secure the site. This is standard server operation, not tracking by us.',
				'Some sites turn on an optional built-in analytics feature. If this site has visitor analytics enabled, it keeps aggregate counters in its own database to understand how the site is used: how often pages are viewed, which site referred a visit, visitor country, device type (desktop, mobile, or tablet), and how often the download button is pressed. These are counters, not profiles: they use no cookies, store no IP addresses, and keep no records tied to an individual visitor, and none of it is shared with any other site or service. The page-view, referrer, country, and device counters are deleted by a weekly cleanup once they are about 35 days old. The download count is kept as a simple running total. The same feature also keeps a short diagnostic record of recent errors — the request path, the HTTP status, and an error message with personal details removed — limited to the newest 200 entries and visible only to the site owner.',
				'When the site is served through Cloudflare, Cloudflare may add its own Web Analytics script to pages. It measures page views and performance for the site owner. Cloudflare states that this script uses no cookies, does not identify individual visitors, and does not track them across sites.'
			]
		},
		{
			heading: 'Artwork and third-party attribution',
			body: [
				`${site} displays artwork and attributes it to the artists who created it, which may include their names, handles, and links to their profiles. Fursuit photographs may be attributed to their photographers, and 3D avatar models to the artists who modeled, rigged, or textured them.`,
				'Artist profile pictures are normally copied to our own storage, but when that copy is unavailable your browser loads the image from the artist\'s own host (for example X, Bluesky, or our upload provider), which receives your IP address and the page you are viewing.',
				...(opts.feedPublished === false
					? []
					: [
							'The site also publishes a feed of newly added work at /feed.xml, listing titles, thumbnails, and artist and photographer credits. Feed readers and similar services fetch that feed and may keep their own copies, which this site cannot delete.'
						]),
				`If you are an artist, photographer, or other rights holder featured here and want your attribution corrected or your work removed, contact us and we will act promptly.${
					opts.feedPublished === false ? '' : ' Removal covers the copies this site itself hosts.'
				}`
			]
		},
		{
			heading: 'How information is used',
			body: [
				'Preference cookies are used only to remember your display choices. Any technical data handled by our provider is used to operate, secure, and troubleshoot the site.',
				'We do not sell or share personal information, and we do not use it for cross-context behavioral advertising.'
			]
		},
		{
			heading: 'Service providers',
			body: [
				"We rely on infrastructure providers to run the site, which may include Cloudflare (hosting, CDN, Web Analytics, and storage for images, video clips, and 3D avatar model files), on some sites a file-upload provider, and, where email is configured, an email delivery provider (Resend) that processes the site owner's account email for messages such as password resets. They process data only to provide these services. Public pages also load web fonts from Google Fonts, so Google receives your IP address, browser user-agent, and the page you are viewing when those files are fetched.",
				// The CATEGORY is disclosed unconditionally: an owner who declines the
				// /ai page may still use these tools, and dropping the whole
				// paragraph with the toggle would delete a real processor
				// disclosure. Only the vendor NAMES follow the affirmation, since
				// those are the part a declining owner has not stood behind.
				'Sites running this software are typically built and maintained with AI development tools, which do not run as part of the site itself, so nothing you do here is sent to them as you browse. When the site owner or their developer is diagnosing a problem, the operational data they share with development or code-review tools can include server logs and database records, and those logs can contain request data such as IP addresses, page URLs, and browser user-agent strings.',
				...(opts.aiToolsDisclosed === false
					? []
					: [
							"For this site those tools are Anthropic's Claude, which writes and debugs code under the developer's direction, and CodeRabbit, a code review service that reads proposed changes."
						]),
				"For specific features the site also talks to Cloudflare Turnstile (bot protection on the sign-in page), Telegram (importing sticker packs), cons.fyi (convention listings), X (formerly Twitter) and Bluesky (fetching artist avatars), FurTrack (importing fursuit photos), and the shared artist registry (syncing artist credits; the registry receives this site's name and hostname as part of the sync). The site contacts these services to run the feature; they are not used to track visitors."
			]
		},
		{
			heading: 'Your privacy rights',
			body: [
				'Depending on where you live (for example, under the California Consumer Privacy Act, as amended by the CPRA), you may have the right to know what personal information is held about you, to request its deletion or correction, and to not be discriminated against for exercising these rights. Because we do not sell or share personal information, there is no "opt out of sale/sharing" to exercise.',
				`To make a request, contact us. ${contactLine(opts)} We will respond within the time frame required by applicable law.`
			]
		},
		// Not acting on DNT/GPC is only defensible because this text is true. A fork
		// that adds advertising or third-party analytics must both honor GPC as an
		// opt-out of sale/sharing and rewrite this section via Settings → Legal.
		{
			heading: 'Do Not Track and Global Privacy Control',
			body: [
				'Some browsers and extensions send a "Do Not Track" (DNT) or Global Privacy Control (GPC) signal. This site does not act on them. We do not sell or share personal information as the California Consumer Privacy Act defines those terms, and we do not use it for cross-context behavioral advertising, so these signals have no opt-out to carry here. The theme cookie described above remembers your display choice. It does not follow you to other sites.'
			]
		},
		{
			heading: 'Data retention and security',
			body: [
				'We keep information only as long as needed to operate the site, and we use reasonable measures to protect it. No method of transmission or storage is completely secure.'
			]
		},
		{
			heading: 'Children',
			body: [
				'This site is not directed to children under 13, and we do not knowingly collect their personal information.'
			]
		},
		{
			heading: 'Changes to this policy',
			body: [
				'We may update this policy from time to time. The current version is always the one published on this page.'
			]
		},
		{
			heading: 'Contact',
			body: [contactLine(opts)]
		}
	];
}

/** Code-accurate default Terms of Service. */
export function defaultTerms(opts: LegalOptions): LegalSection[] {
	const site = opts.siteName;
	return [
		{
			heading: 'Acceptance of these terms',
			body: [
				`By accessing ${site}, you agree to these terms. If you do not agree, please do not use the site.`
			]
		},
		{
			heading: 'About this site',
			body: [
				`${site} is a personal portfolio and gallery for showcasing furry artwork and related content.`
			]
		},
		{
			heading: 'Intellectual property and attribution',
			body: [
				'Artwork shown here belongs to the artists who created it, and photographs to their photographers. Displaying a work here does not transfer any rights in it. Do not copy, redistribute, or reuse artwork without permission from the rights holder.',
				'If you are a rights holder and believe content should be corrected or removed, contact us and we will address it promptly.'
			]
		},
		{
			heading: 'Acceptable use',
			body: [
				'Do not attempt to disrupt, overload, scrape at scale, gain unauthorized access to, or otherwise misuse the site. Use it for its intended purpose of viewing the gallery.'
			]
		},
		{
			heading: 'Disclaimer',
			body: [
				'The site is provided "as is" and "as available," without warranties of any kind, whether express or implied, to the fullest extent permitted by law.'
			]
		},
		{
			heading: 'Limitation of liability',
			body: [
				'To the fullest extent permitted by law, the site owner is not liable for any indirect, incidental, or consequential damages arising from your use of the site.'
			]
		},
		{
			heading: 'Changes to these terms',
			body: [
				'We may update these terms from time to time. The current version is always the one published on this page.'
			]
		},
		{
			heading: 'Contact',
			body: [contactLine(opts)]
		}
	];
}
