import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The integration hooks transform the module graph, run migrations, seed the
    // demonstration dataset, and boot Fastify. That exceeds the 10s default hook
    // timeout when the machine is briefly contended, which surfaced as an
    // intermittent failure rather than a real defect.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
