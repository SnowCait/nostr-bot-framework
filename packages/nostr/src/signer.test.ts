import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { credentialInfo, normalizeSecretKey, PrivateKeySigner } from './signer.js';

const secretKey = generateSecretKey();
const hex = [...secretKey].map((b) => b.toString(16).padStart(2, '0')).join('');
const nsec = nip19.nsecEncode(secretKey);

describe('normalizeSecretKey', () => {
	it('accepts hex and nsec forms of the same key', () => {
		expect(normalizeSecretKey(hex)).toEqual(secretKey);
		expect(normalizeSecretKey(nsec)).toEqual(secretKey);
		expect(normalizeSecretKey(`  ${nsec}\n`)).toEqual(secretKey);
	});

	it('rejects invalid values', () => {
		expect(() => normalizeSecretKey('not-a-key')).toThrow(/Invalid secret key/);
		expect(() => normalizeSecretKey('deadbeef')).toThrow(/Invalid secret key/);
		expect(() => normalizeSecretKey(nip19.npubEncode(getPublicKey(secretKey)))).toThrow();
	});
});

describe('credentialInfo', () => {
	it('derives pubkey and npub', () => {
		const info = credentialInfo(nsec);
		expect(info.pubkey).toBe(getPublicKey(secretKey));
		expect(info.npub).toBe(nip19.npubEncode(info.pubkey));
	});
});

describe('PrivateKeySigner', () => {
	it('signs events verifiable with the derived pubkey', async () => {
		const signer = new PrivateKeySigner(hex);
		const event = await signer.signEvent({
			kind: 1,
			content: 'hello',
			tags: [],
			created_at: 1750000000,
		});
		expect(event.pubkey).toBe(await signer.getPublicKey());
		expect(verifyEvent(event)).toBe(true);
	});
});
