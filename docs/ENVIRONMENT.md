# RapidAid — Environment Variable Reference & Configuration Catalog

This document defines all configuration parameters, startup validation rules, and environment matrices for RapidAid.

---

## 1. Environment Variable Reference Matrix

| Variable | Type | Default | Required in Prod | Description & Constraints |
| :--- | :--- | :--- | :--- | :--- |
| **`NODE_ENV`** | `enum` | `development` | Yes | `development`, `test`, or `production`. Governs safety rules. |
| **`PORT`** | `number` | `5000` | Optional | Backend HTTP listener port. |
| **`HOST`** | `string` | `0.0.0.0` | Optional | Network binding address. |
| **`MONGODB_URI`** | `string` | Local URL | Yes | Target MongoDB URI. **Refuses test DB names in production.** |
| **`JWT_ACCESS_SECRET`** | `string` | None | Yes | HS256 signing secret. **Minimum 32 chars; no weak patterns.** |
| **`JWT_REFRESH_SECRET`**| `string` | None | Yes | Refresh token secret. **Minimum 32 chars; no weak patterns.** |
| **`ACCESS_TOKEN_TTL`** | `string` | `15m` | Optional | JWT access token lifetime (e.g. `15m`, `30m`). |
| **`REFRESH_TOKEN_TTL_DAYS`**| `number` | `7` | Optional | Refresh token lifetime in days. |
| **`CORS_ORIGINS`** | `string` | Local URL | Yes | Comma-separated trusted origins. **Wildcard `*` forbidden in prod.** |
| **`PUBLIC_URL`** | `string` | Local URL | Yes | Public URL of frontend used in outgoing emails and deep links. |
| **`TRUST_PROXY_HOPS`** | `number` | `0` | Yes (if proxied) | Number of upstream reverse-proxy hops to trust for client IP. |
| **`AUTOMATED_DISPATCH_ENABLED`**| `boolean` | `false` | **MUST BE FALSE** | **Safety constraint: Must remain false in production.** |
| **`SEED_IF_EMPTY`** | `boolean` | `true` | **MUST BE FALSE** | Seed demo accounts. **Aborts startup if true in production.** |
| **`RATE_LIMIT_DISABLED`**| `boolean`| `false` | No | Bypasses rate limiting (only used in test runs). |
| **`LOG_LEVEL`** | `string` | `info` | Optional | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`. |
| **`ROUTING_PROVIDER_TYPE`**| `enum` | `osrm` | Optional | `osrm`, `mock`, or `offline`. |
| **`ROUTING_PROVIDER_URL`** | `string` | Project OSRM | Optional | URL of routing service (use self-hosted OSRM in production). |
| **`METRICS_SCRAPE_ENABLED`**| `boolean`| `false` | Optional | Enables Prometheus `/metrics` scraping endpoint. |
| **`METRICS_SCRAPE_TOKEN`** | `string` | None | If scrape on | Bearer secret for `/metrics`. Min 16 chars; no weak patterns. |
| **`EMAIL_TRANSPORT`** | `enum` | `console` | Optional | `console` (dev/test log) or `smtp` (real provider). |
| **`EMAIL_SMTP_HOST`** | `string` | None | If smtp on | Hostname of SMTP provider (e.g. AWS SES, SendGrid). |
| **`EMAIL_SMTP_PORT`** | `number` | `587` | If smtp on | SMTP port (`587` or `465`). |
| **`EMAIL_SMTP_USER`** | `string` | None | If smtp on | SMTP username. |
| **`EMAIL_SMTP_PASS`** | `string` | None | If smtp on | SMTP password. |
| **`EMAIL_SMTP_SECURE`** | `boolean`| `true` | If smtp on | Enforce implicit TLS. |
| **`SMS_PROVIDER`** | `enum` | `mock` | Optional | `mock` (log only) or `twilio` (real SMS). |
| **`TWILIO_ACCOUNT_SID`** | `string` | None | If twilio on | Twilio Account SID. |
| **`TWILIO_AUTH_TOKEN`** | `string` | None | If twilio on | Twilio Auth Token. |
| **`TWILIO_FROM_NUMBER`**| `string` | None | If twilio on | Twilio phone number. |
| **`WEB_PUSH_ENABLED`** | `boolean`| `false` | Optional | Enables VAPID Web Push dispatch. |
| **`VAPID_PUBLIC_KEY`** | `string` | None | If push on | VAPID public key. |
| **`VAPID_PRIVATE_KEY`**| `string` | None | If push on | VAPID private key. |
| **`VAPID_SUBJECT`** | `string` | None | If push on | Contact mailto: URI for push service. |

---

## 2. Fail-Fast Startup Validation Rules

The application startup process (`server/src/config/env.ts`) executes the following assertions:

1. **Zod Schema Parsing**: Any missing required variables or invalid formats immediately log an error and exit with code 1.
2. **Production Database Quarantine**: If `NODE_ENV === 'production'`, `MONGODB_URI` is tested against test patterns (`rapidaid_phase1_test`, `rapidaid_test`, `_test`). Any match triggers an immediate fatal exit.
3. **Weak Secret Rejection**: If `NODE_ENV === 'production'`, `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are checked for placeholder tokens (`change_me`, `dev_access`, `test-access`, etc.).
4. **CORS Wildcard Quarantine**: Wildcard `*` in `CORS_ORIGINS` is rejected when in production.
5. **Safety Dispatch Invariant**: If `AUTOMATED_DISPATCH_ENABLED === true`, startup aborts. Dispatching ambulances always requires human confirmation.
6. **Demo Seeder Invariant**: If `SEED_IF_EMPTY === true` in production, startup aborts.
