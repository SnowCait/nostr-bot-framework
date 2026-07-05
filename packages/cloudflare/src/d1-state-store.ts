import type { PublishedEntry, RunLock, StateStore } from '@sns-bot-framework/core';

const CHUNK = 50;

/**
 * Best-effort mutual exclusion backed by a `bot_state` row. This narrows the
 * window for double-posting when the same bot runs concurrently (overlapping
 * cron triggers, or a manual run during a scheduled one). It is NOT a strict
 * lock: D1 offers no cross-request transaction, so two racing acquirers can
 * still both win in rare cases.
 */
export class D1RunLock implements RunLock {
	constructor(
		private readonly db: D1Database,
		private readonly ttlMs = 60_000,
	) {}

	async acquire(botId: string, destinationId: string): Promise<boolean> {
		const key = `lock:${destinationId}`;
		const now = Date.now();
		const expiry = String(now + this.ttlMs);
		// Claim only if no live lock exists (missing row, or expired value).
		const result = await this.db
			.prepare(
				`INSERT INTO bot_state (bot_id, key, value) VALUES (?, ?, ?)
				 ON CONFLICT (bot_id, key) DO UPDATE SET value = excluded.value
				 WHERE CAST(bot_state.value AS INTEGER) < ?`,
			)
			.bind(botId, key, expiry, now)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async release(botId: string, destinationId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM bot_state WHERE bot_id = ? AND key = ?')
			.bind(botId, `lock:${destinationId}`)
			.run();
	}
}

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
