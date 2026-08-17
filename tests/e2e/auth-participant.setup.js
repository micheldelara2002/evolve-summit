import { test as setup } from '@playwright/test';
import { createAuthSetup } from '../support/auth-setup.js';
setup('authenticate participant', createAuthSetup('participant', 'E2E_PARTICIPANT_EMAIL', 'E2E_PARTICIPANT_PASSWORD'));
