#!/usr/bin/env node
// Wrapper that loads tests/.env.e2e + tests/.e2e-env.json into process.env,
// then spawns the given command with those variables inherited.
// Lets local runs be reproducible without manually exporting E2E_* vars.
// Usage: node tests/seed/env.mjs <command...>
import { spawn } from 'node:child_process';
import { loadE2EEnv } from './lib-env.mjs';

loadE2EEnv();

const cmd = process.argv.slice(2);
if (cmd.length === 0) {
  console.error('Usage: node tests/seed/env.mjs <command...>');
  process.exit(2);
}
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));