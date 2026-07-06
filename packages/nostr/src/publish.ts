import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/core';
import type { PublishResult } from '@sns-bot-framework/core';

export interface PublishOptions {
	timeoutMs?: number;
	/** Reuse a pool across events (e.g. a thread). Omit to use a short-lived one. */
	pool?: SimplePool;
}

function newPool(): SimplePool {
	return new SimplePool({ enablePing: false, enableReconnect: false });
}

export async function publishToRelays(
	event: NostrEvent,
	relays: readonly string[],
	options: PublishOptions = {},
): Promise<PublishResult[]> {
	if (relays.length === 0) return [];
	const timeoutMs = options.timeoutMs ?? 5000;
	const pool = options.pool ?? newPool();
	try {
		// ensureRelay throws on connect failure and relay.publish rejects on relay
		// failure, giving clean per-relay success/failure (SimplePool.publish instead
		// resolves connect failures to a "connection failure: …" string). The pool
		// owns and reuses the sockets, so there is no leak or unhandled rejection.
		return await Promise.all(
			relays.map(async (url): Promise<PublishResult> => {
				try {
					const relay = await pool.ensureRelay(url, { connectionTimeout: timeoutMs });
					await relay.publish(event);
					return { target: url, ok: true, remoteId: event.id };
				} catch (error) {
					return { target: url, ok: false, error: String(error) };
				}
			}),
		);
	} finally {
		if (!options.pool) pool.destroy();
	}
}

export async function publishToWebhooks(
	event: NostrEvent,
	urls: readonly string[],
	options: PublishOptions = {},
): Promise<PublishResult[]> {
	const timeoutMs = options.timeoutMs ?? 5000;
	return Promise.all(
		urls.map(async (url): Promise<PublishResult> => {
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(event),
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!response.ok) {
					return { target: url, ok: false, error: `HTTP ${response.status}` };
				}
				return { target: url, ok: true, remoteId: event.id };
			} catch (error) {
				return { target: url, ok: false, error: String(error) };
			}
		}),
	);
}

export { SimplePool };
