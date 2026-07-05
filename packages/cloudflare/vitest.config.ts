import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2026-06-01',
					d1Databases: ['DB'],
					bindings: {
						MASTER_KEY: 'test-master-key-0123456789abcdef',
						MANUAL_TRIGGER_TOKEN: 'test-manual-token',
					},
				},
			},
		},
	},
});
