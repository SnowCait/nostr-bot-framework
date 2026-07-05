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

async function publishToRelay(
	event: NostrEvent,
	url: string,
	timeoutMs: number,
): Promise<PublishResult> {
	const connectP = Relay.connect(url);
	let relay: Relay | undefined;
	let done = false;
	// Always handle the connect promise: if it opens after we time out, close it
	// immediately; if it rejects late, swallow it (no unhandled rejection).
	connectP.then(
		(r) => {
			relay = r;
			if (done) r.close();
		},
		() => {},
	);
	try {
		const r = await withTimeout(connectP, timeoutMs, `connect ${url}`);
		await withTimeout(r.publish(event), timeoutMs, `publish to ${url}`);
		return { target: url, ok: true, remoteId: event.id };
	} catch (error) {
		return { target: url, ok: false, error: String(error) };
	} finally {
		done = true;
		relay?.close();
	}
}

export async function publishToRelays(
	event: NostrEvent,
	relays: readonly string[],
	options: PublishOptions = {},
): Promise<PublishResult[]> {
	const timeoutMs = options.timeoutMs ?? 5000;
	return Promise.all(relays.map((url) => publishToRelay(event, url, timeoutMs)));
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
