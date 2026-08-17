import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate manager', createAuthSetup('manager', 'E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD'));
