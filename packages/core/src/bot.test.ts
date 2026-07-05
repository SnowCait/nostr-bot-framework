import { describe, expect, it } from 'vitest';
import { defineBot, runBot } from './bot.js';
import { MemoryStateStore } from './state.js';
import { staticListSource } from './source.js';
import type { Destination, PublishOutcome, SourceItem } from './types.js';

function mockDestination(
	overrides: Partial<Pick<Destination, 'id' | 'type'>> & {
		result?: (item: SourceItem) => PublishOutcome;
	} = {},
): Destination & { published: SourceItem[] } {
	const published: SourceItem[] = [];
	return {
		id: overrides.id ?? 'mock',
		type: overrides.type ?? 'mock',
		published,
		async publish(item): Promise<PublishOutcome> {
			published.push(item);
			return (
				overrides.result?.(item) ?? {
					ok: true,
					remoteId: `r-${item.id}`,
					results: [{ target: 'mock', ok: true }],
				}
			);
		},
	};
}

describe('defineBot', () => {
	it('rejects invalid ids and duplicate destinations', () => {
		const source = staticListSource(['a']);
		const dest = mockDestination();
		expect(() => defineBot({ id: 'bad id', source, destinations: [dest] })).toThrow();
		expect(() => defineBot({ id: 'ok', source, destinations: [dest, mockDestination()] })).toThrow(
			/duplicate destination/,
		);
	});
});

describe('runBot', () => {
	it('publishes one item per run by default and dedupes across runs', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({
			id: 'phrases',
			source: staticListSource(['one', 'two']),
			destinations: [dest],
		});

		const first = await runBot(bot, { state });
		expect(first.destinations[0]!.posted).toHaveLength(1);
		expect(dest.published.map((i) => i.content)).toEqual(['one']);

		await runBot(bot, { state });
		expect(dest.published.map((i) => i.content)).toEqual(['one', 'two']);
	});

	it('wraps around with repeat once all items are consumed', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({
			id: 'loop',
			source: staticListSource(['a', 'b']),
			destinations: [dest],
			repeat: true,
		});
		for (let i = 0; i < 3; i++) await runBot(bot, { state });
		expect(dest.published.map((i) => i.content)).toEqual(['a', 'b', 'a']);
	});

	it('retries only failed destinations', async () => {
		const state = new MemoryStateStore();
		let failing = true;
		const ok = mockDestination({ id: 'ok' });
		const flaky = mockDestination({
			id: 'flaky',
			result: () =>
				failing
					? { ok: false, results: [{ target: 'relay', ok: false, error: 'down' }] }
					: { ok: true, results: [{ target: 'relay', ok: true }] },
		});
		const bot = defineBot({
			id: 'multi',
			source: staticListSource(['x']),
			destinations: [ok, flaky],
		});

		const first = await runBot(bot, { state });
		expect(first.destinations[1]!.errors).toHaveLength(1);

		failing = false;
		await runBot(bot, { state });
		expect(ok.published).toHaveLength(1);
		expect(flaky.published).toHaveLength(2);
	});

	it('treats an ok skip (empty results) as consumed', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination({ result: () => ({ ok: true, results: [] }) });
		const bot = defineBot({
			id: 'skipper',
			source: staticListSource(['a']),
			destinations: [dest],
		});
		await runBot(bot, { state });
		await runBot(bot, { state });
		expect(dest.published).toHaveLength(1);
	});

	it('does not consume an item when the outcome is not ok', async () => {
		const state = new MemoryStateStore();
		let failing = true;
		const dest = mockDestination({
			result: () =>
				failing
					? {
							ok: false,
							results: [
								{ target: 'a', ok: true },
								{ target: 'b', ok: false },
							],
						}
					: { ok: true, results: [{ target: 'a', ok: true }] },
		});
		const bot = defineBot({ id: 'partial', source: staticListSource(['x']), destinations: [dest] });

		const first = await runBot(bot, { state });
		expect(first.destinations[0]!.errors).toHaveLength(1);
		expect(dest.published).toHaveLength(1);

		failing = false;
		await runBot(bot, { state });
		expect(dest.published).toHaveLength(2); // retried because it was never consumed
	});

	it('backfill skip consumes pre-existing items without posting', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const items = [
			{ id: 'old-1', content: 'old 1' },
			{ id: 'old-2', content: 'old 2' },
		];
		const source = {
			backfill: 'skip' as const,
			fetch: async () => [...items],
		};
		const bot = defineBot({ id: 'rss', source, destinations: [dest] });

		const first = await runBot(bot, { state });
		expect(first.destinations[0]!.skipped).toBe(2);
		expect(dest.published).toHaveLength(0);

		items.push({ id: 'new-1', content: 'new 1' });
		await runBot(bot, { state });
		expect(dest.published.map((i) => i.id)).toEqual(['new-1']);
	});

	it('respects maxPerRun', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({
			id: 'burst',
			source: staticListSource(['1', '2', '3']),
			destinations: [dest],
			maxPerRun: 2,
		});
		await runBot(bot, { state });
		expect(dest.published).toHaveLength(2);
	});

	it('passes credentials through the destination context', async () => {
		const state = new MemoryStateStore();
		let seen: string | null = null;
		const dest: Destination = {
			id: 'cred',
			type: 'cred',
			async publish(_item, ctx): Promise<PublishOutcome> {
				seen = await ctx.getCredential();
				return { ok: true, results: [{ target: 't', ok: true }] };
			},
		};
		const bot = defineBot({
			id: 'creds',
			source: staticListSource(['a']),
			destinations: [dest],
		});
		await runBot(bot, {
			state,
			credentials: async (botId, destination) => `${botId}/${destination.id}`,
		});
		expect(seen).toBe('creds/cred');
	});

	it('skips a destination when the run lock cannot be acquired', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({ id: 'locked', source: staticListSource(['a']), destinations: [dest] });
		const report = await runBot(bot, {
			state,
			lock: { acquire: async () => false, release: async () => {} },
		});
		expect(dest.published).toHaveLength(0);
		expect(report.destinations[0]!.errors[0]).toContain('lock');
	});

	it('releases the run lock after running', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({ id: 'lockrel', source: staticListSource(['a']), destinations: [dest] });
		let released = 0;
		await runBot(bot, {
			state,
			lock: { acquire: async () => true, release: async () => void released++ },
		});
		expect(dest.published).toHaveLength(1);
		expect(released).toBe(1);
	});

	it('reports source failures per destination', async () => {
		const state = new MemoryStateStore();
		const dest = mockDestination();
		const bot = defineBot({
			id: 'broken',
			source: {
				fetch: async () => {
					throw new Error('boom');
				},
			},
			destinations: [dest],
		});
		const report = await runBot(bot, { state });
		expect(report.destinations[0]!.errors[0]).toContain('boom');
	});
});
