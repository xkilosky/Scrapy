import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // Tests of the pages ask for a browser-like environment themselves, in their first line.
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
  },
});
