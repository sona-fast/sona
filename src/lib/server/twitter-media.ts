// Resolve the first photo attached to a public tweet, using the same guest-token
// flow as twitter-avatar.ts. The query id and the `features` map below are
// UNDOCUMENTED and rotate — both were lifted from FxEmbed's source
// (packages/atmosphere/src/providers/twitter/graphql/{queries,features}.ts,
// `TweetResultByRestIdQuery` plus its `rwebTweetFeatureKeys`) and verified
// against a real public tweet on 2026-09-08 (activate 200, GraphQL 200, photo
// present). If resolution goes uniformly null, refresh them from FxEmbed.
//
// Fail-soft throughout: any error resolves to null and the caller proceeds
// without a media URL. Videos and GIFs are skipped — only photos resolve.

import { X_BEARER, activateGuestToken } from './twitter-avatar';

const X_TWEET_BY_REST_ID = 'https://api.x.com/graphql/f2sagi1jweVHFkTUIHzmMQ/TweetResultByRestId';
const FETCH_TIMEOUT_MS = 5000;

const QUERY_FEATURES = {
	rweb_video_screen_enabled: false,
	profile_label_improvements_pcf_label_in_post_enabled: true,
	responsive_web_profile_redirect_enabled: false,
	rweb_tipjar_consumption_enabled: false,
	verified_phone_label_enabled: false,
	creator_subscriptions_tweet_preview_api_enabled: true,
	responsive_web_graphql_timeline_navigation_enabled: true,
	responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
	premium_content_api_read_enabled: false,
	communities_web_enable_tweet_community_results_fetch: true,
	c9s_tweet_anatomy_moderator_badge_enabled: true,
	responsive_web_grok_analyze_button_fetch_trends_enabled: false,
	responsive_web_grok_analyze_post_followups_enabled: true,
	responsive_web_jetfuel_frame: true,
	responsive_web_grok_share_attachment_enabled: true,
	responsive_web_grok_annotations_enabled: true,
	articles_preview_enabled: true,
	responsive_web_edit_tweet_api_enabled: true,
	graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
	view_counts_everywhere_api_enabled: true,
	longform_notetweets_consumption_enabled: true,
	responsive_web_twitter_article_tweet_consumption_enabled: true,
	content_disclosure_indicator_enabled: true,
	content_disclosure_ai_generated_indicator_enabled: true,
	responsive_web_grok_show_grok_translated_post: true,
	responsive_web_grok_analysis_button_from_backend: true,
	post_ctas_fetch_enabled: true,
	freedom_of_speech_not_reach_fetch_enabled: true,
	standardized_nudges_misinfo: true,
	tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
	longform_notetweets_rich_text_read_enabled: true,
	longform_notetweets_inline_media_enabled: true,
	responsive_web_grok_image_annotation_enabled: true,
	responsive_web_grok_imagine_annotation_enabled: true,
	responsive_web_grok_community_note_auto_translation_is_enabled: true,
	responsive_web_enhance_cards_enabled: false,
	tweet_awards_web_tipping_enabled: false
} as const;

const QUERY_FIELD_TOGGLES = {
	withArticleRichContentState: true,
	withArticlePlainText: false,
	withGrokAnalyze: false,
	withDisallowedReplyControls: false
} as const;

/** Pull the numeric status id out of any of the tweet URL shapes we accept
 * ("x.com/user/status/1", "twitter.com/i/status/1", ".../status/1/photo/1"). */
export function tweetIdFromUrl(url: string): string | null {
	const match = url
		.trim()
		.match(/(?:^|\/\/|\.)(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i\/web|i)\/status(?:es)?\/(\d{1,20})(?:[/?#]|$)/i);
	return match ? match[1] : null;
}

type TweetMedia = { type?: unknown; media_url_https?: unknown };

/**
 * Extract the first photo from a TweetResultByRestId response and ask
 * pbs.twimg.com for its largest variant. Returns null for a tweet with no
 * photo (video- and GIF-only tweets included). Pure, so it's testable.
 */
export function parseTweetPhotoUrl(body: unknown): string | null {
	const result = (body as { data?: { tweetResult?: { result?: Record<string, unknown> } } })?.data
		?.tweetResult?.result;
	if (!result) return null;
	// A tweet behind a visibility interstitial nests the real tweet one level down.
	const tweet = (result.tweet as Record<string, unknown> | undefined) ?? result;
	const legacy = tweet.legacy as
		| { extended_entities?: { media?: unknown }; entities?: { media?: unknown } }
		| undefined;
	const media = legacy?.extended_entities?.media ?? legacy?.entities?.media;
	if (!Array.isArray(media)) return null;

	for (const entry of media as TweetMedia[]) {
		if (entry?.type !== 'photo') continue;
		const url = entry.media_url_https;
		if (typeof url !== 'string' || !url) continue;
		const match = url.match(/^(.*)\.([a-z]+)$/i);
		if (!match) return url;
		return `${match[1]}?format=${match[2].toLowerCase()}&name=4096x4096`;
	}
	return null;
}

function tweetLookup(tweetId: string, guestToken: string, fetchImpl: typeof fetch): Promise<Response> {
	const csrf = [...crypto.getRandomValues(new Uint8Array(16))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	const variables = encodeURIComponent(
		JSON.stringify({
			tweetId,
			withCommunity: false,
			includePromotedContent: false,
			withVoice: false
		})
	);
	const features = encodeURIComponent(JSON.stringify(QUERY_FEATURES));
	const fieldToggles = encodeURIComponent(JSON.stringify(QUERY_FIELD_TOGGLES));
	return fetchImpl(
		`${X_TWEET_BY_REST_ID}?variables=${variables}&features=${features}&fieldToggles=${fieldToggles}`,
		{
			headers: {
				Authorization: X_BEARER,
				'x-guest-token': guestToken,
				'x-csrf-token': csrf,
				'x-twitter-active-user': 'yes',
				Cookie: `guest_id=v1%3A${guestToken}; ct0=${csrf};`
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		}
	);
}

/** Resolve the first photo on a public tweet to a pbs.twimg.com URL. One guest
 * token, one fresh-token retry if X refuses it (401/429), then null. Never throws. */
export async function fetchTweetMediaUrl(
	tweetUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> {
	const tweetId = tweetIdFromUrl(tweetUrl);
	if (!tweetId) return null;
	try {
		let token = await activateGuestToken(fetchImpl);
		if (!token) return null;
		let res = await tweetLookup(tweetId, token, fetchImpl);
		if (res.status === 401 || res.status === 429) {
			token = await activateGuestToken(fetchImpl);
			if (!token) return null;
			res = await tweetLookup(tweetId, token, fetchImpl);
		}
		if (!res.ok) {
			console.warn(`[avatar] tweet media lookup failed: status=${res.status}`);
			return null;
		}
		const photo = parseTweetPhotoUrl(await res.json());
		if (!photo) {
			// 200 but no photo — a text/video tweet, a protected or deleted one, or
			// the undocumented GraphQL shape rotated (see the file header).
			console.warn('[avatar] tweet media lookup had no photo');
			return null;
		}
		return photo;
	} catch (e) {
		console.warn(`[avatar] tweet media lookup error: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}
