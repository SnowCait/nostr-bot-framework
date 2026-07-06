import { verifyEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { HTTPAuth } from 'nostr-tools/kinds';
import { bytesToHex, utf8Decoder, utf8Encoder } from 'nostr-tools/utils';
import type { Signer } from './signer.js';

// NIP-98 HTTP Auth (kind 27235).
export class HttpAuthError extends Error {
	readonly status = 401;
}

function utf8ToBase64(text: string): string {
	let binary = '';
	for (const byte of utf8Encoder.encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64ToUtf8(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return utf8Decoder.decode(bytes);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

function toBytes(body: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof body === 'string') return utf8Encoder.encode(body);
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(body);
}

function tagValue(event: NostrEvent, name: string): string | undefined {
	return event.tags.find((tag) => tag[0] === name)?.[1];
}

export interface VerifyHttpAuthOptions {
	authorization: string | null | undefined;
	url: string;
	method: string;
	body?: ArrayBuffer | Uint8Array | string | null;
	/** Allowed clock skew for created_at, in seconds. Default: 60. */
	maxAgeSeconds?: number;
	/** Current unix time in seconds, for tests. */
	now?: number;
}

export interface VerifiedHttpAuth {
	pubkey: string;
	event: NostrEvent;
}

export async function verifyHttpAuth(options: VerifyHttpAuthOptions): Promise<VerifiedHttpAuth> {
	const { authorization } = options;
	if (!authorization || !/^nostr /i.test(authorization)) {
		throw new HttpAuthError('Missing Nostr authorization header');
	}

	let event: NostrEvent;
	try {
		event = JSON.parse(base64ToUtf8(authorization.slice(6).trim()));
	} catch {
		throw new HttpAuthError('Malformed NIP-98 token');
	}

	if (event.kind !== HTTPAuth) {
		throw new HttpAuthError(`Unexpected event kind: ${event.kind}`);
	}
	if (!verifyEvent(event)) {
		throw new HttpAuthError('Invalid event signature');
	}

	const now = options.now ?? Math.floor(Date.now() / 1000);
	const maxAge = options.maxAgeSeconds ?? 60;
	if (Math.abs(now - event.created_at) > maxAge) {
		throw new HttpAuthError('Token expired');
	}

	const urlTag = tagValue(event, 'u');
	if (!urlTag || new URL(urlTag).href !== new URL(options.url).href) {
		throw new HttpAuthError('URL mismatch');
	}

	const methodTag = tagValue(event, 'method');
	if (!methodTag || methodTag.toUpperCase() !== options.method.toUpperCase()) {
		throw new HttpAuthError('Method mismatch');
	}

	// NIP-98 hashes the raw request body bytes (not a re-serialized object).
	const bodyBytes =
		options.body === null || options.body === undefined ? null : toBytes(options.body);
	if (bodyBytes && bodyBytes.byteLength > 0) {
		const payloadTag = tagValue(event, 'payload');
		if (!payloadTag || payloadTag !== (await sha256Hex(bodyBytes))) {
			throw new HttpAuthError('Payload hash mismatch');
		}
	}

	return { pubkey: event.pubkey, event };
}

export interface BuildHttpAuthTokenOptions {
	url: string;
	method: string;
	signer: Signer;
	body?: ArrayBuffer | Uint8Array | string;
	createdAt?: number;
}

/** Builds an Authorization header value ("Nostr <base64>"). Useful for tests and CLI clients. */
export async function buildHttpAuthToken(options: BuildHttpAuthTokenOptions): Promise<string> {
	const tags: string[][] = [
		['u', options.url],
		['method', options.method.toUpperCase()],
	];
	if (options.body !== undefined) {
		const bytes = toBytes(options.body);
		if (bytes.byteLength > 0) {
			tags.push(['payload', await sha256Hex(bytes)]);
		}
	}
	const template: EventTemplate = {
		kind: HTTPAuth,
		content: '',
		tags,
		created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
	};
	const event = await options.signer.signEvent(template);
	return `Nostr ${utf8ToBase64(JSON.stringify(event))}`;
}
