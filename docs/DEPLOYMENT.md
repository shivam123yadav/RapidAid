# RapidAid — Production Deployment Architecture & Operations Guide

This guide details the production architecture, hosting recommendations, environment provisioning, container deployment, HTTPS/TLS reverse proxy configuration, and rollback procedures for RapidAid.

---

## 1. Production Architecture Overview

RapidAid employs a modern, three-tier decoupled micro-architecture designed for maximum reliability, low-latency telemetry ingestion, and horizontal scalability:

```
[ Internet Traffic / Clients ]
               │
               ▼ HTTPS (Port 443) / WSS
┌─────────────────────────────────────────────────────────────┐
│ Nginx Reverse Proxy & Edge Static Server (Alpine Container) │
│ - TLS Termination & Strict-Transport-Security               │
│ - SPA Static Asset Delivery (Gzip, Cache-Control, MIME)     │
│ - Content Security Policy (CSP) & Defense Headers           │
│ - Reverse Proxy `/api/` -> Backend with X-Request-ID        │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / Internal Bridge Network
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Node.js 22 Express Backend API (Alpine Container)           │
│ - Non-Root Process (`USER node`, UID 1000)                  │
│ - Fail-Fast Startup Validation (`env.ts`)                   │
│ - Token Rotation (Access: 15m, Refresh: 7d with SHA-256)    │
│ - Role-Based Access Control (RBAC) & Object Authorization   │
│ - Telemetry Ingestion (GPS Validation & Rate Limiting)      │
│ - Observability: Pino Structured Logging, `/metrics` (Prom) │
│ - Probes: `/healthz` (Liveness) & `/readyz` (Readiness)     │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼ TLS 1.3 (SRV)                ▼ HTTP / HTTPS
┌─────────────────────────────┐┌──────────────────────────────┐
│ Managed MongoDB Atlas       ││ External Services Integration│
│ - Dedicated App Credentials ││ - Self-Hosted OSRM Router    │
│ - TLS Encryption in Transit ││ - Twilio SMS Gateway         │
│ - Automated Hourly Snapshots││ - Amazon SES / SMTP Gateway  │
│ - Connection Pool (5–50)    ││ - Web Push (VAPID)           │
└─────────────────────────────┘└──────────────────────────────┘
```

---

## 2. Recommended Hosting Architecture

Based on evaluation of RapidAid's real-time emergency workloads:

1. **Database Persistence**: **MongoDB Atlas M10+ (Dedicated Cluster)**
   - Automatic cross-AZ failover and replica set redundancy.
   - WiredTiger cache management without host memory competition.
   - Point-in-time recovery (PITR) and automated daily/hourly snapshots.
   - Built-in TLS encryption in transit and AES-256 encryption at rest.

2. **Compute & Ingress**: **Containerized Virtual Private Server (VPS) or Managed Container Service**
   - **Recommended Standard**: AWS ECS / Fargate, Google Cloud Run, or a dedicated 2+ vCPU, 4GB RAM instance (e.g., AWS EC2 t4g.medium or Hetzner CX31) running Docker Compose.
   - **Ingress**: Reverse proxy managed by Nginx or Cloud Load Balancer (ALB) terminating TLS certificates via Let's Encrypt / Certbot or AWS Certificate Manager (ACM).

---

## 3. Environment Separation

Three strictly separated environments exist:

| Parameter | Development | Isolated Testing | Production |
| :--- | :--- | :--- | :--- |
| **`NODE_ENV`** | `development` | `test` | `production` |
| **Database** | `rapidaid` (local) | `rapidaid_phase1_test` (strictly isolated) | `rapidaid` (MongoDB Atlas Dedicated) |
| **Data Alteration** | Allowed (dev seeds) | Clean wipe before each test file | **Strictly preserved. Live records never altered** |
| **`SEED_IF_EMPTY`**| `true` allowed | `false` | **`false` strictly enforced at startup** |
| **`AUTOMATED_DISPATCH`** | `false` | `false` | **`false` strictly enforced (safety rule)** |
| **Secrets** | Dev defaults | In-memory test secrets | **Cryptographically random keys (`openssl rand -hex 32`)** |
| **CORS Origins** | `http://localhost:3000` | Mock / Test | **Strict explicit origin (no wildcards allowed)** |

> [!CAUTION]
> Production Startup Guard: `server/src/config/env.ts` immediately terminates (`process.exit(1)`) if `NODE_ENV=production` and `MONGODB_URI` targets `rapidaid_phase1_test` or any database containing `test`.

---

## 4. Production Docker Configuration

### Building Production Containers

```bash
# 1. Build backend image
docker build -t rapidaid-backend:latest ./server

# 2. Build frontend image (includes Vite build and optimized Nginx)
docker build -t rapidaid-frontend:latest .
```

### Running with Docker Compose Production Overlay

```bash
# Validate production compose configuration against environment file
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production config

# Launch services in detached mode
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d
```

### Container Health Probes

- **Liveness Probe**: `GET /healthz` (verifies HTTP server process responsiveness).
- **Readiness Probe**: `GET /readyz` (verifies MongoDB ping round-trip latency < 1000ms).
- **System Diagnostics**: `GET /api/system/health` (authenticated operator diagnostics).

---

## 5. Security & TLS Configuration

1. **HTTPS Enforcement**: Port 80 redirects immediately to port 443 with HTTP 301.
2. **HTTP Strict Transport Security (HSTS)**:
   ```nginx
   add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
   ```
3. **Defensive Response Headers**:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: SAMEORIGIN`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: camera=(self), microphone=(self), geolocation=(self), payment=()`
4. **Cookie Hardening**:
   - Refresh token cookie uses `HttpOnly`, `SameSite=Lax`, and `Secure=true` in production.
5. **Rate Limiting**:
   - Auth endpoints: 10 requests / 15 minutes per IP.
   - Telemetry ingestion: 120 updates / minute per ambulance unit.
   - General API: 300 requests / 15 minutes per IP.

---

## 6. Startup and Rollback Procedures

### Standard Zero-Downtime Deployment
1. Pre-deployment index verification:
   ```bash
   npm --prefix server run db:verify-indexes
   ```
2. Pull updated images and start replacement containers with healthcheck verification.
3. Drain existing connections (5-second grace period supported via SIGTERM).

### Rollback Procedure
If a production issue or regression is detected:
1. Immediately revert traffic to the previous known-healthy container image:
   ```bash
   docker tag rapidaid-backend:previous rapidaid-backend:latest
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
   ```
2. Database schema changes in RapidAid are strictly additive:
   - All migrations maintain backwards-compatible schema defaults.
   - No destructive schema migrations or field deletions are ever executed in rolling updates.
   - Refer to [docs/RUNBOOK.md](file:///d:/2_Project_build/workspace/docs/RUNBOOK.md) for database recovery procedures.
