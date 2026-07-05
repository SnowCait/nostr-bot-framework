import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
		MASTER_KEY: string;
		MANUAL_TRIGGER_TOKEN: string;
		TEST_MIGRATIONS: D1Migration[];
	}
}
