# RapidAid — Production Operations & Disaster Recovery Runbook

This runbook defines standard operating procedures, backup/restore workflows, index maintenance, observability alerts, and failure-handling protocols for RapidAid.

---

## 1. Database Operations & Backup Strategy

### 1.1 MongoDB Atlas Automated Backups
- **Continuous Backups**: Enable Point-in-Time Recovery (PITR) with 7-day retention on MongoDB Atlas.
- **Scheduled Snapshots**: Hourly incremental snapshots retained for 72 hours; daily full snapshots retained for 30 days.

### 1.2 Manual Least-Privilege Backup (Logical Dump)
To perform an ad-hoc logical backup before a major operational milestone:
```bash
# Export all collections using the dedicated backup user credentials
mongodump \
  --uri="mongodb+srv://rapidaid_backup:<password>@<cluster>.mongodb.net/rapidaid" \
  --gzip \
  --archive="/backups/rapidaid-backup-$(date +%Y%m%d_%H%M%S).gz"
```

### 1.3 Database Restore Procedure
> [!CAUTION]
> Never restore into a live production database without taking a fresh pre-restore snapshot.

```bash
# Verify archive integrity and dry-run restore
mongorestore \
  --uri="mongodb+srv://admin:<password>@<cluster>.mongodb.net/rapidaid" \
  --gzip \
  --archive="/backups/rapidaid-backup-TARGET.gz" \
  --dryRun

# Execute restore with non-destructive drop-collection guard
mongorestore \
  --uri="mongodb+srv://admin:<password>@<cluster>.mongodb.net/rapidaid" \
  --gzip \
  --archive="/backups/rapidaid-backup-TARGET.gz" \
  --noIndexRestore
```

### 1.4 Post-Restore Index Synchronization
Immediately after restoring records, execute the verified index builder to ensure all compound and 2dsphere indexes are rebuilt in the background:
```bash
npm --prefix server run db:verify-indexes
```

---

## 2. Production Index Verification Runbook

All 11 collections require verified compound and unique indexes:
- **`User`**: `email: 1` (unique)
- **`Ambulance`**: `status: 1, active: 1`, `currentEmergency: 1`, `claimToken: 1`
- **`Emergency`**: `status: 1`, `idempotencyKey: 1` (unique, sparse), `confirmationOperationId: 1`, `citizenId: 1`
- **`Hospital`**: `active: 1, status: 1`, `geo: "2dsphere"` (sparse), `registrationNumber: 1` (unique partial)
- **`HospitalReservation`**: `emergencyId: 1, hospitalId: 1, resourceType: 1, status: 1`, `expiresAt: 1`
- **`Notification`**: `ownerId: 1, timestamp: -1`, `idempotencyKey: 1` (unique, sparse)
- **`AuditLog`**: `timestamp: -1`, `action: 1`, `actorId: 1`
- **`RefreshToken`**: `tokenHash: 1` (unique), `expiresAt: 1` (TTL)
- **`VoiceReport`**: `ownerId: 1, createdAt: -1`, `emergencyId: 1` (unique sparse), `dispatchStatus: 1`
- **`Counter` & `RolePolicy`**: `_id: 1`

### Execution Command:
```bash
npm --prefix server run db:verify-indexes
```

---

## 3. Observability, Metrics & Alerts

### 3.1 Prometheus Scraper Endpoint
- **URL**: `GET /metrics`
- **Authentication**: `Authorization: Bearer <METRICS_SCRAPE_TOKEN>` (Token must be >= 16 characters).
- **Format**: Standard Prometheus text format (0.0.4).

### 3.2 Recommended Alert Thresholds

| Metric | Condition | Severity | Action |
| :--- | :--- | :--- | :--- |
| **API Error Rate** | `rate(http_requests_total{status=~"5.."}[5m]) > 0.01` | **P1 - CRITICAL** | Check Pino application logs; inspect database connectivity. |
| **Database Latency** | `mongo_operation_duration_seconds{op="ping"} > 0.5` | **P2 - HIGH** | Check MongoDB Atlas connection pool and CPU utilization. |
| **Pool Checkout Timeout**| `increase(mongo_pool_checkout_failures_total[5m]) > 0` | **P2 - HIGH** | Increase `maxPoolSize` or investigate unclosed cursors/queries. |
| **Slow Request Watchdog**| Request duration > 10,000ms | **P2 - HIGH** | Inspect network latency to external routing or SMS services. |
| **Stranded Ambulance Sweeper**| Ambulances released by sweeper > 2 per hour | **P3 - MEDIUM** | Investigate network disconnections on crew tablet devices. |

---

## 4. Failure Scenarios & Self-Healing Handling

### 4.1 Database Disconnect / Failover
- **Behavior**: Mongoose automatically attempts reconnection.
- **Liveness (`/healthz`)**: Remains `HTTP 200` to prevent orchestrator (Docker/K8s) from crash-looping while the database recovers.
- **Readiness (`/readyz`)**: Returns `HTTP 503` so ingress traffic is temporarily buffered or routed to other healthy replicas.
- **Recovery**: Telemetry listeners re-establish client pool monitoring automatically upon `reconnected` event.

### 4.2 External Road Routing Failure (OSRM Outage)
- **Behavior**: If the primary routing provider is unresponsive or exceeds `ROUTING_TIMEOUT_MS` (4s), `routingService` safely catches the error and falls back to straight-line haversine distance and conservative road-factor duration.
- **Logging**: Logged at `warn` level with correlation ID; dispatcher map indicates calculated route degradation without blocking dispatch.

### 4.3 Notification Channel Failure
- **Behavior**: If SMS (Twilio) or Email (SMTP) rejects an alert, the centralized `notificationService` records the failure state (`FAILED`) and preserves the in-app notification (`DELIVERED`).
- **Safety**: Emergency creation, ambulance assignment, and hospital reservation are **NEVER** rolled back due to third-party notification transport failures.

---

## 5. Strict Safety Rules & Prohibitions

1. **Automated Dispatch**: `AUTOMATED_DISPATCH_ENABLED` must remain `false`. Every ambulance dispatch requires explicit human confirmation from an authorized dispatcher.
2. **Database Isolation**: Never point production configurations to `rapidaid_phase1_test`.
3. **Data Preservation**: Preserved records (e.g. `VR-004`, `EMG-20487`) must never be dropped or mutated.
4. **Credential Secrecy**: No production passwords, JWT secrets, or SMS tokens are committed to source control.
