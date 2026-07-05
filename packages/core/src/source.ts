import { parseFeed, type FeedItem } from './rss.js';
import { renderTemplate } from './template.js';
import type { BotContext, Source, SourceItem } from './types.js';

export interface Phrase {
	id?: string;
	content: string;
}

function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A phrase list defined in code. Item ids derive from content hashes,
 * so reordering is safe while editing a phrase makes it a new item.
 */
export function staticListSource(phrases: readonly (string | Phrase)[]): Source {
	const items: SourceItem[] = phrases.map((phrase) => {
		const { id, content } =
			typeof phrase === 'string' ? { id: undefined, content: phrase } : phrase;
		return { id: id ?? `p${fnv1a(content)}`, content };
	});
	return {
		backfill: 'post',
		async fetch(): Promise<SourceItem[]> {
			return items;
		},
	};
}

export interface RssSourceOptions {
	feeds: readonly string[] | ((ctx: BotContext) => Promise<readonly string[]>);
	/** Template for the default post text. Default: '{title}\n{link}'. */
	template?: string;
	timeoutMs?: number;
	/** Max items kept per feed for the 304-cache. Default: 100. */
	cacheLimit?: number;
}

interface CachedFeed {
	etag?: string;
	lastModified?: string;
	items: FeedItem[];
}

async function fetchFeed(
	ctx: BotContext,
	url: string,
	timeoutMs: number,
	cacheLimit: number,
): Promise<FeedItem[]> {
	const cacheKey = `rss:${url}`;
	const cachedRaw = await ctx.state.get(ctx.botId, cacheKey);
	const cached: CachedFeed | null = cachedRaw ? JSON.parse(cachedRaw) : null;

	const headers = new Headers({ accept: 'application/rss+xml, application/atom+xml, text/xml' });
	if (cached?.etag) headers.set('if-none-match', cached.etag);
	if (cached?.lastModified) headers.set('if-modified-since', cached.lastModified);

	const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	if (response.status === 304 && cached) {
		return cached.items;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch feed ${url}: HTTP ${response.status}`);
	}

	const items = parseFeed(await response.text());
	const next: CachedFeed = { items: items.slice(0, cacheLimit) };
	const etag = response.headers.get('etag');
	const lastModified = response.headers.get('last-modified');
	if (etag) next.etag = etag;
	if (lastModified) next.lastModified = lastModified;
	await ctx.state.set(ctx.botId, cacheKey, JSON.stringify(next));
	return items;
}

/**
 * RSS 2.0 / Atom / RSS 1.0 source. Uses conditional GET (ETag/Last-Modified)
 * and caches the last parsed items so unposted backlog survives 304 responses.
 * Items are ordered oldest first.
 */
export function rssSource(options: RssSourceOptions): Source {
	const template = options.template ?? '{title}\n{link}';
	const timeoutMs = options.timeoutMs ?? 10_000;
	const cacheLimit = options.cacheLimit ?? 100;
	return {
		backfill: 'skip',
		async fetch(ctx: BotContext): Promise<SourceItem[]> {
			const feeds = typeof options.feeds === 'function' ? await options.feeds(ctx) : options.feeds;
			const results = await Promise.allSettled(
				feeds.map((url) => fetchFeed(ctx, url, timeoutMs, cacheLimit)),
			);
			const items: (FeedItem & { feedUrl: string })[] = [];
			results.forEach((result, index) => {
				const feedUrl = feeds[index]!;
				if (result.status === 'fulfilled') {
					items.push(...result.value.map((item) => ({ ...item, feedUrl })));
				} else {
					ctx.log(`feed fetch failed: ${feedUrl}`, String(result.reason));
				}
			});
			items.sort((a, b) => (a.publishedAt ?? Infinity) - (b.publishedAt ?? Infinity));
			return items.map((item) => ({
				id: item.id,
				content: renderTemplate(template, {
					title: item.title,
					link: item.link,
					summary: item.summary,
				}),
				data: item,
			}));
		},
	};
}
