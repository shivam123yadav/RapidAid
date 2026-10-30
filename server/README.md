# RapidAid API Server

Express 5 + TypeScript + MongoDB (Mongoose) backend for the RapidAid
emergency-response frontend.

## Quick start

```bash
# 1. install (from repo root)
npm run server:install

# 2. configure — copy server/.env.example to server/.env and set real secrets:
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. seed demo data (idempotent, $setOnInsert — safe to re-run)
npm run server:seed

# 4. run (auto-seeds if the DB is empty)
npm run server            # → http://localhost:5000

# 5. in a second terminal, run the frontend (proxies /api → :5000)
npm run dev               # → http://localhost:3000
```

Requires MongoDB running locally on `mongodb://127.0.0.1:27017`.

Demo login (all passwords `demo123`): `dispatcher@rapidaid.com`,
`crew@rapidaid.com`, `hospital@rapidaid.com`, `admin@rapidaid.com`,
plus `supervisor@`, `auditor@`, `analyst@`, `citizen@` for RBAC coverage.

## Scripts

| Command | Description |
|---|---|
| `npm run server` | dev API with hot-reload (tsx watch) |
| `npm run server:seed` | idempotent demo-data seed |
| `npm run server:test` | 125 integration tests across 15 suites (vitest + supertest) |
| `npm run server:build` | compile to `server/dist` (`npm start` to run) |
| `npm run typecheck` (in server/) | strict TS check |
| `npm run verify:playback` (in server/) | browser check that stored audio reports a real duration and plays |
| `npm run verify:ui-flow` (in server/) | full voice flow in headless Chrome (login → record → transcribe → route → play); needs :3000, :5000 and root-installed `playwright-core` |

## Architecture

```
src/
├── config/        env (zod-validated, fail-fast) + pino logger
├── db/            mongoose connection, readiness ping
├── models/        User, Emergency, Ambulance, Hospital, AIDetection,
│                  Notification, AuditLog, VoiceReport, DailyStat,
│                  Counter, RefreshToken  (string _id → JSON `id`)
├── middleware/    requestId → auth (JWT) → RBAC → validate (zod) → errors
├── routes/        one file per resource, mounted under /api
├── services/      dispatch scoring, state machine, tokens, audit,
│                  voice extraction, corridor simulation, analytics
├── seed/          idempotent demo data (+ data/ fixtures)
└── app.ts/index.ts  app factory (testable) + bootstrap/shutdown
```

Key design decisions:

- **IDs**: every document uses a human-readable `_id` (`EMG-20481`,
  `AMB-017`, `USR-001`…) which serializes to the frontend's `id` field;
  `_id`/`__v` are stripped by a schema `toJSON` transform.
- **Auth**: 15-minute access JWT (in browser memory) + rotating refresh
  token (httpOnly cookie, SHA-256-hashed at rest, one-time use).
- **RBAC**: route-level `requireRole(...)` middleware; matrix documented
  below.
- **State machine**: emergency status is forward-only; terminal states
  (`COMPLETED`/`CANCELLED`) are immutable; transitions append timeline
  entries and release assigned ambulances.
- **No multi-document transactions**: the local MongoDB runs standalone
  (no replica set), so writes are ordered with guarded filters +
  compensation instead of `session.withTransaction`.
- **AI is deterministic**: dispatch scoring, voice keyword extraction and
  corridor simulation are pure functions — fully testable, no external
  model calls. Swap points are isolated in `services/`.
- **Audit-first**: every mutation writes an `AuditLog` row with the
  request's `x-request-id` for traceability.

## RBAC matrix

Authorization is **permission-based**, not role-based. The registry in
`src/authz/permissions.ts` defines the permission strings and the
`ROLE_PERMISSIONS` map; routes guard with `requirePermission(...)` and
resource-ownership guards (`requireAmbulanceOwnership`,
`requireHospitalOwnership`). The role is read from the live user record on every
request, never from a client-supplied claim.

The same registry is serialized onto `user.permissions` at login, so the
frontend renders its navigation and buttons from that server-issued list
instead of keeping a second copy of the matrix.

| Endpoint | Permission | Allowed roles |
|---|---|---|
| GET /api/ambulances | `ambulance:view` | ADMIN, SUPERVISOR, DISPATCHER, ANALYST, AUDITOR, HOSPITAL_STAFF |
| GET /api/ambulances (scoped) | `ambulance:view:own` | AMBULANCE_CREW (own unit only) |
| POST /api/ambulances | `ambulance:create` | ADMIN, SUPERVISOR |
| PATCH /api/ambulances/:id | `ambulance:update` | ADMIN, SUPERVISOR |
| DELETE /api/ambulances/:id | `ambulance:delete` | ADMIN |
| PATCH /api/ambulances/:id/crew | `ambulance:assign-crew` | ADMIN, SUPERVISOR |
| PATCH /api/ambulances/:id/status | `ambulance:status` | ADMIN, SUPERVISOR, DISPATCHER |
| PATCH /api/ambulances/:id/telemetry | `ambulance:telemetry` \| `ambulance:status` | AMBULANCE_CREW (own unit only), DISPATCHER, SUPERVISOR, ADMIN |
| GET /api/reports | `report:read:all`, `report:read:own` | All authenticated roles (scoped to creator unless held with read:all) |
| POST /api/reports | `report:create`, `report:generate` | Operational roles (generate: ANALYST, AUDITOR; create: CITIZEN, CREW, HOSPITAL, DISPATCHER, SUPERVISOR, ADMIN) |
| GET /api/reports/:id/export | `report:export` | ADMIN, SUPERVISOR, DISPATCHER, ANALYST, AUDITOR (sanitized aggregate only) |
| GET /api/reports/:id/sensitive-export | `report:export` + `report:export:sensitive` + `patient:export` | ADMIN only (audited denial on unauthorized attempts) |
| GET /api/cameras | `camera:live-view`, `camera:recording-view`, `camera:evidence-view` | DISPATCHER (live projection only), ANALYST, AUDITOR, SUPERVISOR, ADMIN |
| GET /api/cameras/:id/evidence-export | `camera:evidence-export` | AUDITOR, ADMIN |
| GET /api/shifts | `shift:read:all`, `shift:read:own` | AMBULANCE_CREW (own assigned shifts), DISPATCHER, AUDITOR, SUPERVISOR, ADMIN |
| GET /api/maintenance | `maintenance:read:all`, `maintenance:read:own`, `maintenance:history` | AMBULANCE_CREW (own unit), ANALYST, AUDITOR (history read-only), SUPERVISOR, ADMIN |
| dispatch assign | `ambulance:assign` | DISPATCHER, SUPERVISOR, ADMIN |
| audit log | `audit:view` | ADMIN, SUPERVISOR, AUDITOR, ANALYST |
| audit log (own activity) | `audit:view:own` | AMBULANCE_CREW, HOSPITAL_STAFF |
| profile update | self only (role/email immutable) | any authenticated |

Citizen holds no ambulance permission at all, so `GET /api/ambulances` returns
403 — hiding the nav item is only a convenience, the API rejects it regardless.

Denied attempts write a `permission.denied` audit record.

## Error envelope

Every error response is `{ "error": { "message", "code", "requestId" } }`
with the matching HTTP status (`400 BAD_REQUEST`, `401 UNAUTHORIZED`,
`403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `429 RATE_LIMITED`,
`500 INTERNAL`). The `requestId` is echoed in the `x-request-id` header.

## Tests

`tests/` covers: auth (login/refresh rotation/logout/register),
validation errors, RBAC (every denial path), the status state machine,
dispatch scoring + assignment conflict guards (409), vision
human-in-the-loop conversion, voice extraction → emergency creation,
corridor determinism, telemetry, analytics shape, health ping, 404/400
envelopes, and request-id tracing. Tests run against a dedicated
`rapidaid_test` database (dropped before/after each file).
