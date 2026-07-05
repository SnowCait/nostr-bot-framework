import type { MiddlewareHandler } from 'hono';
import { Nip98Error, normalizePubkey, verifyNip98Request } from '@sns-bot-framework/nostr';

export type AdminAuthVariables = {
	adminId: string;
};

export interface Nip98AuthOptions {
	/**
	 * Allowed admin pubkeys (npub or hex). A function receives env and may
	 * return an array or a comma-separated string (e.g. env.ADMIN_PUBKEYS).
	 */
	pubkeys: readonly string[] | ((env: unknown) => readonly string[] | string | undefined);
	maxAgeSeconds?: number;
}

function resolvePubkeys(options: Nip98AuthOptions, env: unknown): string[] {
	const raw = typeof options.pubkeys === 'function' ? options.pubkeys(env) : options.pubkeys;
	const list = typeof raw === 'string' ? raw.split(',') : (raw ?? []);
	return list
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map(normalizePubkey);
}

/** AdminAuth implementation backed by NIP-98 (kind 27235 HTTP auth). */
export function nip98Auth(options: Nip98AuthOptions): MiddlewareHandler {
	return async (c, next) => {
		let allowed: string[];
		try {
			allowed = resolvePubkeys(options, c.env);
		} catch (error) {
			return c.json({ error: `Invalid ADMIN_PUBKEYS entry: ${String(error)}` }, 500);
		}
		if (allowed.length === 0) {
			return c.json({ error: 'No admin pubkeys configured' }, 403);
		}
		try {
			const method = c.req.method.toUpperCase();
			const body =
				method === 'GET' || method === 'HEAD' ? null : await c.req.raw.clone().arrayBuffer();
			const verifyOptions: Parameters<typeof verifyNip98Request>[0] = {
				authorization: c.req.header('authorization') ?? null,
				url: c.req.url,
				method,
				body,
			};
			if (options.maxAgeSeconds !== undefined) {
				verifyOptions.maxAgeSeconds = options.maxAgeSeconds;
			}
			const { pubkey } = await verifyNip98Request(verifyOptions);
			if (!allowed.includes(pubkey)) {
				return c.json({ error: 'Pubkey not allowed' }, 403);
			}
			c.set('adminId', pubkey);
			await next();
			return;
		} catch (error) {
			if (error instanceof Nip98Error) {
				return c.json({ error: error.message }, 401);
			}
			throw error;
		}
	};
}
