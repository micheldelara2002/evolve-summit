// Shared E2E env loader — used by env.mjs, doctor, bootstrap and cleanup.
// Loads `tests/.env.e2e` (KEY=VALUE) and `tests/.e2e-env.json` (bootstrap output)
// into process.env. Real environment variables always win (we never overwrite).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const ENV_FILE = path.join(ROOT, 'tests', '.env.e2e');
export const STATE_FILE = path.join(ROOT, 'tests', '.e2e-env.json');

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readState(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Loads env files into process.env (without overwriting already-set values).
export function loadE2EEnv() {
  const fromFile = parseEnvFile(ENV_FILE);
  for (const [k, v] of Object.entries(fromFile)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  const state = readState(STATE_FILE);
  for (const [k, v] of Object.entries(state)) {
    if (process.env[k] === undefined) process.env[k] = String(v);
  }
  return process.env;
}

export const PERSONAS = [
  { key: 'manager', emailEnv: 'E2E_MANAGER_EMAIL', passEnv: 'E2E_MANAGER_PASSWORD', roleInEvent: 'manager', membership: 'manager' },
  { key: 'staff', emailEnv: 'E2E_STAFF_EMAIL', passEnv: 'E2E_STAFF_PASSWORD', roleInEvent: 'team', membership: 'team' },
  { key: 'participant', emailEnv: 'E2E_PARTICIPANT_EMAIL', passEnv: 'E2E_PARTICIPANT_PASSWORD', roleInEvent: 'attendee', membership: 'attendee' },
  { key: 'attendee2', emailEnv: 'E2E_ATTENDEE2_EMAIL', passEnv: 'E2E_ATTENDEE2_PASSWORD', roleInEvent: 'attendee', membership: 'attendee' },
  { key: 'speaker', emailEnv: 'E2E_SPEAKER_EMAIL', passEnv: 'E2E_SPEAKER_PASSWORD', roleInEvent: 'speaker', membership: 'speaker' },
  { key: 'partner', emailEnv: 'E2E_PARTNER_EMAIL', passEnv: 'E2E_PARTNER_PASSWORD', roleInEvent: 'partner_rep', membership: 'partner_rep' },
];

export const MARKER = 'E2E-REGRESSION';
export const PARTNER_TRADE = 'E2E Partner';
export const SEED_TAG = 'E2E_SEED';