import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate staff', createAuthSetup('staff', 'E2E_STAFF_EMAIL', 'E2E_STAFF_PASSWORD'));
