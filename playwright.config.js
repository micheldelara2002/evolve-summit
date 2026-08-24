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
  outputDir: 'test-results/raw',
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
    // Pure-SDK security gate: no browser/auth setup dependency.
    { name: 'security-direct', grep: /@rls/ },
    { name: 'setup-admin', testMatch: /auth-admin\.setup\.js/ },
    { name: 'setup-manager', testMatch: /auth-manager\.setup\.js/ },
    { name: 'setup-staff', testMatch: /auth-staff\.setup\.js/ },
    { name: 'setup-participant', testMatch: /auth-participant\.setup\.js/ },
    { name: 'setup-speaker', testMatch: /auth-speaker\.setup\.js/ },
    { name: 'setup-partner', testMatch: /auth-partner\.setup\.js/ },
    { name: 'manager', dependencies: ['setup-manager'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/manager.json' }, grep: /@manager/ },
    { name: 'staff', dependencies: ['setup-staff'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/staff.json' }, grep: /@staff/ },
    { name: 'participant', dependencies: ['setup-participant'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/participant.json' }, grep: /@participant/ },
    { name: 'speaker', dependencies: ['setup-speaker'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/speaker.json' }, grep: /@speaker/ },
    { name: 'partner', dependencies: ['setup-partner'], use: { ...devices['Desktop Chrome'], storageState: 'tests/.auth/partner.json' }, grep: /@partner/ },
    { name: 'mobile-participant', dependencies: ['setup-participant'], use: { ...devices['Pixel 7'], storageState: 'tests/.auth/participant.json' }, grep: /@mobile/ },
  ],
  webServer: process.env.E2E_LOCAL
    ? { command: 'npm run dev -- --host 0.0.0.0', url: 'http://127.0.0.1:5173', reuseExistingServer: true }
    : undefined,
});
