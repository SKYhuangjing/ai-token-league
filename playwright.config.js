import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 1,
  outputDir: 'tests/output/playwright',
  use: {
    baseURL: 'http://localhost:1420',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop'] } },
  ],
  webServer: {
    command: 'npx tauri dev --no-watch',
    port: 1420,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
