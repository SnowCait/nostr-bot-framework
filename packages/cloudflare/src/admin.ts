import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
	runBot,
	type BotDefinition,
	type Destination,
	type PublishResult,
} from '@sns-bot-framework/core';
import {
	buildMetadata,
	buildRelayList,
	PrivateKeySigner,
	publishToRelays,
	type NostrDestination,
	type RelayListEntry,
} from '@sns-bot-framework/nostr';
import type { NostrEvent } from 'nostr-tools/core';
import { ADMIN_PAGE } from './admin-page.js';
import type { MasterKeySource } from './crypto.js';
import { D1StateStore } from './d1-state-store.js';
import { D1NostrEventStore, D1NostrKeyStore } from './nostr-store.js';
import type { AdminAuthVariables } from './nip98.js';

export interface AdminAppOptions {
	bots: readonly BotDefinition[];
	auth: MiddlewareHandler;
	/** Name of the D1 binding on env. Default: 'DB'. */
	dbBinding?: string;
	/** Resolves the master key from env. Default: env.MASTER_KEY. */
	masterKey?: (env: unknown) => MasterKeySource;
}

type Env = { Bindings: Record<string, unknown>; Variables: AdminAuthVariables };

interface RelayListJson {
	url: string;
	read?: boolean;
	write?: boolean;
}

function parseRelayTags(event: NostrEvent): RelayListJson[] {
	return event.tags
		.filter((tag) => tag[0] === 'r' && tag[1])
		.map((tag) => ({
			url: tag[1]!,
			read: tag[2] === undefined || tag[2] === 'read',
			write: tag[2] === undefined || tag[2] === 'write',
		}));
}

function isNostrDestination(destination: Destination): destination is NostrDestination {
	return destination.type === 'nostr';
}

export function createAdminApp(options: AdminAppOptions): Hono<Env> {
	const dbBinding = options.dbBinding ?? 'DB';
	const masterKeyOf =
		options.masterKey ??
		((env: unknown): MasterKeySource => {
			const value = (env as Record<string, MasterKeySource | undefined>).MASTER_KEY;
			if (!value) throw new Error('MASTER_KEY not found on env');
			return value;
		});

	const deps = (env: unknown) => {
		const db = (env as Record<string, unknown>)[dbBinding] as D1Database | undefined;
		if (!db) throw new Error(`D1 binding "${dbBinding}" not found on env`);
		return {
			db,
			state: new D1StateStore(db),
			keyStore: new D1NostrKeyStore(db, masterKeyOf(env)),
			eventStore: new D1NostrEventStore(db),
		};
	};

	const findBot = (botId: string): BotDefinition | undefined =>
		options.bots.find((bot) => bot.id === botId);
	const findDestination = (bot: BotDefinition, destId: string): Destination | undefined =>
		bot.destinations.find((destination) => destination.id === destId);

	const app = new Hono<Env>();

	app.get('/', (c) => c.html(ADMIN_PAGE));
	app.use('/api/*', options.auth);

	app.get('/api/bots', async (c) => {
		const { keyStore } = deps(c.env);
		const bots = await Promise.all(
			options.bots.map(async (bot) => ({
				id: bot.id,
				cron: bot.cron ?? null,
				destinations: await Promise.all(
					bot.destinations.map(async (destination) => ({
						id: destination.id,
						type: destination.type,
						credential:
							destination.type === 'nostr'
								? await keyStore.status(bot.id, destination.id)
								: { registered: false },
					})),
				),
			})),
		);
		return c.json({ bots });
	});

	app.get('/api/bots/:botId/feeds', async (c) => {
		const { db } = deps(c.env);
		if (!findBot(c.req.param('botId'))) return c.json({ error: 'Unknown bot' }, 404);
		const { results } = await db
			.prepare('SELECT id, url, enabled FROM feeds WHERE bot_id = ? ORDER BY id')
			.bind(c.req.param('botId'))
			.all<{ id: number; url: string; enabled: number }>();
		return c.json({ feeds: results.map((row) => ({ ...row, enabled: row.enabled === 1 })) });
	});

	app.put('/api/bots/:botId/feeds', async (c) => {
		const { db } = deps(c.env);
		const botId = c.req.param('botId');
		if (!findBot(botId)) return c.json({ error: 'Unknown bot' }, 404);
		const body = await c.req.json<{ feeds: { url: string; enabled?: boolean }[] }>();
		await syncRows(
			db,
			'feeds',
			'url',
			botId,
			body.feeds.map((f) => ({ value: f.url, enabled: f.enabled ?? true })),
		);
		return c.json({ ok: true });
	});

	app.get('/api/bots/:botId/phrases', async (c) => {
		const { db } = deps(c.env);
		if (!findBot(c.req.param('botId'))) return c.json({ error: 'Unknown bot' }, 404);
		const { results } = await db
			.prepare('SELECT id, content, enabled FROM phrases WHERE bot_id = ? ORDER BY id')
			.bind(c.req.param('botId'))
			.all<{ id: number; content: string; enabled: number }>();
		return c.json({ phrases: results.map((row) => ({ ...row, enabled: row.enabled === 1 })) });
	});

	app.put('/api/bots/:botId/phrases', async (c) => {
		const { db } = deps(c.env);
		const botId = c.req.param('botId');
		if (!findBot(botId)) return c.json({ error: 'Unknown bot' }, 404);
		const body = await c.req.json<{ phrases: { content: string; enabled?: boolean }[] }>();
		await syncRows(
			db,
			'phrases',
			'content',
			botId,
			body.phrases.map((p) => ({ value: p.content, enabled: p.enabled ?? true })),
		);
		return c.json({ ok: true });
	});

	app.put('/api/bots/:botId/destinations/:destId/credential', async (c) => {
		const { keyStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		const destination = findDestination(bot, c.req.param('destId'));
		if (!destination) return c.json({ error: 'Unknown destination' }, 404);
		if (destination.type !== 'nostr') {
			return c.json(
				{ error: `Credential registration not supported for type "${destination.type}"` },
				400,
			);
		}
		const body = await c.req.json<{ key?: string }>();
		if (!body.key) return c.json({ error: 'Missing "key"' }, 400);
		try {
			const info = await keyStore.register(bot.id, destination.id, body.key);
			return c.json(info);
		} catch (error) {
			return c.json({ error: String(error) }, 400);
		}
	});

	app.delete('/api/bots/:botId/destinations/:destId/credential', async (c) => {
		const { keyStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		await keyStore.remove(bot.id, c.req.param('destId'));
		return c.json({ ok: true });
	});

	app.get('/api/bots/:botId/destinations/:destId/profile', async (c) => {
		const { keyStore, eventStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		const pubkey = await keyStore.pubkeyFor(bot.id, c.req.param('destId'));
		if (!pubkey) return c.json({ profile: null, relays: null, published: {}, pubkey: null });
		const [kind0, kind10002] = await Promise.all([
			eventStore.get(pubkey, 0),
			eventStore.get(pubkey, 10002),
		]);
		return c.json({
			pubkey,
			profile: kind0 ? JSON.parse(kind0.event.content) : null,
			relays: kind10002 ? parseRelayTags(kind10002.event) : null,
			published: {
				profile: kind0 ? kind0.publishedAt : undefined,
				relays: kind10002 ? kind10002.publishedAt : undefined,
			},
		});
	});

	app.put('/api/bots/:botId/destinations/:destId/profile', async (c) => {
		const { keyStore, eventStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		const destination = findDestination(bot, c.req.param('destId'));
		if (!destination || !isNostrDestination(destination)) {
			return c.json({ error: 'Not a Nostr destination' }, 400);
		}
		const secret = await keyStore.resolveSecret(bot.id, destination.id);
		if (!secret) return c.json({ error: 'Register a key first' }, 400);
		const body = await c.req.json<{
			profile?: Record<string, unknown>;
			relays?: RelayListEntry[];
		}>();
		const signer = new PrivateKeySigner(secret);

		const results: Record<string, PublishResult[]> = {};
		const publishStored = async (label: string, event: NostrEvent) => {
			await eventStore.save(event);
			const published = await publishToRelays(event, destination.relays);
			if (published.some((result) => result.ok)) {
				await eventStore.markPublished(event.pubkey, event.kind);
			}
			results[label] = published;
		};
		if (body.profile !== undefined) {
			await publishStored('profile', await signer.signEvent(buildMetadata(body.profile)));
		}
		if (body.relays !== undefined) {
			await publishStored('relays', await signer.signEvent(buildRelayList(body.relays)));
		}
		return c.json({ results });
	});

	app.post('/api/bots/:botId/destinations/:destId/profile/republish', async (c) => {
		const { keyStore, eventStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		const destination = findDestination(bot, c.req.param('destId'));
		if (!destination || !isNostrDestination(destination)) {
			return c.json({ error: 'Not a Nostr destination' }, 400);
		}
		const pubkey = await keyStore.pubkeyFor(bot.id, destination.id);
		if (!pubkey) return c.json({ error: 'Register a key first' }, 400);
		const body = await c.req.json<{ kinds?: number[] }>().catch(() => ({}) as { kinds?: number[] });
		const kinds = body.kinds ?? [0, 10002];
		const results: Record<string, PublishResult[]> = {};
		for (const kind of kinds) {
			const stored = await eventStore.get(pubkey, kind);
			if (!stored) continue;
			const published = await publishToRelays(stored.event, destination.relays);
			if (published.some((result) => result.ok)) {
				await eventStore.markPublished(pubkey, kind);
			}
			results[String(kind)] = published;
		}
		return c.json({ results });
	});

	app.post('/api/bots/:botId/run', async (c) => {
		const { state, keyStore } = deps(c.env);
		const bot = findBot(c.req.param('botId'));
		if (!bot) return c.json({ error: 'Unknown bot' }, 404);
		const env = c.env as Record<string, unknown>;
		const report = await runBot(bot, {
			state,
			env,
			credentials: keyStore.credentialResolver(),
			dryRun: c.req.query('dryRun') === '1' || env.DRY_RUN === '1',
		});
		return c.json(report);
	});

	return app;
}

async function syncRows(
	db: D1Database,
	table: 'feeds' | 'phrases',
	column: 'url' | 'content',
	botId: string,
	desired: { value: string; enabled: boolean }[],
): Promise<void> {
	// Diff by value so existing row ids (and published_items references) stay stable.
	const { results } = await db
		.prepare(`SELECT id, ${column} AS value, enabled FROM ${table} WHERE bot_id = ?`)
		.bind(botId)
		.all<{ id: number; value: string; enabled: number }>();
	const existing = new Map(results.map((row) => [row.value, row]));
	const wanted = new Map(desired.map((row) => [row.value, row]));

	const statements: D1PreparedStatement[] = [];
	for (const row of results) {
		if (!wanted.has(row.value)) {
			statements.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(row.id));
		}
	}
	for (const [value, row] of wanted) {
		const current = existing.get(value);
		if (!current) {
			statements.push(
				db
					.prepare(`INSERT INTO ${table} (bot_id, ${column}, enabled) VALUES (?, ?, ?)`)
					.bind(botId, value, row.enabled ? 1 : 0),
			);
		} else if ((current.enabled === 1) !== row.enabled) {
			statements.push(
				db
					.prepare(`UPDATE ${table} SET enabled = ? WHERE id = ?`)
					.bind(row.enabled ? 1 : 0, current.id),
			);
		}
	}
	if (statements.length > 0) {
		await db.batch(statements);
	}
}
