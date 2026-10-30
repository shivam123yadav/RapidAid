# RapidAid — Render.com Free Staging Deployment Guide

This guide details the step-by-step instructions, environment configuration, and operational limitations for deploying RapidAid on **Render.com's Free Tier** for staging verification.

RapidAid is configured as two decoupled services:
1. **`rapidaid-api`**: Node.js Web Service (**Free Plan**) running the Express backend from `server/`
2. **`rapidaid-web`**: Static Site (**Free Tier**) serving the React/Vite SPA bundle from `dist/`

---

## 1. Quickstart: Render Blueprint (Infrastructure as Code)

RapidAid includes a declarative [`render.yaml`](file:///d:/2_Project_build/workspace/render.yaml) preconfigured for the Free plan.

1. Push your repository to GitHub: `https://github.com/shivam123yadav/RapidAid.git`.
2. In the Render Dashboard, click **New +** > **Blueprint**.
3. Connect your repository. Render automatically parses `render.yaml`.
4. Supply the required staging environment variables:
   - `MONGODB_URI`: Connection string pointing to your dedicated `rapidaid_staging` database on MongoDB Atlas.
   - `CORS_ORIGINS`: Your frontend URL (e.g. `https://rapidaid-web.onrender.com`).
   - `PUBLIC_URL`: Your frontend URL (e.g. `https://rapidaid-web.onrender.com`).
   - `VITE_API_BASE_URL`: Your backend URL (e.g. `https://rapidaid-api.onrender.com`).
5. Click **Apply**.

---

## 2. Manual Service Setup (Render Dashboard)

If configuring services manually via the Render Dashboard:

### 2.1 Backend: Node.js Web Service (`rapidaid-api`)

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Service Type** | **Web Service** | Backend API service |
| **Name** | `rapidaid-api` | Or `rapidaid-api-staging` |
| **Region** | Oregon (US West) or Frankfurt | Match your MongoDB Atlas staging cluster region |
| **Branch** | `main` or `master` | |
| **Root Directory** | `server` | **Mandatory**: Backend lives in the `server` directory |
| **Runtime** | **Node** | Node.js 20 or 22 |
| **Plan** | **Free ($0/mo)** | Supported on Render Web Services |
| **Build Command** | `npm ci && npm run build` | Compiles TypeScript into `dist/` |
| **Start Command** | `npm start` | Executes `node dist/index.js` |
| **Health Check Path**| `/healthz` | Unauthenticated orchestrator liveness probe |

#### Backend Environment Variables Checklist (Staging)

Set these in the **Environment** tab of `rapidaid-api`:

| Environment Variable | Value / Format | Purpose & Safety Constraints |
| :--- | :--- | :--- |
| **`NODE_ENV`** | `production` | Enables production security mode and fail-fast assertions |
| **`HOST`** | `0.0.0.0` | Binds to all interfaces |
| **`PORT`** | *(Leave empty / automatic)* | Render automatically assigns `PORT` (e.g. 10000) |
| **`MONGODB_URI`** | `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/rapidaid_staging?retryWrites=true&w=majority` | **Target database MUST be `rapidaid_staging`. Never use `rapidaid_phase1_test` or `rapidaid_test`.** |
| **`JWT_ACCESS_SECRET`** | Min 32 cryptographically random chars (`openssl rand -hex 32`) | Signs access tokens. Rejects weak placeholders. |
| **`JWT_REFRESH_SECRET`**| Min 32 cryptographically random chars (`openssl rand -hex 32`) | Signs refresh tokens. Rejects weak placeholders. |
| **`ACCESS_TOKEN_TTL`** | `15m` | Lifetime of short-lived access JWT |
| **`REFRESH_TOKEN_TTL_DAYS`**| `7` | Lifetime of refresh tokens |
| **`CORS_ORIGINS`** | `https://rapidaid-web.onrender.com` | **Allowed frontend origin. Wildcard `*` strictly forbidden.** |
| **`PUBLIC_URL`** | `https://rapidaid-web.onrender.com` | Frontend URL for email action links |
| **`TRUST_PROXY_HOPS`** | `1` | Enables accurate client IP derivation behind Render proxy |
| **`SEED_IF_EMPTY`** | `false` | **Safety rule: Must be false. Server aborts if true.** |
| **`AUTOMATED_DISPATCH_ENABLED`**| `false` | **Safety rule: Automated dispatch forbidden. Must remain false.** |
| **`RATE_LIMIT_DISABLED`**| `false` | Enforces rate limiting against brute force |
| **`LOG_LEVEL`** | `info` | Structured JSON log verbosity |
| **`ROUTING_PROVIDER_TYPE`**| `osrm` | Road routing provider |
| **`ROUTING_PROVIDER_URL`** | `https://router.project-osrm.org` | Routing provider endpoint (falls back safely to haversine) |

---

### 2.2 Frontend: Static Site (`rapidaid-web`)

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Service Type** | **Static Site** | React SPA frontend (**100% Free on Render**) |
| **Name** | `rapidaid-web` | Or `rapidaid-web-staging` |
| **Branch** | `main` or `master` | |
| **Root Directory** | *(Leave empty - repo root)* | |
| **Build Command** | `npm ci && npm run build` | Syncs offline voice models and builds Vite bundle |
| **Publish Directory** | `dist` | Generated static bundle |
| **Redirects / Rewrites** | **Rewrite `/*` to `/index.html`** | **Mandatory for React Router SPA navigation** |

#### Frontend Environment Variables

Set this in the **Environment** tab of `rapidaid-web`:

| Environment Variable | Value | Notes |
| :--- | :--- | :--- |
| **`VITE_API_BASE_URL`** | `https://rapidaid-api.onrender.com` | URL of your deployed backend service. RapidAid automatically normalizes and appends `/api` if omitted. |

#### Frontend SPA Rewrite Rule Configuration

1. In Render Dashboard, open your Static Site (`rapidaid-web`).
2. Go to **Redirects / Rewrites** in the sidebar.
3. Click **Add Rule**:
   - **Type**: `Rewrite`
   - **Source**: `/*`
   - **Destination**: `/index.html`
4. Click **Save Changes**.

---

## 3. Render Free Plan Characteristics & Limitations

Operating on Render's Free tier entails specific platform behaviors that staging operators should understand:

### 3.1 Spin-Down on Inactivity (Cold Starts)
- **Behavior**: Free Web Services automatically spin down after **15 minutes of zero incoming traffic**.
- **Cold Start Delay**: The next incoming request spins the container back up, resulting in a **30–50 second delay** for that initial request.
- **Handling in RapidAid**: The frontend HTTP client ([`src/api/client.ts`](file:///d:/2_Project_build/workspace/src/api/client.ts)) is designed for resilience; if a network timeout occurs during spin-up, user retry succeeds immediately once the container is active.
- **Health Check (`/healthz`)**: Render's health check runs during deployment and does not prevent spin-down during inactivity.

### 3.2 Free Usage Quotas
- **Monthly Compute Hours**: Render provides **750 free instance hours per month** across all free web services in an account. A single staging backend running continuously will consume ~720–744 hours per month.
- **Bandwidth**: Static Sites include **100 GB/month** of free outbound bandwidth.
- **Build Minutes**: 500 build minutes per month included.

### 3.3 Hardware Constraints
- **Compute**: 0.1 CPU, **512 MB RAM**.
- **Memory Footprint**: RapidAid backend uses approximately **65 MB–95 MB RSS baseline**, leaving over 400 MB headroom.
- **Payload Bounds**: The `256kb` JSON limit on standard routes and streaming upload handlers protect the container from memory pressure.

### 3.4 Ephemeral Filesystem
- **Behavior**: Free Web Services have no persistent disk storage. Files written to local disk are wiped on restart.
- **Handling in RapidAid**: Stored voice recordings in staging use the local ephemeral storage path (`/app/storage/voice` or tmp). In production, cloud object storage (S3/GCS) is used.

### 3.5 No Shell / SSH Access
- Render Free tier does not provide SSH container shell access. All diagnostics are performed via Render's live log stream and the authenticated `/api/system/health` endpoint.

---

## 4. Staging Database Separation & Isolation

- **Target Database**: `rapidaid_staging` on MongoDB Atlas (e.g. M0 Free Tier or M10).
- **Test Database Isolation**:
  [`server/src/config/env.ts`](file:///d:/2_Project_build/workspace/server/src/config/env.ts) strictly aborts startup if `MONGODB_URI` contains `rapidaid_phase1_test`, `rapidaid_test`, or ends with `_test`.
- **Seeding Guard**: `SEED_IF_EMPTY=false` prevents accidental seeding of demo credentials.
- **Dispatch Safety Guard**: `AUTOMATED_DISPATCH_ENABLED=false` guarantees that ambulances are never dispatched automatically.

---

## 5. Pre-Deployment Verification

All build and test suites pass cleanly locally:
- Frontend build: `npm run build` (Clean exit in 9.6s)
- Backend build: `npm --prefix server run build` (Clean exit 0)
- Frontend tests: `npx vitest run` (13/13 passed)
- Backend tests: `npm --prefix server run test` (11/11 passed in `phase4-production-readiness.test.ts`)
- Production Index Verification: `npm --prefix server run db:verify-indexes` (11/11 collections verified)
