import { defineBot, rssSource } from '@sns-bot-framework/core';
import { buildTextNote, nostrDestination } from '@sns-bot-framework/nostr';
import { createWorker, d1PhraseSource } from '@sns-bot-framework/cloudflare';
import { FEEDS, RELAYS } from './config.js';

// Worker bindings available inside build hooks via ctx.env.
interface Env {
	DB: D1Database;
	MEDIA?: R2Bucket;
}

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
			// Worker bindings, so R2/D1/etc. can drive non-standard posts.
			build: (item, ctx) => {
				const env = ctx.env as Env;
				const { title, link } = item.data as { title: string; link: string };
				const tags: string[][] = [['t', 'news']];
				if (env.MEDIA) {
					// e.g. upload an image to R2 and attach a NIP-92 imeta tag here.
					tags.push(['t', 'media']);
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
