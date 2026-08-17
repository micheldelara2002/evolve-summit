import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'https://share--evolve-summit.base44.app';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'test-results/html', open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    { name: 'manager', dependencies: ['setup'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/manager.json' }, grep: /@manager/ },
    { name: 'staff', dependencies: ['setup'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/staff.json' }, grep: /@staff/ },
    { name: 'participant', dependencies: ['setup'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/participant.json' }, grep: /@participant/ },
    { name: 'speaker', dependencies: ['setup'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/speaker.json' }, grep: /@speaker/ },
    { name: 'partner', dependencies: ['setup'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/partner.json' }, grep: /@partner/ },
    { name: 'mobile-participant', dependencies: ['setup'], use: { ...devices['Pixel 7'], storageState: 'tests/.auth/participant.json' }, grep: /@mobile/ },
  ],
  webServer: process.env.E2E_LOCAL
    ? { command: 'npm run dev -- --host 0.0.0.0', url: 'http://127.0.0.1:5173', reuseExistingServer: true }
    : undefined,
});
