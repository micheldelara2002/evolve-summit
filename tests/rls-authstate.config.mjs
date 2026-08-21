import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', timeout: 45000, expect: { timeout: 8000 }, workers: 1, reporter: 'line', use: { baseURL: 'https://share--evolve-summit.base44.app' } });
