// Default copy for the /ai disclosure page (SONA-167).
//
// Wording approved by the operator 2026-08-12 after a peer review that set the
// register: short, disclosure-only, no persuasion. Facts only — every claim
// here is backed by the codebase (no runtime AI calls anywhere), the repo
// policy (AI_POLICY.md), or the operator's own practice. An owner whose
// practice differs (or who wants their own words) overrides the text via
// Settings, or turns the page off entirely with the aiPageEnabled toggle.
//
// Kept as an English content constant like $lib/legal — long-form prose an
// owner edits per site, not app chrome.

export interface AiDisclosureTopic {
	/** Short bold lead-in, e.g. "The code." */
	lead: string;
	body: string;
}

export interface AiDisclosureLink {
	text: string;
	href: string;
	/**
	 * Screen-reader label where the visible text ("through GitHub") doesn't
	 * name the action on its own. Omitted when the text is self-describing.
	 */
	ariaLabel?: string;
}

export interface AiDisclosureSecurity {
	/** Short bold lead-in, like AiDisclosureTopic. */
	lead: string;
	/** Body segments in order; strings render as text, links as anchors. */
	body: (string | AiDisclosureLink)[];
}

export interface AiDisclosure {
	intro: string;
	topics: AiDisclosureTopic[];
	/**
	 * The vulnerability-reporting line (SONA-171). Separate from `topics`
	 * because its contacts must be clickable, and a plain-text body can't
	 * carry an anchor. Points at the UPSTREAM channels — a fork operator
	 * can't fix a platform bug, so their /ai page must not collect the
	 * reports. The GitHub URL deliberately differs from the one in
	 * /.well-known/security.txt: this page links the Security tab (a human
	 * picks their path from there), while security.txt carries the
	 * /security/advisories/new report form for tooling. Same channels,
	 * different entry points.
	 */
	security: AiDisclosureSecurity;
	/** Muted closing line. */
	closer: string;
}

export function defaultAiDisclosure(): AiDisclosure {
	return {
		intro: "This site runs on Sona, which is built with AI coding tools. Here's what that means.",
		topics: [
			{
				lead: 'The software.',
				body: "Sona is made by the Sona Team, not by the person who runs this site. Most of its code is written by Claude Code, an AI coding agent, working from their designs and decisions. They review and approve every change, and every deploy happens because a person pressed the button. The longer version, including how changes are tested and reviewed, is in the AI_POLICY.md file that ships with this site's source."
			},
			{
				lead: 'The words.',
				body: 'Most of the wording built into Sona, including this page, was drafted with AI and edited by the Sona Team. Anything written for this site in particular is by whoever runs it.'
			},
			{
				lead: 'The art.',
				body: "None of it is AI-generated. Everything in the gallery is commissioned from human artists and credited. Fursuit photos are by human photographers, artist profile pictures come from the artists' own accounts, and some VR avatars use purchased base models. I don't commission or post AI art."
			},
			{
				lead: 'Your data.',
				body: "The running site never calls an AI service, so nothing you do is sent to one as you browse. When the software is being worked on, the developer's tools can read this site's logs and database, as any developer's could, and those logs can include visitors' IP addresses and the pages they requested. Code goes to Anthropic and to CodeRabbit, a review service. Model training is switched off on the accounts used, and CodeRabbit states that the data from its reviews is never used for training. The privacy policy has the details."
			},
			{
				lead: 'The model.',
				body: "Claude is trained on scraped text and code. That data isn't Sona's, and nobody here can vouch for how it was gathered."
			}
		],
		security: {
			lead: 'Security problems.',
			body: [
				'If you find a vulnerability, report it privately, either ',
				{
					text: 'through GitHub',
					href: 'https://github.com/sona-fast/sona/security',
					ariaLabel: 'Report a vulnerability through GitHub'
				},
				' or by email to ',
				{ text: 'security@sona.fast', href: 'mailto:security@sona.fast' },
				'. Every Sona site runs this same code, so posting details publicly exposes all of them before a fix exists.'
			]
		},
		closer:
			'If any of this changes, this page changes with it. When the footer shows a build number, it links to the source this exact build came from.'
	};
}
