import type { PublishedEntry, StateStore } from './types.js';

export class MemoryStateStore implements StateStore {
	readonly published = new Map<string, PublishedEntry>();
	readonly values = new Map<string, string>();

	async filterUnpublished(botId: string, destinationId: string, ids: string[]): Promise<string[]> {
		return ids.filter((id) => !this.published.has(`${botId}/${destinationId}/${id}`));
	}

	async markPublished(
		botId: string,
		destinationId: string,
		entries: PublishedEntry[],
	): Promise<void> {
		for (const entry of entries) {
			this.published.set(`${botId}/${destinationId}/${entry.itemId}`, entry);
		}
	}

	async get(botId: string, key: string): Promise<string | null> {
		return this.values.get(`${botId}/${key}`) ?? null;
	}

	async set(botId: string, key: string, value: string): Promise<void> {
		this.values.set(`${botId}/${key}`, value);
	}
}
