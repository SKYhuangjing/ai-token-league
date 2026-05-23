import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/renderer/**/*.test.js'],
    globals: true,
    setupFiles: ['tests/renderer/setup.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'tests/output/coverage',
      include: ['src/desktop/renderer.js', 'src/desktop/renderer-helpers.js', 'src/desktop/renderer-data.js', 'src/desktop/renderer-components.js', 'src/shared/**/*.js'],
    },
  },
  bench: {
    include: ['tests/renderer/**/*.bench.js'],
  },
});
