import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', timeout: 45000, workers: 1, use: { baseURL: 'https://share--evolve-summit.base44.app' } });
