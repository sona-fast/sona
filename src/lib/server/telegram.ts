// Server-only Telegram Bot API client for the sticker importer. Runs on the
// Cloudflare Worker (the token is a server secret and must never reach the
// browser). Mirrors the FurTrack client's posture: the feature stays dark until
// TELEGRAM_BOT_TOKEN is configured — without it, isTelegramEnabled() is false and
// the admin import UI is hidden; the manual upload path works regardless.
//
// We use exactly two Bot API methods: getStickerSet (the set + every sticker's
// emoji) and getFile (resolve a file_id to a downloadable path). Images are then
// fetched from the file CDN and self-hosted, so there are no Telegram calls at
// public request time.

import { bufferStream } from './storage/buffer';

const API_BASE = 'https://api.telegram.org';
/** Per-request timeout so a slow/hanging Telegram can't tie up the worker. */
const FETCH_TIMEOUT_MS = 8000;

type Env = { TELEGRAM_BOT_TOKEN?: string };

/** True when the Bot API token is configured — gates the whole import feature. */
export function isTelegramEnabled(env: Env | undefined): boolean {
	return !!env?.TELEGRAM_BOT_TOKEN;
}

export type StickerFormat = 'png' | 'webp' | 'animated' | 'video';

/** One sticker as returned by getStickerSet, normalized to what the importer needs. */
export interface TelegramSticker {
	fileId: string;
	fileUniqueId: string;
	emoji: string | null;
	format: StickerFormat;
	width: number | null;
	height: number | null;
}

export interface TelegramStickerSet {
	name: string;
	title: string;
	stickers: TelegramSticker[];
}

/**
 * Extract the set name from whatever the admin pastes:
 *   https://t.me/addstickers/Foo  ·  t.me/addstickers/Foo  ·  Foo
 * Telegram set names are [A-Za-z0-9_]. Returns null for anything else — including
 * other URLs/hosts, so a pasted `https://example.com/` can't be coerced into a
 * bogus set name ("com") and sent to the Bot API.
 */
export function parseStickerSetName(input: string): string | null {
	const trimmed = input.trim();
	// A t.me link must be the addstickers path form.
	const tme = /t\.me\/addstickers\/([A-Za-z0-9_]+)\/?$/.exec(trimmed);
	if (tme) return tme[1];
	// Anything else containing a scheme, host dot, or slash is not a sticker link.
	if (/[./:]/.test(trimmed)) return null;
	// Otherwise treat the whole input as a bare set name.
	return /^[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : null;
}

/** The public t.me link for a set name (stored as the pack's telegramUrl). */
export function stickerSetUrl(name: string): string {
	return `https://t.me/addstickers/${name}`;
}

/**
 * The real media type of a sticker file, derived from its file_path extension.
 * Telegram's file CDN serves stickers as `application/octet-stream` regardless of
 * format, so we CANNOT trust the response content-type — the extension is reliable
 * (e.g. stickers/file_0.webp). `.tgs` is gzipped Lottie (handled separately).
 */
export function stickerMediaType(filePath: string): string {
	const ext = filePath.toLowerCase().split('.').pop();
	switch (ext) {
		case 'webp':
			return 'image/webp';
		case 'png':
			return 'image/png';
		case 'webm':
			return 'video/webm';
		case 'gif':
			return 'image/gif';
		case 'tgs':
			return 'application/gzip';
		default:
			return 'application/octet-stream';
	}
}

function formatOf(s: { is_animated?: boolean; is_video?: boolean }): StickerFormat {
	if (s.is_video) return 'video';
	if (s.is_animated) return 'animated';
	// Telegram static stickers are WebP. (Older sets can be PNG; the import
	// pipeline re-derives the real format from the downloaded content-type.)
	return 'webp';
}

async function apiCall<T>(token: string, method: string, params: Record<string, string>): Promise<T> {
	const qs = new URLSearchParams(params).toString();
	const res = await fetch(`${API_BASE}/bot${token}/${method}?${qs}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
	if (!body.ok || body.result === undefined) {
		throw new Error(body.description || `Telegram ${method} failed (${res.status})`);
	}
	return body.result;
}

interface RawSticker {
	file_id: string;
	file_unique_id: string;
	emoji?: string;
	is_animated?: boolean;
	is_video?: boolean;
	width?: number;
	height?: number;
}

/**
 * Fetch a sticker set by name. Throws on a network error, timeout, or an unknown
 * set (the caller maps that to the "couldn't reach Telegram / not found" state).
 */
export async function getStickerSet(env: Env | undefined, nameOrUrl: string): Promise<TelegramStickerSet> {
	const token = env?.TELEGRAM_BOT_TOKEN;
	if (!token) throw new Error('Telegram import is not configured (no bot token).');
	const name = parseStickerSetName(nameOrUrl);
	if (!name) throw new Error('That doesn’t look like a Telegram sticker link.');

	const result = await apiCall<{ name: string; title: string; stickers: RawSticker[] }>(
		token,
		'getStickerSet',
		{ name }
	);

	return {
		name: result.name,
		title: result.title,
		stickers: result.stickers.map((s) => ({
			fileId: s.file_id,
			fileUniqueId: s.file_unique_id,
			emoji: s.emoji ?? null,
			format: formatOf(s),
			width: s.width ?? null,
			height: s.height ?? null
		}))
	};
}

/**
 * Resolve a file_id to raw bytes + content-type via getFile + the file CDN.
 * For animated (.tgs) stickers the bytes are gzipped Lottie; callers decompress.
 */
export async function downloadFile(
	env: Env | undefined,
	fileId: string
): Promise<{ bytes: ArrayBuffer; contentType: string; filePath: string }> {
	const token = env?.TELEGRAM_BOT_TOKEN;
	if (!token) throw new Error('Telegram import is not configured (no bot token).');

	const file = await apiCall<{ file_path?: string }>(token, 'getFile', { file_id: fileId });
	if (!file.file_path) throw new Error('Telegram returned no file path.');

	const res = await fetch(`${API_BASE}/file/bot${token}/${file.file_path}`, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok || !res.body) throw new Error(`Telegram file download failed (${res.status}).`);
	// Byte-cap the buffered download (M8) so an oversized file CDN response can't
	// OOM the isolate. .buffer is exact — bufferStream allocates to the byte total.
	const bytes = await bufferStream(res.body);
	return {
		bytes: bytes.buffer as ArrayBuffer,
		contentType: res.headers.get('content-type') ?? 'application/octet-stream',
		filePath: file.file_path
	};
}
