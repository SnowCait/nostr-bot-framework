// Browser-side admin logic. Bundled to a string by scripts/build-admin-client.mjs
// and injected into the page shell. Type-checked via tsconfig.client.json (DOM lib).
import { HTTPAuth } from 'nostr-tools/kinds';
import { bytesToHex } from 'nostr-tools/utils';

interface Nip07 {
	getPublicKey(): Promise<string>;
	signEvent(event: {
		kind: number;
		created_at: number;
		tags: string[][];
		content: string;
	}): Promise<{ [k: string]: unknown }>;
}

declare global {
	interface Window {
		nostr?: Nip07;
	}
}

type Json = Record<string, unknown>;

const BASE = location.pathname.replace(/\/$/, '');

// SHA-256 via the browser's native WebCrypto (no bundled crypto dependency);
// bytesToHex is reused from nostr-tools for the hex encoding.
async function sha256hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return bytesToHex(new Uint8Array(digest));
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
	const url = location.origin + BASE + path;
	const tags: string[][] = [
		['u', url],
		['method', method],
	];
	const payload = body === undefined ? undefined : JSON.stringify(body);
	if (payload) tags.push(['payload', await sha256hex(payload)]);
	const event = await window.nostr!.signEvent({
		kind: HTTPAuth,
		created_at: Math.floor(Date.now() / 1000),
		tags,
		content: '',
	});
	const headers: Record<string, string> = { authorization: 'Nostr ' + btoa(JSON.stringify(event)) };
	if (payload) headers['content-type'] = 'application/json';
	const init: RequestInit = { method, headers };
	if (payload !== undefined) init.body = payload;
	const response = await fetch(url, init);
	const text = await response.text();
	let data: any = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text };
	}
	if (!response.ok) {
		throw new Error((data && data.error) || `${method} ${path} failed: HTTP ${response.status}`);
	}
	return data;
}

type Attrs = Record<string, string | ((event: Event) => void)>;

function el(tag: string, attrs: Attrs = {}, children: Node[] = []): HTMLElement {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key === 'text' && typeof value === 'string') node.textContent = value;
		else if (key.startsWith('on') && typeof value === 'function')
			node.addEventListener(key.slice(2), value as EventListener);
		else if (typeof value === 'string') node.setAttribute(key, value);
	}
	for (const child of children) node.append(child);
	return node;
}

function note(target: HTMLElement, message: string, ok: boolean): void {
	target.textContent = message;
	target.className = 'status ' + (ok ? 'ok' : 'error');
}

function linesOf(textarea: HTMLTextAreaElement): string[] {
	return textarea.value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

function renderListEditor(
	container: HTMLElement,
	title: string,
	hint: string,
	load: (t: HTMLTextAreaElement) => Promise<void>,
	save: (t: HTMLTextAreaElement) => Promise<void>,
): void {
	const textarea = el('textarea', { placeholder: hint }) as HTMLTextAreaElement;
	const status = el('div', { class: 'status' });
	const saveButton = el('button', {
		text: 'Save',
		onclick: async () => {
			try {
				await save(textarea);
				note(status, 'Saved.', true);
			} catch (e) {
				note(status, String(e), false);
			}
		},
	});
	const reloadButton = el('button', {
		text: 'Reload',
		onclick: () => load(textarea).catch((e) => note(status, String(e), false)),
	});
	container.append(
		el('h3', { text: title }),
		textarea,
		el('div', {}, [saveButton, reloadButton]),
		status,
	);
	load(textarea).catch((e) => note(status, String(e), false));
}

function renderDestination(container: HTMLElement, bot: any, dest: any): void {
	const section = el('section');
	section.append(el('h3', { text: `Destination: ${dest.id} (${dest.type})` }));
	const status = el('div', { class: 'status' });
	const credStatus = el('div', { class: 'status' });
	const cred = dest.credential || {};
	credStatus.textContent = cred.registered
		? `Key registered: ${cred.npub}` +
			(cred.decryptable === false ? ' — CANNOT DECRYPT, re-register!' : '')
		: 'No key registered.';
	if (cred.decryptable === false) credStatus.className = 'status error';
	const keyInput = el('input', {
		type: 'password',
		placeholder: 'nsec1... or 64-char hex (write-only)',
	}) as HTMLInputElement;
	const registerButton = el('button', {
		text: 'Register key',
		onclick: async () => {
			try {
				const result = await api('PUT', `/api/bots/${bot.id}/destinations/${dest.id}/credential`, {
					key: keyInput.value,
				});
				keyInput.value = '';
				note(credStatus, `Registered: ${result.npub}`, true);
			} catch (e) {
				note(credStatus, String(e), false);
			}
		},
	});
	const deleteButton = el('button', {
		text: 'Delete key',
		onclick: async () => {
			if (!confirm(`Delete the key for ${bot.id}/${dest.id}?`)) return;
			try {
				await api('DELETE', `/api/bots/${bot.id}/destinations/${dest.id}/credential`);
				note(credStatus, 'Deleted.', true);
			} catch (e) {
				note(credStatus, String(e), false);
			}
		},
	});
	section.append(credStatus, keyInput, el('div', {}, [registerButton, deleteButton]));

	if (dest.type === 'nostr') {
		const profileArea = el('textarea', {
			placeholder: '{"name": "my bot", "about": "..."}',
		}) as HTMLTextAreaElement;
		const relaysArea = el('textarea', {
			placeholder: 'wss://relay.example.com\nwss://another.example.com read',
		}) as HTMLTextAreaElement;
		const profileStatus = el('div', { class: 'status' });
		const loadProfile = async () => {
			const data = await api('GET', `/api/bots/${bot.id}/destinations/${dest.id}/profile`);
			if (data.profile) profileArea.value = JSON.stringify(data.profile, null, 2);
			if (data.relays)
				relaysArea.value = data.relays
					.map(
						(r: any) =>
							r.url + (r.read && !r.write ? ' read' : '') + (r.write && !r.read ? ' write' : ''),
					)
					.join('\n');
			const pending: string[] = [];
			if (data.published && data.published.profile === null && data.profile) pending.push('kind 0');
			if (data.published && data.published.relays === null && data.relays)
				pending.push('kind 10002');
			note(
				profileStatus,
				pending.length ? `Unpublished changes: ${pending.join(', ')}` : 'Loaded.',
				pending.length === 0,
			);
		};
		const saveProfile = async () => {
			const body: Json = {};
			if (profileArea.value.trim()) body.profile = JSON.parse(profileArea.value);
			if (relaysArea.value.trim())
				body.relays = linesOf(relaysArea).map((line) => {
					const [url, flag] = line.split(/\s+/);
					return { url, read: flag === 'read' || !flag, write: flag === 'write' || !flag };
				});
			const result = await api('PUT', `/api/bots/${bot.id}/destinations/${dest.id}/profile`, body);
			note(profileStatus, `Saved & published: ${JSON.stringify(result.results)}`, true);
		};
		section.append(
			el('h3', { text: 'Profile (kind 0, JSON)' }),
			profileArea,
			el('h3', { text: 'Relay list (kind 10002, one per line: url [read|write])' }),
			relaysArea,
			el('div', {}, [
				el('button', {
					text: 'Save & publish',
					onclick: () => saveProfile().catch((e) => note(profileStatus, String(e), false)),
				}),
				el('button', {
					text: 'Re-publish stored events',
					onclick: async () => {
						try {
							const r = await api(
								'POST',
								`/api/bots/${bot.id}/destinations/${dest.id}/profile/republish`,
								{},
							);
							note(profileStatus, `Re-published: ${JSON.stringify(r.results)}`, true);
						} catch (e) {
							note(profileStatus, String(e), false);
						}
					},
				}),
				el('button', {
					text: 'Reload',
					onclick: () => loadProfile().catch((e) => note(profileStatus, String(e), false)),
				}),
			]),
			profileStatus,
		);
		loadProfile().catch(() => note(profileStatus, 'No stored profile yet.', true));
	}
	section.append(status);
	container.append(section);
}

function renderBot(bot: any): void {
	const section = el('section');
	section.append(el('h2', { text: bot.id + (bot.cron ? ` — cron: ${bot.cron}` : '') }));
	const runStatus = el('div', { class: 'status' });
	const dryRun = el('input', { type: 'checkbox', id: `dry-${bot.id}` }) as HTMLInputElement;
	section.append(
		el('div', {}, [
			el('button', {
				text: 'Run now',
				onclick: async () => {
					runStatus.textContent = 'Running...';
					try {
						const report = await api(
							'POST',
							`/api/bots/${bot.id}/run${dryRun.checked ? '?dryRun=1' : ''}`,
							{},
						);
						note(runStatus, JSON.stringify(report, null, 2), true);
					} catch (e) {
						note(runStatus, String(e), false);
					}
				},
			}),
			dryRun,
			el('label', { for: `dry-${bot.id}`, text: ' dry-run' }),
		]),
		runStatus,
	);

	renderListEditor(
		section,
		'Feeds (D1, one URL per line, prefix # to disable)',
		'https://example.com/feed.xml',
		async (textarea) => {
			const data = await api('GET', `/api/bots/${bot.id}/feeds`);
			textarea.value = data.feeds.map((f: any) => (f.enabled ? '' : '# ') + f.url).join('\n');
		},
		async (textarea) => {
			const feeds = linesOf(textarea).map((line) =>
				line.startsWith('#')
					? { url: line.replace(/^#\s*/, ''), enabled: false }
					: { url: line, enabled: true },
			);
			await api('PUT', `/api/bots/${bot.id}/feeds`, { feeds });
		},
	);

	renderListEditor(
		section,
		'Phrases (D1, one per line, prefix # to disable)',
		'Hello, Nostr!',
		async (textarea) => {
			const data = await api('GET', `/api/bots/${bot.id}/phrases`);
			textarea.value = data.phrases.map((p: any) => (p.enabled ? '' : '# ') + p.content).join('\n');
		},
		async (textarea) => {
			const phrases = linesOf(textarea).map((line) =>
				line.startsWith('#')
					? { content: line.replace(/^#\s*/, ''), enabled: false }
					: { content: line, enabled: true },
			);
			await api('PUT', `/api/bots/${bot.id}/phrases`, { phrases });
		},
	);

	for (const dest of bot.destinations) renderDestination(section, bot, dest);
	document.getElementById('bots')!.append(section);
}

async function start(): Promise<void> {
	if (!window.nostr) {
		alert('A NIP-07 extension (e.g. nos2x, Alby) is required.');
		return;
	}
	const pubkey = await window.nostr.getPublicKey();
	document.getElementById('whoami')!.textContent = `Signed in as ${pubkey.slice(0, 16)}…`;
	document.getElementById('bots')!.replaceChildren();
	const data = await api('GET', '/api/bots');
	for (const bot of data.bots) renderBot(bot);
}

document.getElementById('login')!.addEventListener('click', () => start().catch((e) => alert(e)));
