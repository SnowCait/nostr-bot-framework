import { describe, expect, it } from 'vitest';
import { parseFeed } from './rss.js';

const rss2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <item>
      <title><![CDATA[Hello & World]]></title>
      <link>https://example.com/posts/1</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[<p>Body</p>]]></description>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/posts/2</link>
      <pubDate>Tue, 02 Jun 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entry One</title>
    <id>urn:uuid:1</id>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://example.com/entries/1"/>
    <updated>2026-06-01T00:00:00Z</updated>
    <summary>Summary text</summary>
  </entry>
</feed>`;

const rdf = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/">
    <title>RDF Feed</title>
  </channel>
  <item rdf:about="https://example.com/items/1">
    <title>RDF Item</title>
    <link>https://example.com/items/1</link>
    <dc:date>2026-06-01T00:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

describe('parseFeed', () => {
	it('parses RSS 2.0 with CDATA and guid', () => {
		const items = parseFeed(rss2);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			id: 'post-1',
			title: 'Hello & World',
			link: 'https://example.com/posts/1',
			summary: '<p>Body</p>',
		});
		expect(items[0]!.publishedAt).toBe(Date.parse('Mon, 01 Jun 2026 00:00:00 GMT'));
		expect(items[1]!.id).toBe('https://example.com/posts/2');
	});

	it('parses Atom and prefers rel=alternate links', () => {
		const items = parseFeed(atom);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: 'urn:uuid:1',
			title: 'Entry One',
			link: 'https://example.com/entries/1',
			summary: 'Summary text',
		});
	});

	it('parses RSS 1.0 (RDF)', () => {
		const items = parseFeed(rdf);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: 'https://example.com/items/1',
			title: 'RDF Item',
		});
	});

	it('rejects unknown formats', () => {
		expect(() => parseFeed('<html></html>')).toThrow(/Unsupported feed format/);
	});
});
