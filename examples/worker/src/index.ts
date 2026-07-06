import { defineBot, rssSource } from '@sns-bot-framework/core';
import { buildTextNote, nostrDestination } from '@sns-bot-framework/nostr';
import { createWorker, d1PhraseSource } from '@sns-bot-framework/cloudflare';
import { FEEDS, RELAYS } from './config.js';

// RSS bot: feeds are defined in config.ts, posts up to 3 new items per run.
const rssBot = defineBot({
	id: 'rss-news',
	cron: '*/30 * * * *',
	source: rssSource({ feeds: FEEDS }),
	maxPerRun: 3,
	destinations: [
		nostrDestination({
			relays: RELAYS,
			// Escape hatch: build the kind 1 event freely. ctx.env exposes the
			// Worker bindings, so app-owned D1 tables can drive the post.
			build: async (item, ctx) => {
				const env = ctx.env as Env;
				const { title, link } = item.data as { title: string; link: string };
				const tags: string[][] = [['t', 'news']];
				// App-owned table (migrations/1001_app.sql); framework tables are internal.
				const host = link ? new URL(link).host : '';
				if (host) {
					const row = await env.DB.prepare('SELECT hashtag FROM feed_hashtags WHERE host = ?')
						.bind(host)
						.first<{ hashtag: string }>();
					if (row) tags.push(['t', row.hashtag]);
				}
				return buildTextNote({ content: `${title}\n${link}`, tags });
			},
		}),
	],
});

// Phrase bot: phrases live in D1 and are editable from /admin.
const quoteBot = defineBot({
	id: 'quotes',
	cron: '0 * * * *',
	source: d1PhraseSource(),
	repeat: true,
	selection: 'random',
	destinations: [nostrDestination({ relays: RELAYS })],
});

export default createWorker({ bots: [rssBot, quoteBot] });
