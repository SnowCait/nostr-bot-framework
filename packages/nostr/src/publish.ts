import { Relay } from 'nostr-tools/relay';
import type { NostrEvent } from 'nostr-tools/core';
import type { PublishResult } from '@sns-bot-framework/core';

export interface PublishOptions {
	timeoutMs?: number;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export async function publishToRelays(
	event: NostrEvent,
	relays: readonly string[],
	options: PublishOptions = {},
): Promise<PublishResult[]> {
	const timeoutMs = options.timeoutMs ?? 5000;
	return Promise.all(
		relays.map(async (url): Promise<PublishResult> => {
			let relay: Relay | undefined;
			try {
				relay = await withTimeout(Relay.connect(url), timeoutMs, `connect ${url}`);
				await withTimeout(relay.publish(event), timeoutMs, `publish to ${url}`);
				return { target: url, ok: true, remoteId: event.id };
			} catch (error) {
				return { target: url, ok: false, error: String(error) };
			} finally {
				relay?.close();
			}
		}),
	);
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
