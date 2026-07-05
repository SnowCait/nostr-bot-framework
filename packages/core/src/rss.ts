import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
	id: string;
	title: string;
	link: string;
	summary: string;
	publishedAt: number | null;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	trimValues: true,
});

function text(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') {
		const inner = (value as Record<string, unknown>)['#text'];
		return inner === undefined ? '' : String(inner);
	}
	return String(value);
}

function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function parseDate(value: string): number | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
}

function atomLink(value: unknown): string {
	const links = toArray(value as Record<string, unknown> | Record<string, unknown>[]);
	const alternate = links.find((l) => {
		const rel = l['@_rel'];
		return rel === undefined || rel === 'alternate';
	});
	const link = alternate ?? links[0];
	return link ? String(link['@_href'] ?? '') : '';
}

export function parseFeed(xml: string): FeedItem[] {
	const doc = parser.parse(xml) as Record<string, any>;
	const items: FeedItem[] = [];

	if (doc.rss?.channel) {
		for (const item of toArray<any>(doc.rss.channel.item)) {
			const title = text(item.title);
			const link = text(item.link);
			const guid = text(item.guid);
			items.push({
				id: guid || link || title,
				title,
				link,
				summary: text(item.description),
				publishedAt: parseDate(text(item.pubDate)),
			});
		}
	} else if (doc.feed) {
		for (const entry of toArray<any>(doc.feed.entry)) {
			const title = text(entry.title);
			const link = atomLink(entry.link);
			const id = text(entry.id);
			items.push({
				id: id || link || title,
				title,
				link,
				summary: text(entry.summary) || text(entry.content),
				publishedAt: parseDate(text(entry.published) || text(entry.updated)),
			});
		}
	} else if (doc['rdf:RDF']) {
		for (const item of toArray<any>(doc['rdf:RDF'].item)) {
			const title = text(item.title);
			const link = text(item.link);
			items.push({
				id: text(item['@_rdf:about']) || link || title,
				title,
				link,
				summary: text(item.description),
				publishedAt: parseDate(text(item['dc:date'])),
			});
		}
	} else {
		throw new Error('Unsupported feed format: expected RSS 2.0, Atom, or RSS 1.0');
	}

	return items.filter((item) => item.id !== '');
}
