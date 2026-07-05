# sns-bot-framework

日本語版は [README.ja.md](./README.ja.md) を参照してください。

A bot framework for [Nostr](https://nostr.com/) (and, by design, other social networks later), built to run on Cloudflare Workers. Bots fetch items from sources (RSS feeds, phrase lists), turn them into events, and publish them to relays on Cron Triggers — with deduplication, retries, an admin UI, and encrypted key storage out of the box.

## Packages

| Package                         | Description                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sns-bot-framework/core`       | Platform-agnostic pipeline: sources (RSS / phrase list), dedup state, the `Destination` interface, and the bot runner. No Nostr dependency. |
| `@sns-bot-framework/nostr`      | The Nostr destination: kind 1/0/10002 builders, NIP-10 reply tags, signing, relay/webhook publishing, NIP-98 verification.                  |
| `@sns-bot-framework/cloudflare` | Cloudflare adapter: D1 stores, AES-GCM encrypted key storage, admin UI (Hono), `createWorker()`.                                            |

## Features

- **Sources**: RSS 2.0 / Atom / RSS 1.0 (with ETag caching) and phrase lists, defined in code or stored in D1 and editable from the admin UI
- **Deduplication per destination**: an item posted to one destination but failed on another is retried only where it failed; RSS bots skip pre-existing items on their first run instead of flooding
- **Escape hatch**: `nostrDestination({ build })` lets you construct kind 1 events freely (tags, threads, R2 image URLs via `ctx.env`, skipping items)
- **Multiple bots per Worker**, each with its own cron schedule and its own key (or a shared key)
- **Admin UI** at `/admin`: edit feeds/phrases (D1), register bot keys, edit kind 0 profile and kind 10002 relay list, run bots manually — authenticated with [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) via a NIP-07 browser extension
- **Encrypted key storage**: bot secret keys are AES-GCM encrypted with a single master key and stored in D1; adding a bot key never requires a config change or redeploy
- **Dry-run mode** (`DRY_RUN=1` or the admin UI checkbox): sign and log events without sending

## Quick start

Requires Node.js 24+. Start from [`examples/worker`](./examples/worker):

```sh
git clone https://github.com/SnowCait/nostr-bot-framework.git
cd nostr-bot-framework && npm install && npm run build
cd examples/worker

# 1. Create the database and apply the framework's migrations
npx wrangler d1 create nostr-bot        # put the id into wrangler.jsonc
npm run migrate:remote                  # syncs bundled migrations, then applies them

# 2. Register the production master key (generate & save one in your password manager first)
npm run setup:master-key:remote         # or: npm run setup:master-key:remote -- --generate

# 3. Allow your own pubkey to use the admin UI
#    -> set ADMIN_PUBKEYS (npub or hex, comma-separated) in wrangler.jsonc vars

# 4. Deploy
npm run deploy
```

The schema lives in `@sns-bot-framework/cloudflare`. `migrate:*` first runs `sns-bot-migrations`, which copies the framework's migration files into `./migrations` (existing files are never overwritten), then hands off to `wrangler d1 migrations apply`. Migration numbers `0001–` are reserved by the framework; number your own app tables from `1001` upward.

Then open `https://<your-worker>.workers.dev/admin`, sign in with a NIP-07 extension (nos2x, Alby, …), and register each bot's key (`nsec1...` or hex). Keys are write-only: the UI only ever shows the derived npub.

## Defining bots

```ts
import { defineBot, rssSource } from '@sns-bot-framework/core';
import { buildTextNote, nostrDestination } from '@sns-bot-framework/nostr';
import { createWorker, d1PhraseSource } from '@sns-bot-framework/cloudflare';

const rssBot = defineBot({
	id: 'rss-news',
	cron: '*/30 * * * *',
	source: rssSource({ feeds: ['https://example.com/feed.xml'] }),
	maxPerRun: 3,
	destinations: [
		nostrDestination({
			relays: ['wss://relay.damus.io', 'wss://nos.lol'],
			build: (item) => {
				const { title, link } = item.data as { title: string; link: string };
				return buildTextNote({ content: `${title}\n${link}`, tags: [['t', 'news']] });
			},
		}),
	],
});

const quoteBot = defineBot({
	id: 'quotes',
	cron: '0 * * * *',
	source: d1PhraseSource(), // phrases live in D1, editable from /admin
	repeat: true, // start over once every phrase has been posted
	selection: 'random',
	destinations: [nostrDestination({ relays: ['wss://relay.damus.io'] })],
});

export default createWorker({ bots: [rssBot, quoteBot] });
```

A bot can also fan out to multiple destinations at once; dedup state and credentials are tracked per `(bot, destination)`.

## Manual runs

Besides the admin UI button, the run endpoint accepts a bearer token for scripting:

```sh
npx wrangler secret put MANUAL_TRIGGER_TOKEN
curl -X POST "https://<your-worker>.workers.dev/admin/api/bots/rss-news/run?dryRun=1" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN"
```

## Local development

```sh
cd examples/worker
npm run setup:master-key:local   # writes a separate random key to .dev.vars
npm run migrate:local            # syncs migrations, then applies them to the local D1
npm run dev                      # wrangler dev --test-scheduled

# fire a cron trigger locally
curl "http://localhost:8787/__scheduled?cron=*%2F30+*+*+*+*"
```

`setup:master-key:local` only touches `.dev.vars` (never production); `setup:master-key:remote` registers the production secret via `wrangler secret put`. Set `DRY_RUN=1` in `.dev.vars` to log events instead of publishing while developing.

### Using the framework as a library

If you build your own Worker instead of copying the example, pull the schema in the same way:

```sh
npx sns-bot-migrations                                    # copies migrations into ./migrations
npx wrangler d1 migrations apply <DB_NAME> --remote
npx sns-bot-setup-master-key --remote                     # or --local for .dev.vars
```

## Key management and recovery

- The only secret on the platform is `MASTER_KEY` (a Workers Secret). Use any high-entropy string — generate it in your password manager so a backup exists by construction; the Worker derives an AES-256 key from it via SHA-256.
- Bot keys are encrypted with the master key and stored in D1, keyed by pubkey — registering the same key for several bots stores it once.
- **If the master key is lost**: re-set it with `wrangler secret put MASTER_KEY` if you have the backup (D1 is untouched). Without a backup the ciphertexts are unrecoverable — set a new master key and re-register each bot's nsec from the admin UI (the UI flags affected bots). Published posts, dedup state, and profiles are stored in plaintext or as public data and survive intact.
- The kind 0 profile and kind 10002 relay list are canonical in D1 and only pushed to relays. Edits made from other Nostr clients are not read back and will be overwritten on the next publish — edit bot profiles from the admin UI only.

## Using Cloudflare Secrets Store instead

The master key helper also accepts a [Secrets Store](https://developers.cloudflare.com/secrets-store/) binding (it detects a `get()` method at runtime):

```jsonc
// wrangler.jsonc
"secrets_store_secrets": [
	{ "binding": "MASTER_KEY", "store_id": "<STORE_ID>", "secret_name": "bot-master-key" }
]
```

## License

MIT
