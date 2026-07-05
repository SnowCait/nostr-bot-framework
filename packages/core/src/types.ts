export interface SourceItem {
	id: string;
	content?: string;
	data?: unknown;
}

export interface BotContext {
	botId: string;
	env: unknown;
	state: StateStore;
	dryRun: boolean;
	log(message: string, detail?: unknown): void;
}

export interface DestinationContext extends BotContext {
	destinationId: string;
	getCredential(): Promise<string | null>;
}

export interface PublishResult {
	target: string;
	ok: boolean;
	remoteId?: string;
	error?: string;
}

export interface CredentialInfo {
	displayId: string;
}

export interface Destination {
	readonly id: string;
	readonly type: string;
	/**
	 * Publish one item. An empty array means the item was intentionally
	 * skipped and must be treated as consumed (it will not be retried).
	 */
	publish(item: SourceItem, ctx: DestinationContext): Promise<PublishResult[]>;
	validateCredential?(value: string): Promise<CredentialInfo>;
}

export type CredentialResolver = (
	botId: string,
	destination: Destination,
) => Promise<string | null>;

export interface PublishedEntry {
	itemId: string;
	remoteId?: string;
}

export interface StateStore {
	filterUnpublished(botId: string, destinationId: string, ids: string[]): Promise<string[]>;
	markPublished(botId: string, destinationId: string, entries: PublishedEntry[]): Promise<void>;
	get(botId: string, key: string): Promise<string | null>;
	set(botId: string, key: string, value: string): Promise<void>;
}

export interface Source {
	fetch(ctx: BotContext): Promise<SourceItem[]>;
	/** Behavior on the first run when nothing has been published yet. */
	readonly backfill?: 'skip' | 'post';
}

export interface BotDefinition {
	id: string;
	source: Source;
	destinations: Destination[];
	/** Matches ScheduledController.cron. A bot without cron runs on every trigger. */
	cron?: string;
	/** Max items published per destination per run. Default: 1. */
	maxPerRun?: number;
	/** Overrides source.backfill. 'skip' marks pre-existing items as consumed without posting. */
	backfill?: 'skip' | 'post';
	/** Re-post items from the beginning once all of them have been published. */
	repeat?: boolean;
	/** Item selection among unpublished ones. Default: 'ordered'. */
	selection?: 'ordered' | 'random';
}

export interface PostedItem {
	itemId: string;
	results: PublishResult[];
}

export interface DestinationReport {
	destinationId: string;
	posted: PostedItem[];
	skipped: number;
	errors: string[];
}

export interface BotReport {
	botId: string;
	startedAt: string;
	finishedAt: string;
	fetchedItems: number;
	destinations: DestinationReport[];
}
