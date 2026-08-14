# Full App Audit — 2026-08-14

## Current assessment
The architecture has materially improved. P0.2 counters, P0.3 BusinessDashboard materialization, and NotificationCampaign batching have been validated. The remaining highest-value work is concentrated in a few unbounded hot paths and one materialized-counter integrity endpoint.

## Build status
- `npm run build`: PASS
- `npm run lint`: FAIL — 36 existing errors (mostly unused imports plus missing react-hooks rule references)

## Recommended credit allocation (50 Base credits)
1. **BE-P0-001 maintainBusinessCounter authorization** — highest risk; investigate/fix only after static confirmation.
2. **BE-P0-002 redeemStoreItem pagination** — correctness at scale.
3. **BE-P0-003 sendChatMessage User lookup** — hot-path O(N).
4. **BE-P0-004 UserProfile/PainelParceiro/AudienceSelector global reads** — consolidate into one bounded-read pass where possible.
5. **Then one P1 cluster at a time:** Speaker analytics + NotificationMetrics + CSV import.
6. **UX P0 work remains a separate backlog** and should be addressed after the next structural fixes, not mixed into the same implementation prompt.

## Explicitly deferred
- RLS deep audit, per current project decision.
- Speculative index tuning before bounded-read fixes.
- Broad lint cleanup until functional/scale priorities are stable.
