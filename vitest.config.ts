import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Frontend test runner.
 *
 * Kept separate from `vite.config.js` so the dev-server middleware (ORT asset
 * serving, API proxy) never participates in tests.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    pool: 'forks',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Styles are presentation-only here; the suite asserts on tokens/structure,
    // not on computed Tailwind output.
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
