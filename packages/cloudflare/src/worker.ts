import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { runBot, type BotDefinition, type BotReport } from '@sns-bot-framework/core';
import { createAdminApp } from './admin.js';
import { timingSafeEqualString, type MasterKeySource } from './crypto.js';
import { D1RunLock, D1StateStore } from './d1-state-store.js';
import { nip98Auth, type AdminAuthVariables } from './nip98.js';
import { D1NostrKeyStore } from './nostr-store.js';

export interface CreateWorkerOptions {
	bots: BotDefinition[];
	admin?: {
		/** Allowed admin pubkeys (npub or hex). Default: env.ADMIN_PUBKEYS (comma-separated). */
		pubkeys?: readonly string[];
		/** Replaceable AdminAuth middleware. Default: NIP-98. */
		auth?: MiddlewareHandler;
		/** Mount path of the admin UI. Default: '/admin'. */
		path?: string;
	};
	/** Name of the D1 binding on env. Default: 'DB'. */
	dbBinding?: string;
	/** Name of the master key binding on env (Workers Secret or Secrets Store). Default: 'MASTER_KEY'. */
	masterKeyBinding?: string;
	/** Name of the manual trigger token binding on env. Default: 'MANUAL_TRIGGER_TOKEN'. */
	manualTokenBinding?: string;
}

type Env = { Bindings: Record<string, unknown>; Variables: AdminAuthVariables };

export interface BotWorker {
	fetch: (
		request: Request,
		env: Record<string, unknown>,
		ctx: ExecutionContext,
	) => Promise<Response>;
	scheduled: (
		controller: ScheduledController,
		env: Record<string, unknown>,
		ctx: ExecutionContext,
	) => void;
}

export function createWorker(options: CreateWorkerOptions): BotWorker {
	const ids = new Set<string>();
	for (const bot of options.bots) {
		if (ids.has(bot.id)) throw new Error(`Duplicate bot id: ${bot.id}`);
		ids.add(bot.id);
	}

	const dbBinding = options.dbBinding ?? 'DB';
	const masterKeyBinding = options.masterKeyBinding ?? 'MASTER_KEY';
	const manualTokenBinding = options.manualTokenBinding ?? 'MANUAL_TRIGGER_TOKEN';
	const adminPath = options.admin?.path ?? '/admin';
	const masterKeyOf = (env: unknown): MasterKeySource => {
		const value = (env as Record<string, MasterKeySource | undefined>)[masterKeyBinding];
		if (!value) throw new Error(`Master key binding "${masterKeyBinding}" not found on env`);
		return value;
	};

	const runOne = async (
		bot: BotDefinition,
		env: Record<string, unknown>,
		dryRun: boolean,
	): Promise<BotReport> => {
		const db = env[dbBinding] as D1Database;
		const keyStore = new D1NostrKeyStore(db, masterKeyOf(env));
		return runBot(bot, {
			state: new D1StateStore(db),
			env,
			credentials: keyStore.credentialResolver(),
			relays: keyStore.relayResolver(),
			lock: new D1RunLock(db),
			dryRun,
		});
	};

	const baseAuth: MiddlewareHandler =
		options.admin?.auth ??
		nip98Auth({
			pubkeys: (env) =>
				options.admin?.pubkeys ?? ((env as Record<string, string>).ADMIN_PUBKEYS as string),
		});

	// Manual run endpoint additionally accepts a bearer token for curl/scripting.
	const auth: MiddlewareHandler = async (c, next) => {
		const token = (c.env as Record<string, unknown>)[manualTokenBinding];
		const header = c.req.header('authorization');
		const isRunRequest =
			c.req.method === 'POST' &&
			/\/api\/bots\/[A-Za-z0-9_-]+\/run$/.test(new URL(c.req.url).pathname);
		if (
			typeof token === 'string' &&
			token.length > 0 &&
			typeof header === 'string' &&
			isRunRequest &&
			timingSafeEqualString(header, `Bearer ${token}`)
		) {
			c.set('adminId', 'manual-token');
			return next();
		}
		return baseAuth(c, next);
	};

	const app = new Hono<Env>();
	app.get('/', (c) => c.redirect(adminPath));
	app.route(
		adminPath,
		createAdminApp({
			bots: options.bots,
			auth,
			dbBinding,
			masterKey: masterKeyOf,
		}),
	);

	return {
		fetch: async (request, env, ctx) => app.fetch(request, env, ctx),
		scheduled: (controller, env, ctx) => {
			const matched = options.bots.filter((bot) => !bot.cron || bot.cron === controller.cron);
			ctx.waitUntil(
				(async () => {
					const dryRun = (env.DRY_RUN as string | undefined) === '1';
					for (const bot of matched) {
						try {
							const report = await runOne(bot, env, dryRun);
							console.log(JSON.stringify(report));
						} catch (error) {
							console.error(`[${bot.id}] run failed:`, error);
						}
					}
				})(),
			);
		},
	};
}
