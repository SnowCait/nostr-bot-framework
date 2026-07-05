import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { MemoryStateStore, type DestinationContext } from '@sns-bot-framework/core';
import { nostrDestination } from '../src/destination.js';
import { buildTextNote } from '../src/event.js';

const nsec = nip19.nsecEncode(generateSecretKey());

function context(credential: string | null): DestinationContext & { logs: unknown[] } {
	const logs: unknown[] = [];
	return {
		botId: 'bot',
		destinationId: 'nostr',
		env: undefined,
		state: new MemoryStateStore(),
		dryRun: true,
		logs,
		log: (message, detail) => logs.push([message, detail]),
		getCredential: async () => credential,
	};
}

describe('nostrDestination', () => {
	it('signs and reports events in dry-run mode without network access', async () => {
		const destination = nostrDestination({ relays: ['wss://relay.example'] });
		const ctx = context(nsec);
		const results = await destination.publish({ id: 'i1', content: 'hello' }, ctx);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ target: 'dry-run', ok: true });
		expect(results[0]!.remoteId).toMatch(/^[0-9a-f]{64}$/);
		expect(ctx.logs).toHaveLength(1);
	});

	it('skips items when build returns null', async () => {
		const destination = nostrDestination({
			relays: ['wss://relay.example'],
			build: () => null,
		});
		const results = await destination.publish({ id: 'i1', content: 'x' }, context(nsec));
		expect(results).toEqual([]);
	});

	it('supports multi-event builds', async () => {
		const destination = nostrDestination({
			relays: ['wss://relay.example'],
			build: (item) => [
				buildTextNote({ content: `${item.content} 1/2` }),
				buildTextNote({ content: `${item.content} 2/2` }),
			],
		});
		const results = await destination.publish({ id: 'i1', content: 'thread' }, context(nsec));
		expect(results).toHaveLength(2);
	});

	it('fails clearly without a registered credential', async () => {
		const destination = nostrDestination({ relays: ['wss://relay.example'] });
		const results = await destination.publish({ id: 'i1', content: 'x' }, context(null));
		expect(results).toHaveLength(1);
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.error).toContain('No Nostr key registered');
	});

	it('exposes credential validation with npub display ids', async () => {
		const destination = nostrDestination({ relays: [] });
		const info = await destination.validateCredential!(nsec);
		expect(info.displayId).toMatch(/^npub1/);
		await expect(destination.validateCredential!('bogus')).rejects.toThrow();
	});
});
