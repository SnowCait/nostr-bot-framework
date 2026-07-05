import type { CredentialResolver } from '@sns-bot-framework/core';
import { credentialInfo, npubFromPubkey, secretKeyToHex } from '@sns-bot-framework/nostr';
import type { NostrEvent } from 'nostr-tools/core';
import { decryptString, encryptString, importMasterKey, type MasterKeySource } from './crypto.js';

export interface NostrKeyStatus {
	registered: boolean;
	pubkey?: string;
	npub?: string;
	/** false when the stored key cannot be decrypted (master key lost/changed). */
	decryptable?: boolean;
}

export class D1NostrKeyStore {
	#key: Promise<CryptoKey> | undefined;

	constructor(
		private readonly db: D1Database,
		private readonly masterKey: MasterKeySource,
	) {}

	private cryptoKey(): Promise<CryptoKey> {
		this.#key ??= importMasterKey(this.masterKey);
		return this.#key;
	}

	async register(
		botId: string,
		destinationId: string,
		secret: string,
	): Promise<{ pubkey: string; npub: string }> {
		const info = credentialInfo(secret);
		const plaintext = secretKeyToHex(secret);
		const key = await this.cryptoKey();

		const existing = await this.db
			.prepare('SELECT ciphertext, iv FROM nostr_keys WHERE pubkey = ?')
			.bind(info.pubkey)
			.first<{ ciphertext: string; iv: string }>();
		if (existing) {
			// Same pubkey implies the same secret; only rewrite when the stored
			// row cannot be decrypted (e.g. after a master key change).
			let decryptable = false;
			try {
				decryptable = (await decryptString(key, existing)) === plaintext;
			} catch {
				decryptable = false;
			}
			if (!decryptable) {
				const encrypted = await encryptString(key, plaintext);
				await this.db
					.prepare('UPDATE nostr_keys SET ciphertext = ?, iv = ? WHERE pubkey = ?')
					.bind(encrypted.ciphertext, encrypted.iv, info.pubkey)
					.run();
			}
		} else {
			const encrypted = await encryptString(key, plaintext);
			await this.db
				.prepare(
					`INSERT INTO nostr_keys (pubkey, ciphertext, iv, created_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT (pubkey) DO NOTHING`,
				)
				.bind(info.pubkey, encrypted.ciphertext, encrypted.iv, Date.now())
				.run();
		}

		const previous = await this.db
			.prepare('SELECT pubkey FROM nostr_accounts WHERE bot_id = ? AND destination_id = ?')
			.bind(botId, destinationId)
			.first<{ pubkey: string }>();
		await this.db
			.prepare(
				`INSERT INTO nostr_accounts (bot_id, destination_id, pubkey) VALUES (?, ?, ?)
				 ON CONFLICT (bot_id, destination_id) DO UPDATE SET pubkey = excluded.pubkey`,
			)
			.bind(botId, destinationId, info.pubkey)
			.run();
		if (previous && previous.pubkey !== info.pubkey) {
			await this.gc(previous.pubkey);
		}
		return info;
	}

	async remove(botId: string, destinationId: string): Promise<void> {
		const row = await this.db
			.prepare('SELECT pubkey FROM nostr_accounts WHERE bot_id = ? AND destination_id = ?')
			.bind(botId, destinationId)
			.first<{ pubkey: string }>();
		if (!row) return;
		await this.db
			.prepare('DELETE FROM nostr_accounts WHERE bot_id = ? AND destination_id = ?')
			.bind(botId, destinationId)
			.run();
		await this.gc(row.pubkey);
	}

	private async gc(pubkey: string): Promise<void> {
		const referenced = await this.db
			.prepare('SELECT 1 FROM nostr_accounts WHERE pubkey = ? LIMIT 1')
			.bind(pubkey)
			.first();
		if (!referenced) {
			await this.db.prepare('DELETE FROM nostr_keys WHERE pubkey = ?').bind(pubkey).run();
		}
	}

	async pubkeyFor(botId: string, destinationId: string): Promise<string | null> {
		const row = await this.db
			.prepare('SELECT pubkey FROM nostr_accounts WHERE bot_id = ? AND destination_id = ?')
			.bind(botId, destinationId)
			.first<{ pubkey: string }>();
		return row?.pubkey ?? null;
	}

	/** Returns the secret key as hex, or null when nothing is registered. */
	async resolveSecret(botId: string, destinationId: string): Promise<string | null> {
		const pubkey = await this.pubkeyFor(botId, destinationId);
		if (!pubkey) return null;
		const row = await this.db
			.prepare('SELECT ciphertext, iv FROM nostr_keys WHERE pubkey = ?')
			.bind(pubkey)
			.first<{ ciphertext: string; iv: string }>();
		if (!row) return null;
		try {
			return await decryptString(await this.cryptoKey(), row);
		} catch {
			throw new Error(
				`Stored Nostr key for ${npubFromPubkey(pubkey)} cannot be decrypted; re-register it (was the master key changed?)`,
			);
		}
	}

	async status(botId: string, destinationId: string): Promise<NostrKeyStatus> {
		const pubkey = await this.pubkeyFor(botId, destinationId);
		if (!pubkey) return { registered: false };
		const status: NostrKeyStatus = {
			registered: true,
			pubkey,
			npub: npubFromPubkey(pubkey),
		};
		try {
			await this.resolveSecret(botId, destinationId);
			status.decryptable = true;
		} catch {
			status.decryptable = false;
		}
		return status;
	}

	credentialResolver(): CredentialResolver {
		return async (botId, destination) =>
			destination.type === 'nostr' ? this.resolveSecret(botId, destination.id) : null;
	}
}

export interface StoredNostrEvent {
	event: NostrEvent;
	publishedAt: number | null;
}

export class D1NostrEventStore {
	constructor(private readonly db: D1Database) {}

	async get(pubkey: string, kind: number): Promise<StoredNostrEvent | null> {
		const row = await this.db
			.prepare('SELECT event, published_at FROM nostr_events WHERE pubkey = ? AND kind = ?')
			.bind(pubkey, kind)
			.first<{ event: string; published_at: number | null }>();
		if (!row) return null;
		return { event: JSON.parse(row.event), publishedAt: row.published_at };
	}

	/** Saves a signed event as the canonical copy and resets published_at. */
	async save(event: NostrEvent): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO nostr_events (pubkey, kind, event, published_at) VALUES (?, ?, ?, NULL)
				 ON CONFLICT (pubkey, kind) DO UPDATE SET event = excluded.event, published_at = NULL`,
			)
			.bind(event.pubkey, event.kind, JSON.stringify(event))
			.run();
	}

	async markPublished(pubkey: string, kind: number, when = Date.now()): Promise<void> {
		await this.db
			.prepare('UPDATE nostr_events SET published_at = ? WHERE pubkey = ? AND kind = ?')
			.bind(when, pubkey, kind)
			.run();
	}
}
