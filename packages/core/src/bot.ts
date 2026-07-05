import type {
	BotContext,
	BotDefinition,
	BotReport,
	CredentialResolver,
	Destination,
	DestinationContext,
	DestinationReport,
	RelayResolver,
	RunLock,
	SourceItem,
	StateStore,
} from './types.js';

export function defineBot(definition: BotDefinition): BotDefinition {
	if (!definition.id) throw new Error('Bot id is required');
	if (!/^[a-zA-Z0-9_-]+$/.test(definition.id)) {
		throw new Error(`Bot id must match [a-zA-Z0-9_-]+: ${definition.id}`);
	}
	if (definition.destinations.length === 0) {
		throw new Error(`Bot ${definition.id} has no destinations`);
	}
	const ids = new Set<string>();
	for (const destination of definition.destinations) {
		if (ids.has(destination.id)) {
			throw new Error(`Bot ${definition.id} has duplicate destination id: ${destination.id}`);
		}
		ids.add(destination.id);
	}
	return definition;
}

export interface RunOptions {
	state: StateStore;
	env?: unknown;
	credentials?: CredentialResolver;
	relays?: RelayResolver;
	lock?: RunLock;
	dryRun?: boolean;
	log?: (message: string, detail?: unknown) => void;
}

function pick(ids: string[], count: number, selection: 'ordered' | 'random'): string[] {
	if (selection === 'ordered') return ids.slice(0, count);
	const pool = [...ids];
	const picked: string[] = [];
	while (picked.length < count && pool.length > 0) {
		const index = Math.floor(Math.random() * pool.length);
		picked.push(...pool.splice(index, 1));
	}
	return picked;
}

async function runDestination(
	bot: BotDefinition,
	destination: Destination,
	items: SourceItem[],
	ctx: BotContext,
	options: RunOptions,
): Promise<DestinationReport> {
	const report: DestinationReport = {
		destinationId: destination.id,
		posted: [],
		skipped: 0,
		errors: [],
	};
	const { state } = ctx;
	const { credentials, relays } = options;
	const dctx: DestinationContext = {
		...ctx,
		destinationId: destination.id,
		getCredential: () => (credentials ? credentials(bot.id, destination) : Promise.resolve(null)),
		getRelays: () => (relays ? relays(bot.id, destination) : Promise.resolve(null)),
	};

	if (options.lock && !(await options.lock.acquire(bot.id, destination.id))) {
		report.errors.push('skipped: another run holds the lock');
		return report;
	}
	try {
		return await runDestinationInner(bot, destination, items, dctx, report);
	} finally {
		if (options.lock) await options.lock.release(bot.id, destination.id);
	}
}

async function runDestinationInner(
	bot: BotDefinition,
	destination: Destination,
	items: SourceItem[],
	dctx: DestinationContext,
	report: DestinationReport,
): Promise<DestinationReport> {
	const state = dctx.state;
	const backfill = bot.backfill ?? bot.source.backfill ?? 'post';
	const initKey = `init:${destination.id}`;
	if (backfill === 'skip' && (await state.get(bot.id, initKey)) === null) {
		if (items.length > 0) {
			await state.markPublished(
				bot.id,
				destination.id,
				items.map((item) => ({ itemId: item.id })),
			);
		}
		await state.set(bot.id, initKey, String(Date.now()));
		report.skipped = items.length;
		dctx.log(`initialized ${destination.id}: marked ${items.length} existing items as consumed`);
		return report;
	}

	// With repeat, item ids are namespaced by a per-destination cycle counter
	// so the same list can be re-published after it has been exhausted.
	const cycleKey = `cycle:${destination.id}`;
	let cycle = bot.repeat ? Number((await state.get(bot.id, cycleKey)) ?? '0') : null;
	const stateId = (itemId: string): string => (cycle === null ? itemId : `${itemId}#${cycle}`);

	let unpublished = await state.filterUnpublished(
		bot.id,
		destination.id,
		items.map((item) => stateId(item.id)),
	);
	if (cycle !== null && unpublished.length === 0 && items.length > 0) {
		cycle += 1;
		await state.set(bot.id, cycleKey, String(cycle));
		unpublished = items.map((item) => stateId(item.id));
	}
	report.skipped = items.length - unpublished.length;

	const unpublishedSet = new Set(unpublished);
	const candidates = items.filter((item) => unpublishedSet.has(stateId(item.id)));
	const byId = new Map(candidates.map((item) => [stateId(item.id), item] as const));
	const selectedIds = pick(
		candidates.map((item) => stateId(item.id)),
		bot.maxPerRun ?? 1,
		bot.selection ?? 'ordered',
	);

	for (const id of selectedIds) {
		const item = byId.get(id)!;
		try {
			const outcome = await destination.publish(item, dctx);
			if (outcome.results.length === 0 && outcome.ok) {
				// Intentional skip: consume the item without posting.
				await state.markPublished(bot.id, destination.id, [{ itemId: id }]);
				report.skipped += 1;
				continue;
			}
			if (outcome.ok) {
				const entry: { itemId: string; remoteId?: string } = { itemId: id };
				if (outcome.remoteId !== undefined) entry.remoteId = outcome.remoteId;
				await state.markPublished(bot.id, destination.id, [entry]);
			}
			report.posted.push({ itemId: id, results: outcome.results });
			if (!outcome.ok) {
				report.errors.push(
					`item ${id}: not fully published (${outcome.results.map((r) => r.error ?? 'ok').join('; ')})`,
				);
			}
		} catch (error) {
			report.errors.push(`item ${id}: ${String(error)}`);
		}
	}
	return report;
}

export async function runBot(bot: BotDefinition, options: RunOptions): Promise<BotReport> {
	const startedAt = new Date().toISOString();
	const log =
		options.log ??
		((message: string, detail?: unknown) =>
			detail === undefined
				? console.log(`[${bot.id}] ${message}`)
				: console.log(`[${bot.id}] ${message}`, detail));
	const ctx: BotContext = {
		botId: bot.id,
		env: options.env,
		state: options.state,
		dryRun: options.dryRun ?? false,
		log,
	};

	const destinations: DestinationReport[] = [];
	let items: SourceItem[] = [];
	try {
		items = await bot.source.fetch(ctx);
	} catch (error) {
		log('source fetch failed', String(error));
		return {
			botId: bot.id,
			startedAt,
			finishedAt: new Date().toISOString(),
			fetchedItems: 0,
			destinations: bot.destinations.map((destination) => ({
				destinationId: destination.id,
				posted: [],
				skipped: 0,
				errors: [`source fetch failed: ${String(error)}`],
			})),
		};
	}

	for (const destination of bot.destinations) {
		destinations.push(await runDestination(bot, destination, items, ctx, options));
	}

	return {
		botId: bot.id,
		startedAt,
		finishedAt: new Date().toISOString(),
		fetchedItems: items.length,
		destinations,
	};
}
