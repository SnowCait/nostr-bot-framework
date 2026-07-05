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
			// Escape hatch: build the kind 1 event freely.
			build: (item) => {
				const { title, link } = item.data as { title: string; link: string };
				return buildTextNote({
					content: `${title}\n${link}`,
					tags: [['t', 'news']],
				});
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
