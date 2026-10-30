# RapidAid — Render.com Production Deployment Guide

This guide details the step-by-step instructions, build commands, and environment variable configurations for deploying RapidAid on **Render.com**.

RapidAid on Render consists of two services:
1. **`rapidaid-api`**: Node.js Web Service (Express backend API in `server/`)
2. **`rapidaid-web`**: Static Site (React 18 + TypeScript + Vite frontend)

---

## 1. Quickstart: Render Blueprint (Infrastructure as Code)

RapidAid includes a root [`render.yaml`](file:///d:/2_Project_build/workspace/render.yaml) file. You can deploy both services together using Render Blueprints:

1. Push your repository to GitHub: `https://github.com/shivam123yadav/RapidAid.git`.
2. In the Render Dashboard, click **New +** > **Blueprint**.
3. Connect your repository. Render automatically reads `render.yaml`.
4. Supply the manual environment variables (`MONGODB_URI`, `CORS_ORIGINS`, `PUBLIC_URL`, `VITE_API_BASE_URL`).
5. Click **Apply**.

---

## 2. Manual Service Setup (Render Dashboard)

If you prefer configuring services manually via the Render Web Dashboard, follow the exact settings below:

### 2.1 Backend Web Service (`rapidaid-api`)

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Service Type** | **Web Service** | Backend API service |
| **Name** | `rapidaid-api` (or your preferred name) | |
| **Region** | Oregon (US West) or Frankfurt | Pick region closest to your MongoDB Atlas cluster |
| **Branch** | `main` or `master` | |
| **Root Directory** | `server` | **Crucial**: Backend lives in the `server` directory |
| **Runtime** | **Node** | Node.js 20 or 22 |
| **Build Command** | `npm ci && npm run build` | Installs dependencies and compiles TypeScript |
| **Start Command** | `npm start` | Executes `node dist/index.js` |
| **Instance Type** | Starter ($7/mo) or Free | Starter recommended to avoid idle spin-down |
| **Health Check Path**| `/healthz` | Unauthenticated orchestrator liveness probe |

#### Backend Environment Variables Checklist

Set these in the **Environment** tab of the `rapidaid-api` Web Service:

| Environment Variable | Value / Format | Purpose & Constraints |
| :--- | :--- | :--- |
| **`NODE_ENV`** | `production` | Enables production security mode and fail-fast validation |
| **`HOST`** | `0.0.0.0` | Binds to all network interfaces |
| **`PORT`** | *(Leave empty / automatic)* | Render automatically assigns `PORT` (e.g. 10000) |
| **`MONGODB_URI`** | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/rapidaid?retryWrites=true&w=majority` | **Production MongoDB Atlas URI. Refuses `rapidaid_phase1_test`.** |
| **`JWT_ACCESS_SECRET`** | Min 32 random characters (`openssl rand -hex 32`) | Signs access tokens. Rejects placeholders. |
| **`JWT_REFRESH_SECRET`**| Min 32 random characters (`openssl rand -hex 32`) | Signs refresh tokens. Rejects placeholders. |
| **`ACCESS_TOKEN_TTL`** | `15m` | Lifetime of short-lived access JWT |
| **`REFRESH_TOKEN_TTL_DAYS`**| `7` | Lifetime of refresh tokens |
| **`CORS_ORIGINS`** | `https://rapidaid-web.onrender.com` | **Allowed frontend origin. Wildcard `*` strictly forbidden.** |
| **`PUBLIC_URL`** | `https://rapidaid-web.onrender.com` | Frontend URL for email action links |
| **`TRUST_PROXY_HOPS`** | `1` | Enables accurate `req.ip` behind Render's load balancer |
| **`SEED_IF_EMPTY`** | `false` | **Safety rule: Must be false. Server aborts if true in prod.** |
| **`AUTOMATED_DISPATCH_ENABLED`**| `false` | **Safety rule: Automated dispatch forbidden. Must remain false.** |
| **`RATE_LIMIT_DISABLED`**| `false` | Enables rate limiting against brute force |
| **`LOG_LEVEL`** | `info` | Structured JSON log verbosity |
| **`ROUTING_PROVIDER_TYPE`**| `osrm` | Road routing provider |
| **`ROUTING_PROVIDER_URL`** | `https://router.project-osrm.org` | Road routing provider endpoint |

---

### 2.2 Frontend Static Site (`rapidaid-web`)

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Service Type** | **Static Site** | React SPA frontend |
| **Name** | `rapidaid-web` | |
| **Branch** | `main` or `master` | |
| **Root Directory** | *(Leave blank - project root)* | Frontend configuration is at the repository root |
| **Build Command** | `npm ci && npm run build` | Runs voice model sync and Vite production build |
| **Publish Directory** | `dist` | Vite build output directory |

#### Frontend Environment Variables

Set this in the **Environment** tab of the `rapidaid-web` Static Site:

| Environment Variable | Value | Notes |
| :--- | :--- | :--- |
| **`VITE_API_BASE_URL`** | `https://rapidaid-api.onrender.com` | URL of your deployed backend service. RapidAid automatically appends `/api` if omitted. |

#### Frontend SPA Rewrite Rule (Mandatory for Client Routing)

Because RapidAid is a Single Page Application using React Router, all sub-routes (e.g. `/dispatch`, `/emergencies`, `/tracking`) must be routed to `index.html`:

1. Navigate to your Static Site in Render Dashboard.
2. Go to **Redirects / Rewrites**.
3. Add a new rule:
   - **Type**: `Rewrite`
   - **Source Path**: `/*`
   - **Destination**: `/index.html`
4. Click **Save Changes**.

---

## 3. Pre-Deployment Verification Checklist

Before pushing live or switching traffic:

- [x] **Frontend Build Verification**: `npm run build` generates `dist/` cleanly in 9.9s.
- [x] **Backend Build Verification**: `npm --prefix server run build` compiles TypeScript cleanly.
- [x] **Backend Tests**: 45/45 tests passing in `vitest run`.
- [x] **Health Check Endpoint**: `GET /healthz` returns `200 OK` with `{ status: "ok" }`.
- [x] **Readiness Check Endpoint**: `GET /readyz` asserts live database connectivity and latency.
- [x] **Database Isolation**: Production startup asserts that `MONGODB_URI` does not target `rapidaid_phase1_test`.
- [x] **Seeding Invariant**: Production startup refuses to boot if `SEED_IF_EMPTY=true`.
- [x] **Dispatch Safety Invariant**: `AUTOMATED_DISPATCH_ENABLED` is strictly enforced to `false`.
- [x] **Security Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `X-Powered-By` disabled.
- [x] **No Secrets in Code**: All credentials injected via Render environment variables.
