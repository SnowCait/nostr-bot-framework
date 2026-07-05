import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { MemoryStateStore, type DestinationContext } from '@sns-bot-framework/core';
import { nostrDestination } from './destination.js';
import { buildTextNote } from './event.js';

const nsec = nip19.nsecEncode(generateSecretKey());

function context(
	credential: string | null,
	relays?: string[],
): DestinationContext & { logs: [string, unknown][] } {
	const logs: [string, unknown][] = [];
	return {
		botId: 'bot',
		destinationId: 'nostr',
		env: undefined,
		state: new MemoryStateStore(),
		dryRun: true,
		logs,
		log: (message, detail) => logs.push([message, detail]),
		getCredential: async () => credential,
		getRelays: async () => relays ?? null,
	};
}

describe('nostrDestination', () => {
	it('signs and reports events in dry-run mode without network access', async () => {
		const destination = nostrDestination({ relays: ['wss://relay.example'] });
		const ctx = context(nsec);
		const outcome = await destination.publish({ id: 'i1', content: 'hello' }, ctx);
		expect(outcome.ok).toBe(true);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]).toMatchObject({ target: 'dry-run', ok: true });
		expect(outcome.results[0]!.remoteId).toMatch(/^[0-9a-f]{64}$/);
		expect(outcome.remoteId).toMatch(/^[0-9a-f]{64}$/);
		expect(ctx.logs).toHaveLength(1);
	});

	it('resolves publish targets from ctx.getRelays over the code default', async () => {
		const destination = nostrDestination({ relays: ['wss://code.example'] });
		const ctx = context(nsec, ['wss://resolved.example']);
		await destination.publish({ id: 'i1', content: 'hi' }, ctx);
		expect(ctx.logs[0]![0]).toContain('wss://resolved.example');
		expect(ctx.logs[0]![0]).not.toContain('wss://code.example');
	});

	it('skips items when build returns null', async () => {
		const destination = nostrDestination({
			relays: ['wss://relay.example'],
			build: () => null,
		});
		const outcome = await destination.publish({ id: 'i1', content: 'x' }, context(nsec));
		expect(outcome).toEqual({ ok: true, results: [] });
	});

	it('supports multi-event builds', async () => {
		const destination = nostrDestination({
			relays: ['wss://relay.example'],
			build: (item) => [
				buildTextNote({ content: `${item.content} 1/2` }),
				buildTextNote({ content: `${item.content} 2/2` }),
			],
		});
		const outcome = await destination.publish({ id: 'i1', content: 'thread' }, context(nsec));
		expect(outcome.results).toHaveLength(2);
	});

	it('chains a thread with NIP-10 tags when thread is enabled', async () => {
		const destination = nostrDestination({
			relays: ['wss://relay.example'],
			thread: true,
			build: (item) => [
				buildTextNote({ content: `${item.content} 1/2` }),
				buildTextNote({ content: `${item.content} 2/2` }),
			],
		});
		const ctx = context(nsec);
		await destination.publish({ id: 'i1', content: 'thread' }, ctx);
		const first = ctx.logs[0]![1] as { id: string; pubkey: string; tags: string[][] };
		const second = ctx.logs[1]![1] as { tags: string[][] };
		expect(first.tags).toEqual([]);
		expect(second.tags).toContainEqual(['e', first.id, '', 'root', first.pubkey]);
		expect(second.tags).toContainEqual(['p', first.pubkey]);
	});

	it('fails clearly without a registered credential', async () => {
		const destination = nostrDestination({ relays: ['wss://relay.example'] });
		const outcome = await destination.publish({ id: 'i1', content: 'x' }, context(null));
		expect(outcome.ok).toBe(false);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]!.ok).toBe(false);
		expect(outcome.results[0]!.error).toContain('No Nostr key registered');
	});

	it('exposes credential validation with npub display ids', async () => {
		const destination = nostrDestination({ relays: [] });
		const info = await destination.validateCredential!(nsec);
		expect(info.displayId).toMatch(/^npub1/);
		await expect(destination.validateCredential!('bogus')).rejects.toThrow();
	});
});
