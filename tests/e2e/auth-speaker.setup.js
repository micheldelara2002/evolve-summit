import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate speaker', createAuthSetup('speaker', 'E2E_SPEAKER_EMAIL', 'E2E_SPEAKER_PASSWORD'));
