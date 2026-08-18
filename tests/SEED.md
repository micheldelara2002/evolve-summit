# Evolve Summit — E2E Seed & Environment

Reproducible QA environment for the Playwright suite. Everything operates **only on the TEST/preview app** (`E2E_BASE_URL`), never production.

## Prerequisites (manual, one-time)

Users cannot be created via the SDK — only invited through the Base44 builder. Before bootstrapping, register/invite these accounts **in the TEST app** (the platform admin invites them; they complete registration):

| Persona | Role | Email env |
|---|---|---|
| Admin (bootstrap only) | `admin` | `E2E_ADMIN_EMAIL` |
| Manager | event `manager` | `E2E_MANAGER_EMAIL` |
| Staff | event `team` | `E2E_STAFF_EMAIL` |
| Participant | `attendee` | `E2E_PARTICIPANT_EMAIL` |
| Speaker | `speaker` | `E2E_SPEAKER_EMAIL` |
| Partner | `partner_rep` | `E2E_PARTNER_EMAIL` |

Use disposable test emails (e.g. `qa-*@example.test`), never personal/real addresses. Each persona must be a **distinct** user so authorization regressions are not masked.

## Configuration

1. `cp tests/.env.e2e.example tests/.env.e2e` and fill it in (gitignored).
2. Set `BASE44_APP_ID` to the TEST app id.
3. Set `E2E_BASE_URL` to the TEST/preview URL.

`E2E_EVENT_ID` is **not** set manually — `bootstrap` writes it to `tests/.e2e-env.json`, which the env wrapper (`tests/seed/env.mjs`) and doctor load automatically.

## What the bootstrap creates (idempotent)

Running `npm run test:e2e:bootstrap` ensures, on the TEST app:

- **Event** named `E2E-REGRESSION` (status `active`, manager = manager persona). Reused if it exists.
- **Person** per persona (by `contact_email`), reused if exists.
- **Participant** per persona in the event (`role_in_event` per persona, `import_id="E2E_SEED"`, `bio="E2E-REGRESSION"`, participant check-in confirmed).
- **EventMembership** per persona (manager/team/speaker/partner_rep/attendee) linked to the user.
- **Partner** (`E2E Partner`, fake CNPJ `00000000000001`) + **EventPartner** + **PartnerRepresentative** linked to the partner persona.
- **Track** + **Room** + one **Session** (speaker = speaker persona).
- **ScoringRule** (presença_sessao, 5 pts), **StoreItem** (E2E Reward, 10 pts, estoque 100), **CertificateTemplate**.
- **CallForPapers** (open) + **AwardConfig** (so the CFP/award admin pages have data).

All E2E records are tagged (`import_id=E2E_SEED`, `bio=E2E-REGRESSION`, event name `E2E-REGRESSION`, partner `trade_name=E2E Partner`) so cleanup can find them safely. Re-running bootstrap **never duplicates** — every step queries before creating.

## Commands

```bash
# 1. Verify environment (node, playwright, chromium, env, connectivity, auth probe)
npm run test:e2e:doctor

# 2. Seed the TEST app (idempotent)
npm run test:e2e:bootstrap

# 3. Run suites (env wrapper auto-loads tests/.env.e2e + tests/.e2e-env.json)
npm run test:e2e:smoke        # @smoke
npm run test:e2e:security     # @security
npm run test:e2e:bulk         # @bulk
npm run test:e2e:mobile       # @mobile
npm run test:e2e:regression   # @regression (all)
npm run test:e2e              # everything

# 4. Tear down the E2E dataset (TEST app only, marker-guarded, soft-delete)
npm run test:e2e:cleanup
```

## Reset / recreate

```bash
npm run test:e2e:cleanup   # soft-deletes the E2E event + children
npm run test:e2e:bootstrap # recreates a fresh E2E dataset
```

Cleanup refuses to touch any event whose name is not `E2E-REGRESSION`, so it can never delete a real event even if `E2E_EVENT_ID` is wrong.

## Cleanup safety

- Operates only against `E2E_BASE_URL` (TEST app).
- Authenticates as admin (`E2E_ADMIN_*`).
- Loads `E2E_EVENT_ID` and **verifies the event name is `E2E-REGRESSION`** before deleting.
- Uses **soft-delete** (`is_deleted=true`) for every record, so the operation is reversible.
- Deletes only records by `event_id` (E2E event) or by E2E markers (`trade_name=E2E Partner`, `bio=E2E-REGRESSION`).

## CI

See `.github/workflows/qa-e2e.yml`. It installs Node + deps + Chromium (with system libs), runs doctor → bootstrap → smoke → security → bulk → mobile → regression, and uploads the Playwright report, JSON results, traces, screenshots and videos as artifacts. Secrets hold the credentials.

## Still manual

- Inviting/registering the 6 accounts (admin + 5 personas) in the TEST app — the SDK cannot create Users.
- Filling `tests/.env.e2e` locally (or configuring GitHub secrets for CI).
- The very first `BASE44_APP_ID` lookup in the Base44 builder.