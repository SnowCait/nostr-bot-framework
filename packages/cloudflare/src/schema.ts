export const SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS published_items (
		bot_id TEXT NOT NULL,
		destination_id TEXT NOT NULL,
		item_id TEXT NOT NULL,
		remote_id TEXT,
		published_at INTEGER NOT NULL,
		PRIMARY KEY (bot_id, destination_id, item_id)
	)`,
	`CREATE TABLE IF NOT EXISTS bot_state (
		bot_id TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (bot_id, key)
	)`,
	`CREATE TABLE IF NOT EXISTS feeds (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id TEXT NOT NULL,
		url TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE IF NOT EXISTS phrases (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id TEXT NOT NULL,
		content TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE TABLE IF NOT EXISTS nostr_keys (
		pubkey TEXT PRIMARY KEY,
		ciphertext TEXT NOT NULL,
		iv TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS nostr_accounts (
		bot_id TEXT NOT NULL,
		destination_id TEXT NOT NULL,
		pubkey TEXT NOT NULL,
		PRIMARY KEY (bot_id, destination_id)
	)`,
	`CREATE TABLE IF NOT EXISTS nostr_events (
		pubkey TEXT NOT NULL,
		kind INTEGER NOT NULL,
		event TEXT NOT NULL,
		published_at INTEGER,
		PRIMARY KEY (pubkey, kind)
	)`,
];

export async function applySchema(db: D1Database): Promise<void> {
	for (const statement of SCHEMA_STATEMENTS) {
		await db.prepare(statement).run();
	}
}
