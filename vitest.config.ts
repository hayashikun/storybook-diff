import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Longer, because pipeline.test.ts starts Chromium and renders
    testTimeout: 60_000,
  },
})
