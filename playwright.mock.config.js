import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  outputDir: 'tests/output/playwright',
  use: {
    baseURL: 'http://localhost:1421',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mock-desktop', use: { ...devices['Desktop'] } },
  ],
  webServer: {
    command: 'node tests/e2e/test-server.js',
    port: 1421,
    timeout: 15_000,
    reuseExistingServer: !process.env.CI,
  },
});
