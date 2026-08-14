# Backend Improvement Backlog — 2026-08-14

## Strategy
Prioritize production-risk and scale defects over speculative optimization. RLS/security hardening is intentionally deferred per project decision; this backlog covers application/business integrity and performance.

## P0 — use credits first

### BE-P0-001 — Secure `maintainBusinessCounter`
**Finding:** any authenticated user can invoke the service-role counter function with arbitrary `eventId`, roles, dates, and global metrics actions.
**Risk:** materialized BusinessDashboard counters can be manipulated across events/global scope.
**Fix:** make the function non-public for client callers where possible; otherwise enforce action-specific authorization and derive event/identity from authenticated context. Keep trusted workflow/service paths explicit.

### BE-P0-002 — Remove unbounded `redeemStoreItem` ledger read
**Finding:** `StoreRedemption.filter(...)` loads all non-cancelled redemptions for a participant without pagination.
**Risk:** large redemption history can truncate or exhaust memory and break balance/limit checks.
**Fix:** paginate ledger reads in batches; preserve exact balance/limit semantics.

### BE-P0-003 — Remove remaining hot-path global reads
**Finding:** `sendChatMessage` resolves recipient User via `User.list()` on every message.
**Risk:** O(N) memory/latency on every chat message as user base grows.
**Fix:** replace with `User.filter({email})` or a bounded identity lookup.

### BE-P0-004 — Remove global participant/user loads from critical user flows
**Confirmed hotspots:** `UserProfile`, `PainelParceiro`, `AudienceSelector`, `AdminPeoplePlaceholder`, `CsvImport`.
**Risk:** truncation/latency at scale; some are user-facing hot paths.
**Fix:** server-side filters + bounded pagination; preserve exact business semantics.

## P1 — next credits

### BE-P1-001 — Speaker consolidated views
`SpeakerKPIs` and `SpeakerRankingView` load global Sessions/Reviews/Attendance/MentorshipRequest and filter client-side.

### BE-P1-002 — Notification metrics
`NotificationMetrics` loads up to 1000 recipients and all campaigns/events client-side. Metrics can become incomplete after the first page.

### BE-P1-003 — CSV import global matching
`CsvImport` loads all non-deleted Participants globally and builds global Maps in memory. Replace with batched selective lookups.

### BE-P1-004 — Partner dashboard scoping
`PainelParceiro` loads all Events and all Participants for representative resolution, then filters client-side.

### BE-P1-005 — Ranking/profile flows
`RankingModal`, `UserProfile`, `MeusEventos`, `EventsList` contain global or broad reads that should be bounded before data volume becomes large.

### BE-P1-006 — Dead legacy notification resolver
`src/lib/notificationService.js` still contains O(N) legacy recipient resolution despite server-side dispatch being the active path. Remove or isolate to prevent accidental reuse.

### BE-P1-007 — Backend integrity: event context validation
Review functions that accept `eventId` separately from a resource identifier (e.g. `sendChatMessage`) and ensure the supplied event matches the authoritative resource context.

## P2 — hygiene / optimization
- Replace remaining fixed `.list(..., 200/300/500/1000)` reads with explicit pagination where the dataset can grow.
- Reduce client-side filtering where server-side predicates are equivalent.
- Add automated scale regression tests for every ledger/materialized-counter path.
- Clean lint errors (36 currently reported) after functional priorities are stable.

## Validation rule
Never declare a collection query "complete" unless pagination is explicit or the dataset is provably bounded. Base44 `filter/list` return limits must be treated as hard boundaries.
