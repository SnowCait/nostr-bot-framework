import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { PrivateKeySigner } from '@sns-bot-framework/nostr';
import { decryptString, encryptString, importMasterKey } from './crypto.js';
import { D1StateStore } from './d1-state-store.js';
import { D1NostrEventStore, D1NostrKeyStore } from './nostr-store.js';

const db = (env as { DB: D1Database }).DB;
const MASTER_KEY = (env as { MASTER_KEY: string }).MASTER_KEY;

describe('crypto', () => {
	it('round-trips and fails with a different master key', async () => {
		const key = await importMasterKey(MASTER_KEY);
		const encrypted = await encryptString(key, 'secret-value');
		expect(await decryptString(key, encrypted)).toBe('secret-value');

		const otherKey = await importMasterKey('another-master-key-value');
		await expect(decryptString(otherKey, encrypted)).rejects.toThrow();
	});

	it('rejects short master keys', async () => {
		await expect(importMasterKey('short')).rejects.toThrow(/at least/);
	});

	it('accepts Secrets Store style bindings', async () => {
		const key = await importMasterKey({ get: async () => MASTER_KEY });
		const encrypted = await encryptString(key, 'x');
		expect(await decryptString(key, encrypted)).toBe('x');
	});
});

describe('D1StateStore', () => {
	const store = new D1StateStore(db);

	it('filters and marks per destination', async () => {
		await store.markPublished('bot1', 'nostr', [{ itemId: 'a', remoteId: 'e1' }]);
		expect(await store.filterUnpublished('bot1', 'nostr', ['a', 'b'])).toEqual(['b']);
		expect(await store.filterUnpublished('bot1', 'other', ['a', 'b'])).toEqual(['a', 'b']);
		expect(await store.filterUnpublished('bot2', 'nostr', ['a'])).toEqual(['a']);
	});

	it('handles large id lists across chunks', async () => {
		const ids = Array.from({ length: 120 }, (_, i) => `bulk-${i}`);
		await store.markPublished(
			'bot1',
			'nostr',
			ids.slice(0, 70).map((itemId) => ({ itemId })),
		);
		const unpublished = await store.filterUnpublished('bot1', 'nostr', ids);
		expect(unpublished).toEqual(ids.slice(70));
	});

	it('stores generic state values', async () => {
		expect(await store.get('bot1', 'cursor')).toBeNull();
		await store.set('bot1', 'cursor', '5');
		await store.set('bot1', 'cursor', '6');
		expect(await store.get('bot1', 'cursor')).toBe('6');
	});
});

describe('D1NostrKeyStore', () => {
	const keyStore = new D1NostrKeyStore(db, MASTER_KEY);
	const secretKey = generateSecretKey();
	const hex = [...secretKey].map((b) => b.toString(16).padStart(2, '0')).join('');
	const nsec = nip19.nsecEncode(secretKey);
	const pubkey = getPublicKey(secretKey);

	it('registers a key and resolves it back', async () => {
		const info = await keyStore.register('bot1', 'nostr', nsec);
		expect(info.pubkey).toBe(pubkey);
		expect(info.npub).toMatch(/^npub1/);
		expect(await keyStore.resolveSecret('bot1', 'nostr')).toBe(hex);
	});

	it('keeps a single row when the same key is registered for multiple bots', async () => {
		await keyStore.register('bot1', 'nostr', nsec);
		await keyStore.register('bot2', 'nostr', hex);
		const { results } = await db
			.prepare('SELECT pubkey, created_at FROM nostr_keys WHERE pubkey = ?')
			.bind(pubkey)
			.all<{ pubkey: string; created_at: number }>();
		expect(results).toHaveLength(1);
	});

	it('preserves created_at when re-registering the same key', async () => {
		await keyStore.register('bot1', 'nostr', nsec);
		const before = await db
			.prepare('SELECT created_at FROM nostr_keys WHERE pubkey = ?')
			.bind(pubkey)
			.first<{ created_at: number }>();
		await new Promise((resolve) => setTimeout(resolve, 5));
		await keyStore.register('bot1', 'nostr', nsec);
		const after = await db
			.prepare('SELECT created_at FROM nostr_keys WHERE pubkey = ?')
			.bind(pubkey)
			.first<{ created_at: number }>();
		expect(after!.created_at).toBe(before!.created_at);
	});

	it('reports status and garbage-collects unreferenced keys', async () => {
		await keyStore.register('bot1', 'nostr', nsec);
		await keyStore.register('bot2', 'nostr', hex);
		const status = await keyStore.status('bot1', 'nostr');
		expect(status).toMatchObject({ registered: true, pubkey, decryptable: true });

		await keyStore.remove('bot2', 'nostr');
		let row = await db.prepare('SELECT 1 FROM nostr_keys WHERE pubkey = ?').bind(pubkey).first();
		expect(row).not.toBeNull();

		await keyStore.remove('bot1', 'nostr');
		row = await db.prepare('SELECT 1 FROM nostr_keys WHERE pubkey = ?').bind(pubkey).first();
		expect(row).toBeNull();
		expect(await keyStore.status('bot1', 'nostr')).toEqual({ registered: false });
	});

	it('rejects invalid secrets and resolves null when unregistered', async () => {
		await expect(keyStore.register('bot1', 'nostr', 'garbage')).rejects.toThrow(
			/Invalid secret key/,
		);
		expect(await keyStore.resolveSecret('bot-none', 'nostr')).toBeNull();
	});

	it('replaces the account mapping and GCs the old key when switching keys', async () => {
		const otherSecret = generateSecretKey();
		await keyStore.register('bot3', 'nostr', nip19.nsecEncode(otherSecret));
		await keyStore.register('bot3', 'nostr', nsec);
		const oldRow = await db
			.prepare('SELECT 1 FROM nostr_keys WHERE pubkey = ?')
			.bind(getPublicKey(otherSecret))
			.first();
		expect(oldRow).toBeNull();
		expect(await keyStore.resolveSecret('bot3', 'nostr')).toBe(hex);
		await keyStore.remove('bot3', 'nostr');
	});

	it('flags undecryptable keys after a master key change', async () => {
		await keyStore.register('bot4', 'nostr', nsec);
		const wrongStore = new D1NostrKeyStore(db, 'different-master-key-value');
		await expect(wrongStore.resolveSecret('bot4', 'nostr')).rejects.toThrow(/re-register/);
		expect((await wrongStore.status('bot4', 'nostr')).decryptable).toBe(false);

		// Re-registering through the new store heals the row.
		await wrongStore.register('bot4', 'nostr', nsec);
		expect(await wrongStore.resolveSecret('bot4', 'nostr')).toBe(hex);
		await wrongStore.remove('bot4', 'nostr');
	});
});

describe('D1NostrEventStore', () => {
	const eventStore = new D1NostrEventStore(db);
	const signer = new PrivateKeySigner(generateSecretKey());

	it('saves canonical events, tracks publish state, and replaces by kind', async () => {
		const event = await signer.signEvent({
			kind: 0,
			content: JSON.stringify({ name: 'bot' }),
			tags: [],
			created_at: 1750000000,
		});
		await eventStore.save(event);
		let stored = await eventStore.get(event.pubkey, 0);
		expect(stored!.event.id).toBe(event.id);
		expect(stored!.publishedAt).toBeNull();

		await eventStore.markPublished(event.pubkey, 0, 12345);
		stored = await eventStore.get(event.pubkey, 0);
		expect(stored!.publishedAt).toBe(12345);

		const updated = await signer.signEvent({
			kind: 0,
			content: JSON.stringify({ name: 'bot2' }),
			tags: [],
			created_at: 1750000001,
		});
		await eventStore.save(updated);
		stored = await eventStore.get(event.pubkey, 0);
		expect(stored!.event.id).toBe(updated.id);
		expect(stored!.publishedAt).toBeNull();
	});
});
