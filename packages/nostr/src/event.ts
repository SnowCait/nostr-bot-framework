import type { EventTemplate } from 'nostr-tools/core';
import type { EventPointer } from 'nostr-tools/nip19';
import { Metadata, RelayList, ShortTextNote } from 'nostr-tools/kinds';

function now(): number {
	return Math.floor(Date.now() / 1000);
}

export interface TextNoteOptions {
	content: string;
	tags?: string[][];
	createdAt?: number;
}

export function buildTextNote(options: TextNoteOptions): EventTemplate {
	return {
		kind: ShortTextNote,
		content: options.content,
		tags: options.tags ?? [],
		created_at: options.createdAt ?? now(),
	};
}

export type { EventPointer };

/**
 * NIP-10 marked tags for a reply. When root is omitted the reply target is
 * treated as the thread root. Pointers use the nostr-tools EventPointer shape
 * ({ id, relays?, author? }).
 */
export function replyTags(reply: EventPointer, root?: EventPointer): string[][] {
	const relayHint = (p: EventPointer): string => p.relays?.[0] ?? '';
	const tags: string[][] = [];
	if (root) {
		tags.push(['e', root.id, relayHint(root), 'root', ...(root.author ? [root.author] : [])]);
		tags.push(['e', reply.id, relayHint(reply), 'reply', ...(reply.author ? [reply.author] : [])]);
	} else {
		tags.push(['e', reply.id, relayHint(reply), 'root', ...(reply.author ? [reply.author] : [])]);
	}
	const authors = new Set([root?.author, reply.author].filter((p): p is string => Boolean(p)));
	for (const author of authors) {
		tags.push(['p', author]);
	}
	return tags;
}

export interface ProfileMetadata {
	name?: string;
	display_name?: string;
	about?: string;
	picture?: string;
	banner?: string;
	website?: string;
	nip05?: string;
	lud16?: string;
	[key: string]: unknown;
}

export function buildMetadata(profile: ProfileMetadata, createdAt?: number): EventTemplate {
	return {
		kind: Metadata,
		content: JSON.stringify(profile),
		tags: [],
		created_at: createdAt ?? now(),
	};
}

export interface RelayListEntry {
	url: string;
	/** Omit both flags for a read+write relay (NIP-65). */
	read?: boolean;
	write?: boolean;
}

export function buildRelayList(
	relays: readonly RelayListEntry[],
	createdAt?: number,
): EventTemplate {
	return {
		kind: RelayList,
		content: '',
		tags: relays.map((relay) => {
			if (relay.read && !relay.write) return ['r', relay.url, 'read'];
			if (relay.write && !relay.read) return ['r', relay.url, 'write'];
			return ['r', relay.url];
		}),
		created_at: createdAt ?? now(),
	};
}
