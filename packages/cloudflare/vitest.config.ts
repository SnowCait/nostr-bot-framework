import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrations = await readD1Migrations(migrationsDir);

export default defineWorkersConfig({
	test: {
		setupFiles: ['./test-setup.ts'],
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2026-06-01',
					d1Databases: ['DB'],
					bindings: {
						MASTER_KEY: 'test-master-key-0123456789abcdef',
						MANUAL_TRIGGER_TOKEN: 'test-manual-token',
						TEST_MIGRATIONS: migrations,
					},
				},
			},
		},
	},
});
