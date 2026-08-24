import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate admin', createAuthSetup('admin', 'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD'));
