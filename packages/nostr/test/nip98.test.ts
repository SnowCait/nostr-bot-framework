import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { PrivateKeySigner } from '../src/signer.js';
import { buildNip98Token, verifyNip98Request } from '../src/nip98.js';

const signer = new PrivateKeySigner(generateSecretKey());
const url = 'https://bot.example.com/admin/api/bots';

describe('NIP-98', () => {
	it('verifies a valid GET token', async () => {
		const token = await buildNip98Token({ url, method: 'GET', signer });
		const verified = await verifyNip98Request({ authorization: token, url, method: 'GET' });
		expect(verified.pubkey).toBe(await signer.getPublicKey());
	});

	it('verifies payload hashes for request bodies', async () => {
		const body = JSON.stringify({ hello: 'world' });
		const token = await buildNip98Token({ url, method: 'POST', signer, body });
		await expect(
			verifyNip98Request({ authorization: token, url, method: 'POST', body }),
		).resolves.toBeTruthy();
		await expect(
			verifyNip98Request({ authorization: token, url, method: 'POST', body: '{"tampered":1}' }),
		).rejects.toThrow(/Payload hash mismatch/);
	});

	it('rejects a missing payload tag when the request has a body', async () => {
		const token = await buildNip98Token({ url, method: 'POST', signer });
		await expect(
			verifyNip98Request({ authorization: token, url, method: 'POST', body: '{"a":1}' }),
		).rejects.toThrow(/Payload hash mismatch/);
	});

	it('rejects URL and method mismatches', async () => {
		const token = await buildNip98Token({ url, method: 'GET', signer });
		await expect(
			verifyNip98Request({ authorization: token, url: 'https://evil.example.com/', method: 'GET' }),
		).rejects.toThrow(/URL mismatch/);
		await expect(
			verifyNip98Request({ authorization: token, url, method: 'DELETE' }),
		).rejects.toThrow(/Method mismatch/);
	});

	it('rejects expired tokens', async () => {
		const token = await buildNip98Token({
			url,
			method: 'GET',
			signer,
			createdAt: Math.floor(Date.now() / 1000) - 300,
		});
		await expect(verifyNip98Request({ authorization: token, url, method: 'GET' })).rejects.toThrow(
			/expired/i,
		);
	});

	it('rejects garbage and missing headers', async () => {
		await expect(verifyNip98Request({ authorization: null, url, method: 'GET' })).rejects.toThrow();
		await expect(
			verifyNip98Request({ authorization: 'Nostr not-base64!!', url, method: 'GET' }),
		).rejects.toThrow(/Malformed/);
		await expect(
			verifyNip98Request({ authorization: 'Bearer abc', url, method: 'GET' }),
		).rejects.toThrow(/Missing Nostr/);
	});

	it('rejects tampered signatures', async () => {
		const token = await buildNip98Token({ url, method: 'GET', signer });
		const decoded = JSON.parse(atob(token.slice(6)));
		decoded.content = 'tampered';
		const tampered = `Nostr ${btoa(JSON.stringify(decoded))}`;
		await expect(
			verifyNip98Request({ authorization: tampered, url, method: 'GET' }),
		).rejects.toThrow(/Invalid event signature/);
	});
});
