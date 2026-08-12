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

export interface AiDisclosure {
	intro: string;
	topics: AiDisclosureTopic[];
	/** Muted closing line. */
	closer: string;
}

export function defaultAiDisclosure(): AiDisclosure {
	return {
		intro: "This site is built and written with AI. Here's what that means.",
		topics: [
			{
				lead: 'The code.',
				body: 'Most of it is written by Claude Code, an AI coding agent, working from my designs and decisions. I review and approve every change, and every deploy happens because I pressed the button. The longer version, including how changes are tested and reviewed, is in AI_POLICY.md in the public repo.'
			},
			{
				lead: 'The text.',
				body: 'Most of the words on this site, including this page, were drafted with AI and edited and approved by me.'
			},
			{
				lead: 'The art.',
				body: "None of it is AI-generated. Everything in the gallery is commissioned from human artists and credited. Fursuit photos are by human photographers, artist profile pictures come from the artists' own accounts, and some VR avatars use purchased base models. I don't commission or post AI art."
			},
			{
				lead: 'Your data.',
				body: "The running site never calls an AI service. Nothing you do here is sent to one, and nothing here is used to train one. While developing, my tools can read the site's logs and database the way any developer would, and code goes to Anthropic and to CodeRabbit, a review service. The privacy policy has the details."
			},
			{
				lead: 'The model.',
				body: "Claude is trained on scraped text and code. That data isn't mine and I can't vouch for how it was gathered."
			}
		],
		closer:
			'If any of this changes, this page changes with it. The source for this exact build is linked in the footer.'
	};
}
