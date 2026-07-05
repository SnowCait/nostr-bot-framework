import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { defineBot, staticListSource } from '@sns-bot-framework/core';
import { buildNip98Token, nostrDestination, PrivateKeySigner } from '@sns-bot-framework/nostr';
import { createWorker } from './worker.js';

const adminSecret = generateSecretKey();
const adminSigner = new PrivateKeySigner(adminSecret);
const adminPubkey = getPublicKey(adminSecret);
const intruderSigner = new PrivateKeySigner(generateSecretKey());

const botKey = nip19.nsecEncode(generateSecretKey());

const worker = createWorker({
	bots: [
		defineBot({
			id: 'phrases',
			source: staticListSource(['hello', 'world']),
			destinations: [nostrDestination({ relays: ['wss://relay.invalid'] })],
			repeat: true,
		}),
	],
	admin: { pubkeys: [nip19.npubEncode(adminPubkey)] },
});

const ORIGIN = 'https://bot.example.com';

async function call(
	method: string,
	path: string,
	options: { body?: unknown; signer?: PrivateKeySigner; bearer?: string } = {},
): Promise<Response> {
	const url = `${ORIGIN}${path}`;
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const headers = new Headers();
	if (options.bearer) {
		headers.set('authorization', `Bearer ${options.bearer}`);
	} else if (options.signer) {
		const tokenOptions: Parameters<typeof buildNip98Token>[0] = {
			url,
			method,
			signer: options.signer,
		};
		if (body !== undefined) tokenOptions.body = body;
		headers.set('authorization', await buildNip98Token(tokenOptions));
	}
	if (body !== undefined) headers.set('content-type', 'application/json');
	const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env as Record<string, unknown>, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('admin worker', () => {
	it('serves the admin page without auth', async () => {
		const response = await call('GET', '/admin');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('Bot Admin');
	});

	it('rejects API calls without or with foreign credentials', async () => {
		expect((await call('GET', '/admin/api/bots')).status).toBe(401);
		expect((await call('GET', '/admin/api/bots', { signer: intruderSigner })).status).toBe(403);
	});

	it('lists bots with credential status for admins', async () => {
		const response = await call('GET', '/admin/api/bots', { signer: adminSigner });
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.bots[0].id).toBe('phrases');
		expect(data.bots[0].destinations[0]).toMatchObject({
			id: 'nostr',
			type: 'nostr',
			credential: { registered: false },
		});
	});

	it('registers a bot key and reflects it in the listing', async () => {
		const put = await call('PUT', '/admin/api/bots/phrases/destinations/nostr/credential', {
			signer: adminSigner,
			body: { key: botKey },
		});
		expect(put.status).toBe(200);
		const info = (await put.json()) as any;
		expect(info.npub).toMatch(/^npub1/);

		const list = (await (
			await call('GET', '/admin/api/bots', { signer: adminSigner })
		).json()) as any;
		expect(list.bots[0].destinations[0].credential).toMatchObject({
			registered: true,
			npub: info.npub,
			decryptable: true,
		});
	});

	it('rejects invalid keys with a clear error', async () => {
		const response = await call('PUT', '/admin/api/bots/phrases/destinations/nostr/credential', {
			signer: adminSigner,
			body: { key: 'not-a-key' },
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as any).error).toContain('Invalid secret key');
	});

	it('runs a bot in dry-run mode via NIP-98', async () => {
		await call('PUT', '/admin/api/bots/phrases/destinations/nostr/credential', {
			signer: adminSigner,
			body: { key: botKey },
		});
		const response = await call('POST', '/admin/api/bots/phrases/run?dryRun=1', {
			signer: adminSigner,
		});
		expect(response.status).toBe(200);
		const report = (await response.json()) as any;
		expect(report.botId).toBe('phrases');
		expect(report.destinations[0].posted).toHaveLength(1);
		expect(report.destinations[0].posted[0].results[0]).toMatchObject({
			target: 'dry-run',
			ok: true,
		});
	});

	it('accepts the manual trigger bearer token only on the run endpoint', async () => {
		await call('PUT', '/admin/api/bots/phrases/destinations/nostr/credential', {
			signer: adminSigner,
			body: { key: botKey },
		});
		const run = await call('POST', '/admin/api/bots/phrases/run?dryRun=1', {
			bearer: 'test-manual-token',
		});
		expect(run.status).toBe(200);

		const wrongToken = await call('POST', '/admin/api/bots/phrases/run?dryRun=1', {
			bearer: 'wrong-token',
		});
		expect(wrongToken.status).toBe(401);

		const otherRoute = await call('GET', '/admin/api/bots', { bearer: 'test-manual-token' });
		expect(otherRoute.status).toBe(401);
	});

	it('round-trips feeds while keeping row ids stable', async () => {
		const put = await call('PUT', '/admin/api/bots/phrases/feeds', {
			signer: adminSigner,
			body: { feeds: [{ url: 'https://a.example/feed' }, { url: 'https://b.example/feed' }] },
		});
		expect(put.status).toBe(200);

		const first = (await (
			await call('GET', '/admin/api/bots/phrases/feeds', { signer: adminSigner })
		).json()) as any;
		const idOfA = first.feeds.find((f: any) => f.url === 'https://a.example/feed').id;

		await call('PUT', '/admin/api/bots/phrases/feeds', {
			signer: adminSigner,
			body: {
				feeds: [
					{ url: 'https://a.example/feed', enabled: false },
					{ url: 'https://c.example/feed' },
				],
			},
		});
		const second = (await (
			await call('GET', '/admin/api/bots/phrases/feeds', { signer: adminSigner })
		).json()) as any;
		const rowA = second.feeds.find((f: any) => f.url === 'https://a.example/feed');
		expect(rowA.id).toBe(idOfA);
		expect(rowA.enabled).toBe(false);
		expect(second.feeds.map((f: any) => f.url)).not.toContain('https://b.example/feed');
	});

	it('stores and reports profile state', async () => {
		await call('PUT', '/admin/api/bots/phrases/destinations/nostr/credential', {
			signer: adminSigner,
			body: { key: botKey },
		});
		const put = await call('PUT', '/admin/api/bots/phrases/destinations/nostr/profile', {
			signer: adminSigner,
			body: { profile: { name: 'phrase bot' } },
		});
		expect(put.status).toBe(200);
		const { results } = (await put.json()) as any;
		// The relay is unreachable in tests: saved to D1, publish fails, stays unpublished.
		expect(results.profile.every((r: any) => r.ok === false)).toBe(true);

		const get = (await (
			await call('GET', '/admin/api/bots/phrases/destinations/nostr/profile', {
				signer: adminSigner,
			})
		).json()) as any;
		expect(get.profile).toEqual({ name: 'phrase bot' });
		expect(get.published.profile).toBeNull();
	});

	it('returns 404 for unknown bots', async () => {
		const response = await call('GET', '/admin/api/bots/nope/feeds', { signer: adminSigner });
		expect(response.status).toBe(404);
	});
});
