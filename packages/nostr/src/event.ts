import type { EventTemplate } from 'nostr-tools/core';

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
		kind: 1,
		content: options.content,
		tags: options.tags ?? [],
		created_at: options.createdAt ?? now(),
	};
}

export interface EventPointer {
	id: string;
	pubkey?: string;
	relay?: string;
}

/**
 * NIP-10 marked tags for a reply. When root is omitted the reply target is
 * treated as the thread root.
 */
export function replyTags(reply: EventPointer, root?: EventPointer): string[][] {
	const tags: string[][] = [];
	if (root) {
		tags.push(['e', root.id, root.relay ?? '', 'root', ...(root.pubkey ? [root.pubkey] : [])]);
		tags.push(['e', reply.id, reply.relay ?? '', 'reply', ...(reply.pubkey ? [reply.pubkey] : [])]);
	} else {
		tags.push(['e', reply.id, reply.relay ?? '', 'root', ...(reply.pubkey ? [reply.pubkey] : [])]);
	}
	const pubkeys = new Set([root?.pubkey, reply.pubkey].filter((p): p is string => Boolean(p)));
	for (const pubkey of pubkeys) {
		tags.push(['p', pubkey]);
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
		kind: 0,
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
		kind: 10002,
		content: '',
		tags: relays.map((relay) => {
			if (relay.read && !relay.write) return ['r', relay.url, 'read'];
			if (relay.write && !relay.read) return ['r', relay.url, 'write'];
			return ['r', relay.url];
		}),
		created_at: createdAt ?? now(),
	};
}
