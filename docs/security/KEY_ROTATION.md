# RapidAid V2 — Cryptographic Key-Rotation Runbook

**Audience:** Security Engineers, DevOps Engineers, and System Operators  
**Scope:** RapidAid V2 Cryptographic Subsystems (JWT Access Secrets, Refresh Token Lifecycles, and AES-256-GCM Backup Encryption Keys)  
**Security Classification:** Operational Security Policy  

---

## 1. Executive Summary & Cryptographic Inventory

RapidAid V2 uses distinct cryptographic mechanisms across application sessions and disaster recovery. Operators must understand the differing operational characteristics of each key:

| Key / Secret | Environment Variable | Cryptographic Primitive | Storage & Enforcement | Rotation Impact |
|---|---|---|---|---|
| **JWT Access Secret** | `JWT_ACCESS_SECRET` | HMAC-SHA256 (HS256) | Process environment; stateless validation | Immediate access-token invalidation; seamless client recovery via refresh token |
| **Refresh Secret (Config)** | `JWT_REFRESH_SECRET` | Configuration placeholder | Validated by schema at boot; **unused in runtime logic** | **Zero impact** on active sessions (see Section 3) |
| **Refresh Tokens (Session)** | Client HTTP-only Cookie (`rapidaid_rt`) | 48-byte cryptographically secure random string | SHA-256 hash stored in MongoDB `refreshtokens` collection | Single-use rotation on every refresh; revocation via `tokenVersion` |
| **Backup Encryption Key** | `BACKUP_ENCRYPTION_KEY` | AES-256-GCM (payloads) + HMAC-SHA256 (manifests) | Process environment; vault escrow required | Future backups use new key; historical backups require historical key matching `keyId` |

---

## 2. JWT Access Secret Rotation (`JWT_ACCESS_SECRET`)

### 2.1. Mechanism & Operational Impact
- **Token Format:** Signed JSON Web Token (JWT) with HS256 algorithm and 15-minute default time-to-live (`ACCESS_TOKEN_TTL=15m`).
- **Validation Path:** `server/src/middleware/auth.ts` calls `jwt.verify(token, env.JWT_ACCESS_SECRET)`.
- **Immediate Effect of Rotation:**  
  Any access token signed with the previous secret ($K_{\text{old}}$) fails signature verification. The API immediately returns HTTP `401 Unauthorized` with error code `ERR_TOKEN_INVALID`.
- **Client Recovery Invariant:**  
  The frontend API client (`src/api/client.ts`) catches the 401 response and automatically issues a `POST /api/auth/refresh` request. Because refresh tokens are validated against SHA-256 hashes in MongoDB (independent of `JWT_ACCESS_SECRET`), the refresh succeeds and issues a brand-new access token signed with $K_{\text{new}}$. End-users experience **zero logout interruption**.

### 2.2. Standard Operating Procedure (Scheduled Rotation)
1. **Preconditions:**
   - Confirm backend services are healthy (`GET /healthz` and `GET /readyz` return 200).
   - Generate a cryptographically secure 256-bit (64-character hex) secret without disclosing it in shell history or shared channels:
     ```bash
     node -e "console.log(crypto.randomBytes(32).toString('hex'))"
     ```
2. **Execution:**
   - Update `JWT_ACCESS_SECRET` in the secure configuration vault (e.g. AWS Secrets Manager or environment file).
   - Perform a rolling restart of backend API instances.
3. **Post-Rotation Verification:**
   - Inspect API logs for successful startup (`RapidAid API listening on http://localhost:5000`).
   - Execute a synthetic login and verify access token issuance.
   - Verify that an active session successfully refreshes its token via `POST /api/auth/refresh`.

---

## 3. Refresh Token Lifecycle & Session Revocation

### 3.1. Verified Architectural Behavior
- **Implementation Detail:** In `server/src/services/tokenService.ts`, refresh tokens are **not** signed JWTs. They are generated via `crypto.randomBytes(48).toString('hex')`.
- **Storage:** The plain token is sent solely as an HTTP-only, `sameSite: 'lax'` cookie (`rapidaid_rt`). The server persists only the SHA-256 hash in MongoDB:
  ```ts
  await RefreshToken.create({
    tokenHash: sha256(refreshToken),
    userId: payload.sub,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  ```
- **`JWT_REFRESH_SECRET` Clarification:** While `JWT_REFRESH_SECRET` is declared in `server/src/config/env.ts` and validated at boot, it is **never read or evaluated** during refresh token issuance, rotation, or verification. Rotating `JWT_REFRESH_SECRET` in `.env` has **no effect** on active sessions.

### 3.2. Routine Session Invalidation (Per-User)
- User logout calls `invalidateAccessToken` (`server/src/services/tokenService.ts`), which increments `User.tokenVersion` in MongoDB and deletes the single presented refresh token record via `RefreshToken.deleteOne({ tokenHash })`.
- Any existing access tokens for that user fail version matching (`decoded.ver !== user.tokenVersion`), ensuring immediate session termination across all devices.

### 3.3. Emergency Global Session Revocation (Incident Response)
> [!CAUTION]
> This is a destructive administrative action reserved exclusively for confirmed security breaches (e.g. database compromise or bulk credential leakage). It immediately logs out every connected user across the network.

When explicitly authorized by the Incident Commander:
1. Invalidate all active refresh tokens in MongoDB:
   ```javascript
   // mongosh on target database:
   db.refreshtokens.deleteMany({});
   ```
2. Force token-version invalidation on all user accounts:
   ```javascript
   db.users.updateMany({}, { $inc: { tokenVersion: 1 } });
   ```
3. Rotate `JWT_ACCESS_SECRET` as described in Section 2.
4. All existing sessions are terminated; every user must re-authenticate with their credentials.

---

## 4. Backup Encryption Key Lifecycle & Rotation (`BACKUP_ENCRYPTION_KEY`)

### 4.1. Mechanism & Key Identification
- **Algorithm:** AES-256-GCM authenticated payload encryption.
- **Key Requirement:** 256-bit key formatted as a 64-character hexadecimal string.
- **Key Identifier (`keyId`):** Automatically derived using domain-separated hashing:
  ```javascript
  deriveKeyId(keyHex) = 'kid_' + sha256('rapidaid-key-v1:' + keyHex).slice(0, 16);
  ```
- **Manifest Authentication:** `scripts/backup-db.mjs` derives an authentication key via `HMAC-SHA256('rapidaid-manifest-auth-v1', keyBuffer)` and signs the canonicalized manifest.

### 4.2. Historical Recovery Constraint & Key Escrow Policy
- **Immutable Historical Ciphertext:**  
  Rotating `BACKUP_ENCRYPTION_KEY` in `.env` encrypts future backups under the new key ($K_{\text{new}}$) and generates a new `keyId`. It does **not** re-encrypt historical backup archives.
- **Preflight Fail-Closed Gate:**  
  During disaster recovery (`scripts/restore-db.mjs`), preflight inspects `manifest.encryption.keyId` and computes `suppliedKeyId` from the active environment key. If they mismatch:
  ```text
  CRITICAL SECURITY ABORT: Key ID mismatch. Manifest requires key 'kid_abc...', but supplied key produces 'kid_xyz...'.
  ```
  Execution halts before scratch directory creation, decryption, or archive extraction.
- **Mandatory Key Escrow Procedure:**  
  1. Operators must archive every historical `BACKUP_ENCRYPTION_KEY` in a secure offline vault (e.g. AWS Secrets Manager or hardware security module), indexed by its derived `keyId`.
  2. To restore an archive created under key ID `kid_2026_q1`, the operator must retrieve the corresponding key from the vault and configure `BACKUP_ENCRYPTION_KEY` prior to launching `restore-db.mjs`.

### 4.3. Standard Key-Rotation Procedure (Backups)
1. Generate a fresh 64-character hex key:
   ```bash
   node -e "console.log(crypto.randomBytes(32).toString('hex'))"
   ```
2. Compute and record its `keyId`:
   ```bash
   node -e "const c = require('crypto'); console.log('kid_' + c.createHash('sha256').update('rapidaid-key-v1:' + '<NEW_KEY>').digest('hex').slice(0, 16))"
   ```
3. Escrow both the new key and previous keys in the secret management vault.
4. Update `BACKUP_ENCRYPTION_KEY` in the backup scheduler environment.
5. Trigger an on-demand backup (`npm run backup`) and verify that:
   - The backup succeeds with exit code 0.
   - The generated `manifest-*.json` contains the new `keyId`.
   - The manifest HMAC signature validates cleanly.

---

## 5. Security Checklist & Prohibitions

- [x] **Never print or log keys:** Script outputs and error traces must sanitize credentials (verified in `scripts/verify-backup-restore.mjs` safeguard 0D).
- [x] **Never commit keys to version control:** Keep `.env`, `.env.docker`, and backup archives excluded in `.gitignore`.
- [x] **Do not delete collections for routine maintenance:** Use application-level `tokenVersion` increments for session management.
- [x] **Always verify preflights:** Never bypass `restore-db.mjs` key ID validation flags in production environments.

