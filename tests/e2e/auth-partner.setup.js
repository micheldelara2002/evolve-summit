import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate partner', createAuthSetup('partner', 'E2E_PARTNER_EMAIL', 'E2E_PARTNER_PASSWORD'));
