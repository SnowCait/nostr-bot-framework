import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export interface Signer {
	getPublicKey(): Promise<string>;
	signEvent(template: EventTemplate): Promise<NostrEvent>;
}

export function normalizeSecretKey(secret: string): Uint8Array {
	const trimmed = secret.trim();
	if (trimmed.startsWith('nsec1')) {
		const decoded = nip19.decode(trimmed);
		if (decoded.type !== 'nsec') {
			throw new Error('Invalid secret key: not an nsec');
		}
		return decoded.data;
	}
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return hexToBytes(trimmed.toLowerCase());
	}
	throw new Error('Invalid secret key: expected nsec1... or 64 hex characters');
}

export interface NostrCredentialInfo {
	pubkey: string;
	npub: string;
}

export function credentialInfo(secret: string): NostrCredentialInfo {
	const pubkey = getPublicKey(normalizeSecretKey(secret));
	return { pubkey, npub: nip19.npubEncode(pubkey) };
}

export function npubFromPubkey(pubkey: string): string {
	return nip19.npubEncode(pubkey);
}

/** Accepts npub1... or 64 hex characters and returns the hex form. */
export function normalizePubkey(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('npub1')) {
		const decoded = nip19.decode(trimmed);
		if (decoded.type !== 'npub') {
			throw new Error('Invalid public key: not an npub');
		}
		return decoded.data;
	}
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	throw new Error('Invalid public key: expected npub1... or 64 hex characters');
}

export function secretKeyToHex(secret: string): string {
	return bytesToHex(normalizeSecretKey(secret));
}

export class PrivateKeySigner implements Signer {
	#secretKey: Uint8Array;

	constructor(secret: string | Uint8Array) {
		this.#secretKey = typeof secret === 'string' ? normalizeSecretKey(secret) : secret;
	}

	async getPublicKey(): Promise<string> {
		return getPublicKey(this.#secretKey);
	}

	async signEvent(template: EventTemplate): Promise<NostrEvent> {
		return finalizeEvent(template, this.#secretKey);
	}
}
