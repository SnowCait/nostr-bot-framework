#!/usr/bin/env node
// Copies the framework's bundled D1 migrations into the app's migrations
// directory so they can be applied with `wrangler d1 migrations apply`.
// Existing files with the same name are left untouched (error on content drift).

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled to dist/bin/migrations.js, so the package root is two levels up.
const sourceDir: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function targetDir(): string {
	const flagIndex = process.argv.indexOf('--dir');
	const dir = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
	return join(process.cwd(), dir ?? 'migrations');
}

const dest = targetDir();
mkdirSync(dest, { recursive: true });

const files = readdirSync(sourceDir).filter((name) => name.endsWith('.sql'));
let copied = 0;
let skipped = 0;
for (const name of files) {
	const from = join(sourceDir, name);
	const to = join(dest, name);
	const content = readFileSync(from, 'utf8');
	if (existsSync(to)) {
		if (readFileSync(to, 'utf8') !== content) {
			console.error(
				`Refusing to overwrite ${name}: it differs from the framework's version. ` +
					`Resolve the difference manually.`,
			);
			process.exit(1);
		}
		skipped += 1;
		continue;
	}
	writeFileSync(to, content);
	copied += 1;
}

console.log(`Migrations synced to ${dest} (${copied} copied, ${skipped} already present).`);
console.log('Apply them with: wrangler d1 migrations apply <DB_NAME> --local | --remote');
