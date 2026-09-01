# Base44 Dev Environment

## Overview
This is a Base44 SDK app (React 18 + Vite 6) that connects to a hosted Base44 backend.
The backend URL and App ID are injected via environment variables read at Vite dev time.

## Running the app
```bash
docker compose -f docker-compose.base44.yml up -d
```
- Dev server (Vite) runs on container port 5173, mapped to host port 3000.
- Source is bind-mounted; live reload is enabled (with chokidar polling for bind-mount compatibility).
- `node_modules` lives in a named volume (`web_node_modules`) to avoid host/node version conflicts.

## Required environment variables
These are injected via compose `env_file` (defaults file first, then platform secrets):
- `VITE_BASE44_APP_ID` — the Base44 App ID (from Base44 Builder project settings)
- `VITE_BASE44_APP_BASE_URL` — the hosted Base44 backend URL
- `VITE_BASE44_FUNCTIONS_VERSION` — optional functions version override
- `BASE44_LEGACY_SDK_IMPORTS` — set to `true` to support legacy `@/integrations` SDK imports (default true)

Without real `VITE_BASE44_APP_ID` / `VITE_BASE44_APP_BASE_URL`, the dev server still boots
but the app cannot authenticate or fetch data from the Base44 backend.

## Vite config
`server.host: true` and `server.allowedHosts: true` are set in `vite.config.js` so the
preview proxy hostname is accepted. Do not remove these — the preview breaks without them.

## Verification
```bash
curl -sf -H "Host: external-preview.example.com" http://localhost:3000/
```
Should return the HTML with `<title>Evolve Summit</title>` and a Vite client script tag.
