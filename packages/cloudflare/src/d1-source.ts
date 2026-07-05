import type { BotContext, Source, SourceItem } from '@sns-bot-framework/core';

export interface D1SourceOptions {
	/** Name of the D1 binding on env. Default: 'DB'. */
	binding?: string;
}

function resolveDb(env: unknown, binding: string): D1Database {
	const db = (env as Record<string, unknown> | undefined)?.[binding];
	if (!db) {
		throw new Error(`D1 binding "${binding}" not found on env`);
	}
	return db as D1Database;
}

/** Phrases managed in the D1 `phrases` table (editable from the admin UI). */
export function d1PhraseSource(options: D1SourceOptions = {}): Source {
	const binding = options.binding ?? 'DB';
	return {
		backfill: 'post',
		async fetch(ctx: BotContext): Promise<SourceItem[]> {
			const { results } = await resolveDb(ctx.env, binding)
				.prepare('SELECT id, content FROM phrases WHERE bot_id = ? AND enabled = 1 ORDER BY id')
				.bind(ctx.botId)
				.all<{ id: number; content: string }>();
			return results.map((row) => ({ id: `p${row.id}`, content: row.content }));
		},
	};
}

/** Feed URLs managed in the D1 `feeds` table, for rssSource({ feeds: d1FeedList() }). */
export function d1FeedList(options: D1SourceOptions = {}): (ctx: BotContext) => Promise<string[]> {
	const binding = options.binding ?? 'DB';
	return async (ctx: BotContext) => {
		const { results } = await resolveDb(ctx.env, binding)
			.prepare('SELECT url FROM feeds WHERE bot_id = ? AND enabled = 1 ORDER BY id')
			.bind(ctx.botId)
			.all<{ url: string }>();
		return results.map((row) => row.url);
	};
}
