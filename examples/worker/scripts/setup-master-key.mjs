#!/usr/bin/env node
// Registers the MASTER_KEY Workers Secret and prepares .dev.vars for local dev.
//
// Default: prompts for a key you generated and saved in your password manager,
// so a backup always exists. With --generate: generates a key, prints it once
// so you can save it, then registers it.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const devVarsPath = join(root, '.dev.vars');

function ensureDevVars() {
	const existing = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
	if (/^MASTER_KEY=/m.test(existing)) {
		console.log('.dev.vars already has a local MASTER_KEY, leaving it as-is.');
		return;
	}
	const localKey = randomBytes(32).toString('hex');
	const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
	writeFileSync(devVarsPath, `${prefix}MASTER_KEY=${localKey}\n`);
	console.log('Wrote a separate local dev key to .dev.vars (not for production).');
}

function putSecret(input) {
	const args = ['wrangler', 'secret', 'put', 'MASTER_KEY'];
	const result = input
		? spawnSync('npx', args, { cwd: root, input, stdio: ['pipe', 'inherit', 'inherit'] })
		: spawnSync('npx', args, { cwd: root, stdio: 'inherit' });
	return result.status ?? 1;
}

ensureDevVars();

if (process.argv.includes('--generate')) {
	const key = randomBytes(32).toString('hex');
	console.log('\nGenerated master key. SAVE IT IN YOUR PASSWORD MANAGER NOW —');
	console.log('if it is lost, encrypted bot keys in D1 cannot be recovered:\n');
	console.log(`  ${key}\n`);
	process.exit(putSecret(key));
} else {
	console.log('\nPaste the master key from your password manager when wrangler prompts.');
	console.log('(Generate one there first, or run with --generate.)\n');
	process.exit(putSecret());
}
