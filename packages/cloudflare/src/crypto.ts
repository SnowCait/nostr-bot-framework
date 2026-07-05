export type MasterKeySource = string | { get(): Promise<string> };

const MIN_MASTER_KEY_LENGTH = 16;

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Derives an AES-256-GCM key from the master key string via SHA-256, so any
 * high-entropy string (e.g. from a password manager) can be used as-is.
 */
export async function importMasterKey(source: MasterKeySource): Promise<CryptoKey> {
	const material = (typeof source === 'string' ? source : await source.get()).trim();
	if (material.length < MIN_MASTER_KEY_LENGTH) {
		throw new Error(`MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters`);
	}
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedValue {
	ciphertext: string;
	iv: string;
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<EncryptedValue> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptString(key: CryptoKey, value: EncryptedValue): Promise<string> {
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(value.iv) },
		key,
		fromBase64(value.ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}

/** Constant-time string comparison to avoid leaking secrets via timing. */
export function timingSafeEqualString(a: string, b: string): boolean {
	const ba = new TextEncoder().encode(a);
	const bb = new TextEncoder().encode(b);
	// Compare against a fixed-length buffer so length differences don't short-circuit.
	let diff = ba.length ^ bb.length;
	for (let i = 0; i < ba.length; i++) {
		diff |= ba[i]! ^ (bb[i] ?? 0);
	}
	return diff === 0;
}
