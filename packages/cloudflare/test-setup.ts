import { applyD1Migrations, env } from 'cloudflare:test';

// Applies the framework's bundled migrations (the same SQL shipped to users)
// to the test database before any test runs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
