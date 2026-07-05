import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { publishToRelays, publishToWebhooks } from './publish.js';

const event = finalizeEvent(
	{ kind: 1, content: 'hi', tags: [], created_at: 1_750_000_000 },
	generateSecretKey(),
);

describe('publishToRelays', () => {
	let rejections: unknown[];
	const onRejection = (reason: unknown) => rejections.push(reason);

	beforeEach(() => {
		rejections = [];
		process.on('unhandledRejection', onRejection);
	});
	afterEach(() => {
		process.off('unhandledRejection', onRejection);
	});

	it('resolves to ok:false for an unreachable relay without throwing or leaking rejections', async () => {
		const results = await publishToRelays(event, ['ws://127.0.0.1:1'], { timeoutMs: 300 });
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ target: 'ws://127.0.0.1:1', ok: false });
		// Let any late connect settlement fire before asserting no unhandled rejection.
		await new Promise((r) => setTimeout(r, 400));
		expect(rejections).toEqual([]);
	});
});

describe('publishToWebhooks', () => {
	it('reports HTTP failures as ok:false', async () => {
		const results = await publishToWebhooks(event, ['http://127.0.0.1:1/hook'], { timeoutMs: 300 });
		expect(results[0]!.ok).toBe(false);
	});
});
