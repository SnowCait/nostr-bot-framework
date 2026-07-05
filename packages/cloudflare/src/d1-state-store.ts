import type { PublishedEntry, StateStore } from '@sns-bot-framework/core';

const CHUNK = 50;

export class D1StateStore implements StateStore {
	constructor(private readonly db: D1Database) {}

	async filterUnpublished(botId: string, destinationId: string, ids: string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const found = new Set<string>();
		for (let offset = 0; offset < ids.length; offset += CHUNK) {
			const chunk = ids.slice(offset, offset + CHUNK);
			const placeholders = chunk.map(() => '?').join(', ');
			const { results } = await this.db
				.prepare(
					`SELECT item_id FROM published_items
					 WHERE bot_id = ? AND destination_id = ? AND item_id IN (${placeholders})`,
				)
				.bind(botId, destinationId, ...chunk)
				.all<{ item_id: string }>();
			for (const row of results) {
				found.add(row.item_id);
			}
		}
		return ids.filter((id) => !found.has(id));
	}

	async markPublished(
		botId: string,
		destinationId: string,
		entries: PublishedEntry[],
	): Promise<void> {
		if (entries.length === 0) return;
		const statement = this.db.prepare(
			`INSERT OR IGNORE INTO published_items (bot_id, destination_id, item_id, remote_id, published_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		const now = Date.now();
		await this.db.batch(
			entries.map((entry) =>
				statement.bind(botId, destinationId, entry.itemId, entry.remoteId ?? null, now),
			),
		);
	}

	async get(botId: string, key: string): Promise<string | null> {
		const row = await this.db
			.prepare('SELECT value FROM bot_state WHERE bot_id = ? AND key = ?')
			.bind(botId, key)
			.first<{ value: string }>();
		return row?.value ?? null;
	}

	async set(botId: string, key: string, value: string): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO bot_state (bot_id, key, value) VALUES (?, ?, ?)
				 ON CONFLICT (bot_id, key) DO UPDATE SET value = excluded.value`,
			)
			.bind(botId, key, value)
			.run();
	}
}
