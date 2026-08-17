# Evolve Summit — Scenario Catalog

Status values: `NOT_RUN | PASS | FAIL | BLOCKED | SKIPPED`

## GERENTE — highest priority

### Access / event management
- GM-001 Login with valid credentials → home loads.
- GM-002 Invalid password → login rejected, no session.
- GM-003 Open authorized event → event management loads.
- GM-004 Open unauthorized event → access denied.
- GM-005 Edit event metadata → saved values persist after reload.
- GM-006 Change event status → dependent UI reflects new state.
- GM-007 Open every event module → no module crashes.
- GM-008 Return from module → correct event context retained.

### People / bulk
- GM-010 Create person with required fields.
- GM-011 Edit person.
- GM-012 Inactivate person.
- GM-013 Reactivate person.
- GM-014 Add document.
- GM-015 Reject duplicate document.
- GM-016 Import valid CSV.
- GM-017 Preview does not mutate.
- GM-018 Duplicate CPF in CSV rejected.
- GM-019 Duplicate email in CSV rejected.
- GM-020 Invalid email rejected.
- GM-021 Missing required field rejected.
- GM-022 Existing person in another event classified as unlinked.
- GM-023 Existing linked person ignored.
- GM-024 Confirm import creates only approved rows.
- GM-025 Import 500+ rows without UI failure.
- GM-026 Import 1000+ rows without truncation.
- GM-027 Import result counts reconcile with Import entity.
- GM-028 Re-running same file does not silently duplicate already-linked rows.

### Event content
- GM-030 Create/edit track.
- GM-031 Create/edit room.
- GM-032 Create/edit session.
- GM-033 Assign speaker to session.
- GM-034 Prevent invalid speaker removal when sessions depend on speaker.
- GM-035 Configure scoring rule.
- GM-036 Configure badges.
- GM-037 Configure store item.
- GM-038 Configure raffle.
- GM-039 Configure certificate template.
- GM-040 Manage CFP.
- GM-041 Manage award configuration.

### Communications / metrics
- GM-050 Create campaign.
- GM-051 Audience preview matches expected segment.
- GM-052 Deleted participant excluded from audience.
- GM-053 Send campaign → recipients created/sent.
- GM-054 Campaign >1000 recipients has no silent truncation.
- GM-055 Metrics total clicks match authoritative count.
- GM-056 Notification retry does not duplicate sent terminal records.

### Security
- GM-060 Cannot modify another event by arbitrary ID.
- GM-061 Cannot access another partner's leads.
- GM-062 Cannot assign unauthorized role through client payload.
- GM-063 Cannot credit points to arbitrary participant.
- GM-064 Cannot redeem store item for another participant.
- GM-065 Cannot issue certificate outside allowed authorization.

## STAFF

- ST-001 Login/home.
- ST-002 Open assigned event.
- ST-003 Event access limited to assigned event(s).
- ST-004 View participants.
- ST-005 Perform allowed check-in/attendance operation.
- ST-006 Scan QR code.
- ST-007 Attendance duplicate scan is idempotent.
- ST-008 View schedule/session details.
- ST-009 Perform allowed scoring action.
- ST-010 Cannot access admin global People.
- ST-011 Cannot edit event configuration outside permission.
- ST-012 Cannot access another event by URL.
- ST-013 Cannot send privileged global campaign.
- ST-014 Cannot mutate another participant's points.

## PARTICIPANTE

- PA-001 Login/home.
- PA-002 My Events list.
- PA-003 Event association required.
- PA-004 Unassociated event denied.
- PA-005 Pending check-in shows read-only state.
- PA-006 Checked-in participant can interact.
- PA-007 View schedule.
- PA-008 Filter/search schedule.
- PA-009 Favorite session.
- PA-010 Favorite toggle is idempotent.
- PA-011 Session details open/close.
- PA-012 Submit session question when allowed.
- PA-013 Visibility of private question limited to intended audience.
- PA-014 Review session.
- PA-015 Answer eligible poll.
- PA-016 Duplicate poll answer rejected/idempotent.
- PA-017 Earn points from valid mission.
- PA-018 Duplicate one-shot mission does not double points.
- PA-019 Per-session scoring limit enforced.
- PA-020 Ranking event scoped.
- PA-021 Global ranking, if enabled, includes only valid historical participation.
- PA-022 Store displays available balance.
- PA-023 Successful redemption decrements balance once.
- PA-024 Insufficient balance rejected.
- PA-025 Stock exhaustion rejected.
- PA-026 Concurrent redemption cannot oversell stock.
- PA-027 Per-user redemption limit enforced.
- PA-028 Networking discover limited to eligible people/events.
- PA-029 Connection request send.
- PA-030 Accept/refuse/cancel connection request.
- PA-031 Cross-event connection blocked.
- PA-032 Notification inbox loads unread/read state.
- PA-033 Read notification updates immediately and persists.
- PA-034 Profile edit persists.
- PA-035 Account deletion confirmation requires explicit confirmation.
- PA-036 Account deletion anonymizes PII.
- PA-037 Deleted account cannot access app with old session.
- PA-038 Deleted account is excluded from future notification audiences.

## PALESTRANTE

- SP-001 Login/dashboard.
- SP-002 Only own speaker participations appear.
- SP-003 Own sessions listed by event.
- SP-004 Speaker KPI totals reconcile.
- SP-005 Review metrics scoped to own sessions.
- SP-006 Attendance metrics scoped to own sessions.
- SP-007 Session questions visible according to visibility rules.
- SP-008 Answer own session question.
- SP-009 Cannot answer another speaker's private question.
- SP-010 Mentorship requests scoped to own sessions/participant.
- SP-011 Speaker raffle pool contains attendees from own sessions only.
- SP-012 Speaker cannot mutate participant points arbitrarily.
- SP-013 Speaker notifications target allowed audience only.
- SP-014 Speaker cannot cross event boundary.

## PARCEIRO

- PR-001 Login/dashboard.
- PR-002 Partner manager sees only owned partner.
- PR-003 Partner representative sees only assigned event(s).
- PR-004 Partner representative cannot open partner admin.
- PR-005 Partner manager can access partner management.
- PR-006 Partner event selector shows only accessible events.
- PR-007 Leads list scoped by partner + event.
- PR-008 Lead detail does not expose another partner's data.
- PR-009 QR flow attributes visit to correct partner/event.
- PR-010 Sponsorship sessions scoped to partner representatives.
- PR-011 Partner notification campaign authorization enforced.
- PR-012 Partner raffle uses correct event/partner scope.
- PR-013 Partner cannot manipulate `partnerId` in request to access another partner.
- PR-014 Partner cannot mutate another partner's leads.
- PR-015 Finished event becomes read-only where specified.

## CROSS-CUTTING SECURITY / DATA

- SEC-001 IDOR: Participant ID substitution.
- SEC-002 IDOR: Event ID substitution.
- SEC-003 IDOR: Session ID substitution.
- SEC-004 IDOR: ConnectionRequest ID substitution.
- SEC-005 IDOR: Store item/participant substitution.
- SEC-006 IDOR: Campaign ID substitution.
- SEC-007 Role escalation through EventMembership payload.
- SEC-008 Deleted account mutation guard.
- SEC-009 Cross-event data leakage.
- SEC-010 PII residual after account deletion.
- SEC-011 Notification audience excludes deleted accounts.
- SEC-012 Duplicate scoring race.
- SEC-013 Duplicate redemption race.
- SEC-014 Duplicate connection race.
- SEC-015 Duplicate notification recipient race.

## MOBILE / UX REGRESSION

- UX-001 320px viewport no horizontal overflow.
- UX-002 375px viewport no horizontal overflow.
- UX-003 430px viewport no horizontal overflow.
- UX-004 BottomNav remains tappable.
- UX-005 Back navigation returns to expected screen.
- UX-006 Scroll position restored between primary tabs.
- UX-007 Pull-to-refresh works at page top.
- UX-008 Pull-to-refresh does not interfere with chat/sheets.
- UX-009 Safe-area top/bottom respected.
- UX-010 Notification sheet opens/closes correctly.
- UX-011 Touch target smoke for critical controls.
- UX-012 Dark mode does not lose contrast/functionality.

## Automation coverage — 2026-08-17

The catalog above remains the business scenario inventory. Automated coverage is intentionally not 1:1 with catalog rows: scenarios that require backend concurrency, destructive data setup, or infrastructure-level assertions may be classified as backend/manual instead of being forced into UI automation.

Current Playwright suites:

| Suite | Purpose | Primary tags |
|---|---|---|
| `role-access.spec.js` | Baseline persona access | `@regression` |
| `manager-regression.spec.js` | Manager modules, scope and critical admin paths | `@manager @regression` |
| `staff-regression.spec.js` | Staff access and negative authorization | `@staff @regression` |
| `participant-regression.spec.js` | Participant journey and protected actions | `@participant @regression` |
| `speaker-regression.spec.js` | Speaker dashboard, engagement and isolation | `@speaker @regression` |
| `partner-regression.spec.js` | Partner scope and partner-admin boundaries | `@partner @regression` |
| `security-regression.spec.js` | Cross-cutting URL/authorization regression | `@security @regression` |
| `bulk-import.spec.js` | CSV validation and scale preview | `@bulk @regression` |
| `participant-mobile.spec.js` | Mobile UX/overflow/touch regression | `@mobile @regression` |
| `smoke.spec.js` | Fast release gate, one smoke path per persona | `@smoke` |

The Playwright inventory is generated with `npm run test:e2e -- --list`. A test is considered **PASS** only after execution; listing a test file is not evidence of a passing scenario.
