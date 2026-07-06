import type {
	Destination,
	DestinationContext,
	PublishOutcome,
	PublishResult,
	SourceItem,
} from '@sns-bot-framework/core';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { buildTextNote, replyTags } from './event.js';
import { publishToRelays, publishToWebhooks, SimplePool } from './publish.js';
import { credentialInfo, PrivateKeySigner } from './signer.js';

export type NostrBuildResult = EventTemplate | EventTemplate[] | null;

export interface NostrDestinationOptions {
	/** Unique within the bot. Default: 'nostr'. */
	id?: string;
	relays: readonly string[];
	/** Additionally POST signed events as JSON to these URLs. */
	webhooks?: readonly string[];
	/**
	 * Chain a multi-event build into a NIP-10 thread: each event after the first
	 * replies to the previous one. Default: false (independent events).
	 */
	thread?: boolean;
	/**
	 * Escape hatch: build events freely from an item.
	 * Return null to skip the item (it is consumed, not retried).
	 */
	build?: (
		item: SourceItem,
		ctx: DestinationContext,
	) => NostrBuildResult | Promise<NostrBuildResult>;
	timeoutMs?: number;
}

export interface NostrDestination extends Destination {
	readonly type: 'nostr';
	/** Default publish targets; overridden at runtime by ctx.getRelays() when set. */
	readonly relays: readonly string[];
}

async function signChain(
	templates: EventTemplate[],
	signer: PrivateKeySigner,
	thread: boolean,
): Promise<NostrEvent[]> {
	if (!thread) {
		return Promise.all(templates.map((template) => signer.signEvent(template)));
	}
	const events: NostrEvent[] = [];
	let root: NostrEvent | undefined;
	let prev: NostrEvent | undefined;
	for (const template of templates) {
		const tags = [...(template.tags ?? [])];
		if (root && prev) {
			tags.push(
				...replyTags({ id: prev.id, author: prev.pubkey }, { id: root.id, author: root.pubkey }),
			);
		}
		const signed = await signer.signEvent({ ...template, tags });
		root ??= signed;
		prev = signed;
		events.push(signed);
	}
	return events;
}

export function nostrDestination(options: NostrDestinationOptions): NostrDestination {
	const id = options.id ?? 'nostr';
	const publishOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
	return {
		id,
		type: 'nostr',
		relays: options.relays,
		async validateCredential(value: string) {
			return { displayId: credentialInfo(value).npub };
		},
		async publish(item: SourceItem, ctx: DestinationContext): Promise<PublishOutcome> {
			const built = options.build
				? await options.build(item, ctx)
				: buildTextNote({ content: item.content ?? '' });
			if (built === null) return { ok: true, results: [] };
			const templates = Array.isArray(built) ? built : [built];
			if (templates.length === 0) return { ok: true, results: [] };

			const secret = await ctx.getCredential();
			if (!secret) {
				return {
					ok: false,
					results: [
						{
							target: id,
							ok: false,
							error: `No Nostr key registered for bot "${ctx.botId}" destination "${id}"`,
						},
					],
				};
			}
			const signer = new PrivateKeySigner(secret);
			const events = await signChain(templates, signer, options.thread ?? false);
			const relays = (await ctx.getRelays?.()) ?? options.relays;

			if (ctx.dryRun) {
				for (const event of events) {
					ctx.log(`dry-run: would publish to [${relays.join(', ')}]`, event);
				}
				const dryOutcome: PublishOutcome = {
					ok: true,
					results: events.map((event) => ({ target: 'dry-run', ok: true, remoteId: event.id })),
				};
				if (events[0]) dryOutcome.remoteId = events[0].id;
				return dryOutcome;
			}

			const results: PublishResult[] = [];
			let allEventsOk = events.length > 0;
			// Reuse one pool across a thread's events so relay connections are shared.
			const pool =
				relays.length > 0
					? new SimplePool({ enablePing: false, enableReconnect: false })
					: undefined;
			try {
				for (const event of events) {
					const relayResults = await publishToRelays(event, relays, {
						...publishOptions,
						...(pool ? { pool } : {}),
					});
					results.push(...relayResults);
					const webhookResults = options.webhooks?.length
						? await publishToWebhooks(event, options.webhooks, publishOptions)
						: [];
					results.push(...webhookResults);
					// An event is delivered if it reached at least one primary target:
					// relays when configured, otherwise the webhook mirrors.
					const primary = relays.length > 0 ? relayResults : webhookResults;
					if (!primary.some((r) => r.ok)) allEventsOk = false;
				}
			} finally {
				pool?.destroy();
			}
			const outcome: PublishOutcome = { ok: allEventsOk, results };
			if (events[0]) outcome.remoteId = events[0].id;
			return outcome;
		},
	};
}
