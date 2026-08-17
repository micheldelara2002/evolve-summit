import fs from 'node:fs';
import { URL } from 'node:url';

const baseURL = process.env.E2E_BASE_URL || 'https://share--evolve-summit.base44.app';
const roles = [
  ['manager', 'E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD'],
  ['staff', 'E2E_STAFF_EMAIL', 'E2E_STAFF_PASSWORD'],
  ['participant', 'E2E_PARTICIPANT_EMAIL', 'E2E_PARTICIPANT_PASSWORD'],
  ['speaker', 'E2E_SPEAKER_EMAIL', 'E2E_SPEAKER_PASSWORD'],
  ['partner', 'E2E_PARTNER_EMAIL', 'E2E_PARTNER_PASSWORD'],
];

let failed = false;

try {
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' && process.env.E2E_ALLOW_HTTP !== '1') {
    throw new Error('E2E_BASE_URL must use HTTPS (set E2E_ALLOW_HTTP=1 only for local runs).');
  }
} catch (error) {
  console.error(`✖ Invalid E2E_BASE_URL: ${error.message}`);
  failed = true;
}

console.log(`Evolve Summit QA doctor`);
console.log(`Base URL: ${baseURL}`);
console.log(`Event: ${process.env.E2E_EVENT_ID || 'NOT CONFIGURED'}`);

for (const [role, emailKey, passwordKey] of roles) {
  const ready = Boolean(process.env[emailKey] && process.env[passwordKey]);
  const authFile = `tests/.auth/${role}.json`;
  const cached = fs.existsSync(authFile);
  console.log(`${ready ? '✔' : '⚠'} ${role}: credentials ${ready ? 'configured' : 'missing'}${cached ? ', cached session present' : ''}`);
}

if (!process.env.E2E_EVENT_ID) {
  console.warn('⚠ E2E_EVENT_ID is missing. Event-scoped tests will be skipped.');
}

if (failed) process.exit(1);
