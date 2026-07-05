import type {
	Destination,
	DestinationContext,
	PublishResult,
	SourceItem,
} from '@sns-bot-framework/core';
import type { EventTemplate } from 'nostr-tools/core';
import { buildTextNote } from './event.js';
import { publishToRelays, publishToWebhooks } from './publish.js';
import { credentialInfo, PrivateKeySigner } from './signer.js';

export type NostrBuildResult = EventTemplate | EventTemplate[] | null;

export interface NostrDestinationOptions {
	/** Unique within the bot. Default: 'nostr'. */
	id?: string;
	relays: readonly string[];
	/** Additionally POST signed events as JSON to these URLs. */
	webhooks?: readonly string[];
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
	/** Exposed so the admin UI can publish kind 0 / 10002 to the same relays. */
	readonly relays: readonly string[];
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
		async publish(item: SourceItem, ctx: DestinationContext): Promise<PublishResult[]> {
			const built = options.build
				? await options.build(item, ctx)
				: buildTextNote({ content: item.content ?? '' });
			if (built === null) return [];
			const templates = Array.isArray(built) ? built : [built];
			if (templates.length === 0) return [];

			const secret = await ctx.getCredential();
			if (!secret) {
				return [
					{
						target: id,
						ok: false,
						error: `No Nostr key registered for bot "${ctx.botId}" destination "${id}"`,
					},
				];
			}
			const signer = new PrivateKeySigner(secret);
			const events = await Promise.all(templates.map((template) => signer.signEvent(template)));

			if (ctx.dryRun) {
				for (const event of events) {
					ctx.log(`dry-run: would publish to [${options.relays.join(', ')}]`, event);
				}
				return events.map((event) => ({ target: 'dry-run', ok: true, remoteId: event.id }));
			}

			const results: PublishResult[] = [];
			for (const event of events) {
				results.push(...(await publishToRelays(event, options.relays, publishOptions)));
				if (options.webhooks?.length) {
					results.push(...(await publishToWebhooks(event, options.webhooks, publishOptions)));
				}
			}
			return results;
		},
	};
}
