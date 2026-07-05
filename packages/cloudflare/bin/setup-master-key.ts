#!/usr/bin/env node
// Sets up the MASTER_KEY that encrypts bot keys stored in D1.
// Runs directly with Node.js 24+ (built-in type stripping).
//
//   --local   Write a separate random key to ./.dev.vars for local dev only.
//   --remote  Register the production secret via `wrangler secret put MASTER_KEY`.
//             Paste a key from your password manager when prompted (a backup
//             then exists), or pass --generate to create and print one once.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const devVarsPath: string = join(process.cwd(), '.dev.vars');

function setupLocal(): number {
	const existing = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
	if (/^MASTER_KEY=/m.test(existing)) {
		console.log('.dev.vars already has a local MASTER_KEY, leaving it as-is.');
		return 0;
	}
	const localKey = randomBytes(32).toString('hex');
	const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
	writeFileSync(devVarsPath, `${prefix}MASTER_KEY=${localKey}\n`);
	console.log('Wrote a separate local dev key to .dev.vars (not for production).');
	return 0;
}

function putSecret(input?: string): number {
	const args = ['wrangler', 'secret', 'put', 'MASTER_KEY'];
	const result =
		input === undefined
			? spawnSync('npx', args, { stdio: 'inherit' })
			: spawnSync('npx', args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
	return result.status ?? 1;
}

function setupRemote(): number {
	if (process.argv.includes('--generate')) {
		const key = randomBytes(32).toString('hex');
		console.log('\nGenerated master key. SAVE IT IN YOUR PASSWORD MANAGER NOW —');
		console.log('if it is lost, encrypted bot keys in D1 cannot be recovered:\n');
		console.log(`  ${key}\n`);
		return putSecret(key);
	}
	console.log('\nPaste the master key from your password manager when wrangler prompts.');
	console.log('(Generate one there first, or run with --generate.)\n');
	return putSecret();
}

const local = process.argv.includes('--local');
const remote = process.argv.includes('--remote');
if (local === remote) {
	console.error('Usage: sns-bot-setup-master-key (--local | --remote) [--generate]');
	console.error('  --local   write a dev key to ./.dev.vars');
	console.error('  --remote  register the production secret via wrangler');
	process.exit(2);
}

process.exit(local ? setupLocal() : setupRemote());
