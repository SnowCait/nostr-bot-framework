import { describe, expect, it } from 'vitest';
import { buildMetadata, buildRelayList, buildTextNote, replyTags } from './event.js';

describe('buildTextNote', () => {
	it('builds a kind 1 template', () => {
		const template = buildTextNote({ content: 'hi', createdAt: 123 });
		expect(template).toEqual({ kind: 1, content: 'hi', tags: [], created_at: 123 });
	});
});

describe('replyTags', () => {
	it('marks a direct reply as root', () => {
		const tags = replyTags({ id: 'e1', pubkey: 'p1' });
		expect(tags).toEqual([
			['e', 'e1', '', 'root', 'p1'],
			['p', 'p1'],
		]);
	});

	it('marks root and reply separately in a thread', () => {
		const tags = replyTags({ id: 'e2', pubkey: 'p2' }, { id: 'e1', pubkey: 'p1' });
		expect(tags[0]).toEqual(['e', 'e1', '', 'root', 'p1']);
		expect(tags[1]).toEqual(['e', 'e2', '', 'reply', 'p2']);
		expect(tags.slice(2)).toEqual([
			['p', 'p1'],
			['p', 'p2'],
		]);
	});
});

describe('buildMetadata', () => {
	it('builds a kind 0 with JSON content', () => {
		const template = buildMetadata({ name: 'bot', about: 'test' }, 123);
		expect(template.kind).toBe(0);
		expect(JSON.parse(template.content)).toEqual({ name: 'bot', about: 'test' });
	});
});

describe('buildRelayList', () => {
	it('builds kind 10002 r tags with read/write markers', () => {
		const template = buildRelayList(
			[
				{ url: 'wss://a.example' },
				{ url: 'wss://b.example', read: true },
				{ url: 'wss://c.example', write: true },
				{ url: 'wss://d.example', read: true, write: true },
			],
			123,
		);
		expect(template.kind).toBe(10002);
		expect(template.tags).toEqual([
			['r', 'wss://a.example'],
			['r', 'wss://b.example', 'read'],
			['r', 'wss://c.example', 'write'],
			['r', 'wss://d.example'],
		]);
	});
});
