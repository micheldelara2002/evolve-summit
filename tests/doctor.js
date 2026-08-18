// =============================================================================
// Evolve Summit QA Doctor
// Verifies that the environment is ready to run the E2E suite.
// Hard checks (exit 1 on failure): node, playwright, chromium, env vars,
//   E2E_BASE_URL scheme, connectivity to the test app.
// Optional checks (warn only): event existence (needs bootstrap), auth probe.
// Reads tests/.env.e2e and tests/.e2e-env.json so `npm run test:e2e:doctor`
//   works without manually exporting variables.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadE2EEnv, ENV_FILE, STATE_FILE, PERSONAS } from './seed/lib-env.mjs';

loadE2EEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const hard = [];
const warn = [];
const ok = [];
const hardFail = (m) => hard.push(m);
const warnFail = (m) => warn.push(m);
const pass = (m) => ok.push(m);

// 1. Node
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) pass(`Node ${process.versions.node}`);
else hardFail(`Node >=18 required (got ${process.versions.node}).`);

// 2. Playwright installed
try {
  const pwPath = path.resolve(ROOT, 'node_modules', '@playwright', 'test', 'package.json');
  if (fs.existsSync(pwPath)) {
    const pw = JSON.parse(fs.readFileSync(pwPath, 'utf8'));
    pass(`Playwright ${pw.version} installed.`);
  } else {
    hardFail('@playwright/test not installed. Run `npm install`.');
  }
} catch (e) {
  hardFail(`Could not resolve Playwright: ${e.message}`);
}

// 3. Chromium browser present
const pwCache = path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'ms-playwright');
let chromiumFound = false;
if (fs.existsSync(pwCache)) {
  chromiumFound = fs.readdirSync(pwCache).some((d) => /chromium/i.test(d));
}
if (chromiumFound) pass('Chromium browser cache present.');
else hardFail('Chromium not found. Run `npx playwright install --with-deps chromium`.');
// Shared libs sanity (the failure we saw in-sandbox)
if (process.platform === 'linux') {
  try {
    fs.accessSync('/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0', fs.constants.R_OK);
    pass('libglib-2.0 present (Chromium dep).');
  } catch {
    warnFail('libglib-2.0 not found at default path — `npx playwright install-deps chromium` may be needed.');
  }
}

// 4. E2E_BASE_URL
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) hardFail('E2E_BASE_URL missing.');
else {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' && process.env.E2E_ALLOW_HTTP !== '1') {
      hardFail(`E2E_BASE_URL must be HTTPS (set E2E_ALLOW_HTTP=1 for local). Got ${baseURL}`);
    } else {
      pass(`E2E_BASE_URL: ${baseURL}`);
      if (/prod/i.test(baseURL) && process.env.E2E_ALLOW_PROD !== '1') {
        warnFail('E2E_BASE_URL looks like production — tests must use the TEST app.');
      }
    }
  } catch (e) {
    hardFail(`Invalid E2E_BASE_URL: ${e.message}`);
  }
}

// 5. E2E_EVENT_ID (from env or state file)
const eventId = process.env.E2E_EVENT_ID;
if (!eventId) {
  warnFail(`E2E_EVENT_ID missing (env/state). Run \`npm run test:e2e:bootstrap\` to create it.`);
} else {
  pass(`E2E_EVENT_ID: ${eventId}`);
}

// 6. Persona credentials
for (const p of PERSONAS) {
  const email = process.env[p.emailEnv];
  const passw = process.env[p.passEnv];
  if (email && passw) pass(`${p.key}: credentials configured.`);
  else warnFail(`${p.key}: missing ${p.emailEnv} / ${p.passEnv}.`);
}
if (!process.env.E2E_ADMIN_EMAIL || !process.env.E2E_ADMIN_PASSWORD) {
  warnFail('E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD missing (needed by bootstrap/cleanup).');
} else {
  pass('E2E_ADMIN credentials present.');
}

// 7. Connectivity to the test app (optional, best-effort)
if (baseURL) {
  try {
    const res = await fetch(baseURL, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (res.status < 500) pass(`Test app reachable (HTTP ${res.status}).`);
    else warnFail(`Test app returned HTTP ${res.status} — may be down.`);
  } catch (e) {
    warnFail(`Could not reach E2E_BASE_URL: ${e.message}`);
  }
}

// 8. Optional auth probe (needs admin creds + app id)
if (process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD && process.env.BASE44_APP_ID && baseURL) {
  try {
    const { createClient } = await import('@base44/sdk');
    const probe = createClient({ appId: process.env.BASE44_APP_ID, token: undefined, serverUrl: process.env.BASE44_API_URL || '', appBaseUrl: baseURL, requiresAuth: true });
    await probe.auth.loginViaEmailPassword(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const me = await probe.auth.me();
    pass(`Auth probe OK (${me.email}, role=${me.role}).`);
  } catch (e) {
    warnFail(`Auth probe failed: ${e.message}`);
  }
} else {
  warnFail('Auth probe skipped (needs BASE44_APP_ID + E2E_ADMIN_*).');
}

// --- Report ---
console.log('\n=== Evolve Summit QA Doctor ===');
console.log(`Base URL: ${baseURL || 'NOT CONFIGURED'}`);
console.log(`Event:    ${eventId || 'NOT CONFIGURED'}`);
console.log(`Env file: ${fs.existsSync(ENV_FILE) ? ENV_FILE : '(missing — copy tests/.env.e2e.example)'}`);
console.log(`State:    ${fs.existsSync(STATE_FILE) ? STATE_FILE : '(missing — run bootstrap)'}`);
for (const m of ok) console.log(`✔ ${m}`);
for (const m of warn) console.warn(`⚠ ${m}`);
for (const m of hard) console.error(`✖ ${m}`);

if (hard.length) {
  console.error(`\nQA environment incomplete: ${hard.length} hard failure(s).`);
  process.exit(1);
}
if (warn.length) console.warn(`\n${warn.length} warning(s) — suite may be partially blocked.`);
console.log('\nDoctor OK.');