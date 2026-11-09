# Private Family Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 9Drive fork into a closed, admin-managed family drive where every file is encrypted before reaching Google or S3 and stored as two copies on different accounts.

**Architecture:** Pure, tested modules (frame crypto, range mapping, pool selection) sit under thin Express routes. A `StorageProvider` interface hides Google and S3, and has an in-memory implementation for tests. The upload path encrypts client chunks and writes them to two providers at once; the read path maps plaintext ranges to frames and decrypts with failover.

**Tech Stack:** Express 5, TypeScript (NodeNext), Prisma 6, MySQL 8, googleapis, AWS SDK, React 19, Vite, Tailwind 4, `node:test` through `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-10-private-family-drive-design.md`

## Global Constraints

- Work on branch `family-drive`; never commit to `main`. Never push: `origin` is the upstream repo.
- Frame size exactly 1,048,576 bytes; overhead 28 bytes (12 nonce + 16 tag); `P` = 1,048,548 plaintext bytes per frame.
- Browser chunk = 8 × `P` = 8,388,384 plaintext bytes = 8 MiB encrypted. It satisfies Google's 256 KiB multiple and S3's 5 MiB minimum part.
- No plaintext, real filename or real MIME type sent to any provider. Provider name: 32 random hex chars + `.bin`. Provider MIME: `application/octet-stream`.
- No `drive.permissions.create` call may exist anywhere in `backend/src`.
- No uploaded data on disk. No raw tokens, keys or session URIs in logs.
- `.js` suffix on relative backend imports; Zod on all inputs; BigInt as string in JSON; errors as `{ code, message }`; schema changes through Prisma migrations only.
- No new runtime dependencies.
- Tests live in `backend/test/` (outside `tsc` `rootDir`). Unit: `cd backend && npm test`. Integration: `cd backend && npm run test:integration`, requires MySQL.
- Preserve the current Tailwind visual style and existing UI primitives.

## Review Focus

- A browser seeks with `bytes=-500`, `bytes=N-` at the final byte, a range across a frame boundary, or a range past EOF: correct 206 bytes or 416. (Task 2)
- A chunk retries after a dropped connection while one copy is ahead of the other: final blobs on both accounts decrypt cleanly. (Task 7)
- A disabled user holding a live access token, API key, or public links: rejected immediately, and their public links return 404. (Task 4, Task 8)
- Admin disables, demotes or deletes the last active admin, including themself: refused with `LAST_ADMIN`. (Task 4)
- A zero-byte file is uploaded: refused with the existing `UPLOAD_SIZE_REQUIRED` and a clear UI error, never a silently broken file. (Task 7)

---

### Task 1: Test harness and frame crypto

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/modules/crypto/frames.ts`, `backend/src/modules/crypto/keys.ts`
- Test: `backend/test/frames.test.ts`, `backend/test/keys.test.ts`

**Interfaces:**
- Produces, from `frames.ts` (no `env` import):
  - constants `FRAME_SIZE`, `FRAME_OVERHEAD`, `FRAME_PLAINTEXT`, `UPLOAD_CHUNK_PLAINTEXT`
  - `frameCount(plainSize: bigint): bigint`, `encryptedSize(plainSize: bigint): bigint`
  - `encryptFrame(fileKey: Buffer, fileId: string, index: number, isFinal: boolean, plaintext: Buffer): Buffer`
  - `decryptFrame(fileKey: Buffer, fileId: string, index: number, isFinal: boolean, frame: Buffer): Buffer`
  - `class FrameAuthError extends Error`
- Produces, from `keys.ts` (pure, master passed in):
  - `parseMasterKey(base64: string): Buffer` (throws unless 32 bytes)
  - `deriveUserKey(master: Buffer, userId: string): Buffer` (HKDF-SHA256, info `family-drive/user/v1`)
  - `newFileKey(userKey: Buffer): { fileKey: Buffer; wrapped: string }`
  - `unwrapFileKey(userKey: Buffer, wrapped: string): Buffer`
  - `masterFingerprint(master: Buffer): string` (HMAC-SHA256 of a fixed label, hex; never the key itself)

- [ ] **Step 1: Create branch and add scripts**

`git checkout -b family-drive`. Add to `backend/package.json`: `"test": "node --import tsx --test test/*.test.ts"` and `"test:integration": "node --import tsx --test --test-concurrency=1 test/integration/*.test.ts"`.

- [ ] **Step 2: Write failing tests**

`frames.test.ts`: `frameCount(1n) === 1n`; `frameCount(BigInt(FRAME_PLAINTEXT)) === 1n`; `frameCount(BigInt(FRAME_PLAINTEXT) + 1n) === 2n`; `encryptedSize(BigInt(FRAME_PLAINTEXT)) === 1048576n`; round trip full frame and short final frame; encrypting twice with same inputs is byte-identical; different plaintext at same index gives a different nonce (first 12 bytes differ); `decryptFrame` throws `FrameAuthError` for flipped bit, wrong index, wrong fileId, and `isFinal` mismatch.

`keys.test.ts`: user keys differ by userId and are stable; `unwrapFileKey` round trip; unwrap under another user's key throws; `parseMasterKey` rejects 31 bytes; fingerprint does not contain the key's hex.

- [ ] **Step 3: Run, verify failure**

Run: `cd backend && npm install && npm test`. Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

Nonce: first 12 bytes of HMAC-SHA256 under a nonce key, over the 4-byte big-endian index and plaintext. Nonce key: HKDF of the file key, info `nonce`. Encryption key: HKDF of the file key, info `data`. AAD: UTF-8 fileId, then 4-byte big-endian index, then 1 byte final flag. Frame: nonce, ciphertext, tag. Wrapping: AES-256-GCM with random IV, serialised like `encryptText`.

- [ ] **Step 5: Run, verify pass; commit**

`npm test` passes. `git commit -m "feat(crypto): add frame encryption and key hierarchy"`.

### Task 2: Range mapping

**Files:**
- Create: `backend/src/modules/crypto/range.ts`
- Test: `backend/test/range.test.ts`

**Interfaces:**
- Produces:
  - `type ByteRange = { start: bigint; end: bigint }` (inclusive)
  - `parseRange(header: string | undefined, size: bigint): ByteRange | null | 'unsatisfiable'` (`null` = whole file)
  - `frameSpan(range: ByteRange): { firstFrame: number; lastFrame: number; cipherStart: bigint; cipherEnd: bigint; skipHead: number }` (`cipherEnd` inclusive)

- [ ] **Step 1: Write failing tests**

For size `s = 3n * P + 10n`: no header gives `null`; `bytes=0-0`; `bytes=-500` gives `{ start: s-500n, end: s-1n }`; `bytes=-99999999` clamps to the whole file; `bytes=5-` ends at `s-1n`; `bytes=s-` is `'unsatisfiable'`; end beyond size clamps; malformed and multi-range headers give `null`. `frameSpan({start: P-1n, end: P})` gives frames 0 and 1, `skipHead === P-1`, `cipherStart === 0n`, `cipherEnd === 2097151n`.

- [ ] **Step 2: Run, verify failure. Step 3: Implement. Step 4: Run, verify pass**

Clamp `cipherEnd` to the real blob end at read time (Task 8), since the final frame is shorter.

- [ ] **Step 5: Commit** `feat(crypto): map plaintext ranges to frames`

### Task 3: Additive schema and key boot check

**Files:**
- Modify: `backend/prisma/schema.prisma`, `backend/src/config/env.ts`, `backend/src/server.ts`
- Create: new Prisma migration, `backend/src/modules/crypto/file-keys.ts`

**Interfaces:**
- Produces, in `file-keys.ts`: `createFileKey(userId: string): { fileKey: Buffer; wrapped: string }`, `openFileKey(userId: string, wrapped: string): Buffer`, `assertMasterKeyMatches(): Promise<void>`.
- Produces Prisma additions. Keep the old `File` columns until Task 9 so the build stays green:
  - `User`: `role` (default `member`), `mustChangePassword` (default false), `storageLimitBytes BigInt?`
  - `ConnectedAccount`: `capBytes BigInt?`, `pausedUntil DateTime?`
  - `File`: `wrappedFileKey @db.Text` nullable for now, `encryptedSizeBytes BigInt?`, `encVersion Int @default(1)`
  - `UploadSession`: `fileId @db.Char(36)` nullable, `wrappedFileKey @db.Text` nullable
  - `AppSetting`: `id Int @id @default(1)`, `defaultAccountCapBytes BigInt?`, `masterKeyFingerprint String?`, global routing fields `routingMode` (default `most_available`), `priorityAccountIds Json`, `roundRobinCursor Int @default(0)`
  - `FileReplica`: `id`, `fileId` (cascade), `connectedAccountId` (cascade), `providerFileId`, `status` (`healthy` or `lost`), `sizeBytes BigInt`, `@@unique([fileId, connectedAccountId])`, index on `[connectedAccountId, status]`
  - `UploadSessionReplica`: `id`, `uploadSessionId` (cascade), `connectedAccountId`, `sessionUriEncrypted @db.Text?`, `s3UploadId?`, `providerFileId?`, `reservedBytes BigInt`, `partEtags Json?`
  - `OrphanBlob`: `id`, `connectedAccountId` (cascade), `providerFileId`, `createdAt`
  - `RepairJob`: `id`, `status` (`running`, `done`, `failed`), `processed Int`, `failed Int`, timestamps

- [ ] **Step 1: Edit schema; add `FILE_MASTER_KEY: z.string()` validated by `parseMasterKey` in env**
- [ ] **Step 2: Migrate**

Run: `cd backend && npx prisma migrate dev --name family_drive_additive`. Expected: migration applied, client generated.

- [ ] **Step 3: Implement `assertMasterKeyMatches`**

Upsert `AppSetting` id 1. Store the fingerprint if null. Throw on mismatch. Call it in `server.ts` before `listen`, so a mismatch stops the process.

- [ ] **Step 4: Verify**

Run: `npm run build`. Expected: success. Start the server twice with a changed `FILE_MASTER_KEY`. Expected: second start exits with a key mismatch error.

- [ ] **Step 5: Commit** `feat(db): add replicas, caps, roles and master key check`

### Task 4: Closed auth and admin users

**Files:**
- Create: `backend/src/middleware/admin.middleware.ts`, `backend/src/modules/admin/admin-users.routes.ts`, `backend/src/modules/admin/admin-rules.ts`, `backend/src/scripts/create-admin.ts`, `backend/src/utils/rate-limit.ts`
- Modify: `backend/src/middleware/auth.middleware.ts`, `backend/src/middleware/api-key.middleware.ts`, `backend/src/modules/auth/auth.routes.ts`, `backend/src/modules/system/system.routes.ts`, `backend/src/modules/provider-configs/provider-config.routes.ts`, `backend/src/app.ts`, `backend/package.json`
- Test: `backend/test/admin-rules.test.ts`, `backend/test/rate-limit.test.ts`, `backend/test/integration/access.test.ts`

**Interfaces:**
- Produces:
  - `requireAdmin` (runs after `requireAuth`, 403 `ADMIN_REQUIRED`); `AuthRequest.user` gains `role`
  - `requireAuth` responds 403 `PASSWORD_CHANGE_REQUIRED` while `mustChangePassword` is set, except `/auth/change-password`, `/auth/me`, `/auth/logout`
  - `assertNotLastAdmin(activeAdminCount: number, target: { role: string; status: string }): void` throws an error with code `LAST_ADMIN`
  - `createLoginLimiter(max: number, windowMs: number): { check(key: string, now: number): boolean; reset(key: string): void }`, limits 5 failures per 15 minutes per email + IP, in memory
  - Routes at `/admin/users`: `GET /`, `POST /` (`name,email,temporaryPassword,storageLimitBytes|null`), `PATCH /:id` (`storageLimitBytes,status`), `POST /:id/reset-password`, `DELETE /:id`. Listing returns usage totals only, never file names.
  - `POST /auth/change-password`; `/auth/me` and login response include `role`, `mustChangePassword`
  - `npm run admin:create -- --email e --name n` reads the password from a prompt, not argv

- [ ] **Step 1: Write failing unit tests**

`assertNotLastAdmin`: count 1, active admin target throws `LAST_ADMIN`; count 2 passes; member target passes. Limiter: 5 failures allowed, 6th blocked, unblocked after the window, `reset` clears it.

- [ ] **Step 2: Write failing integration test `access.test.ts`**

Against real MySQL and the app. Assert: `POST /auth/register` 404; `GET /auth/google/url` 404; member calling `/admin/users`, `/system/google-config`, `/provider-configs`, `POST /connected-accounts/s3` gets 403; new user with `mustChangePassword` gets 403 on `/files` until changed; after `reset-password`, old refresh and access tokens fail; a disabled user's access token and API key fail on the next request; disabling the last admin gives `LAST_ADMIN`; admin `GET /admin/users` body contains no file name of a seeded file.

- [ ] **Step 3: Run, verify failures**

Run: `npm test`, then `docker compose up -d mysql && npm run test:integration`. Expected: FAIL.

- [ ] **Step 4: Implement**

Delete `/register` and `/auth/google/*` routes, `verifyCaptcha`, `RECAPTCHA_SECRET_KEY`, and AuthHandoff usage. Remove `/system/update`, `/update-log`, `/backup`, `/restore`. Gate remaining `system` and `provider-configs` routes with `requireAdmin`. In `requireAuth` and the API key middleware, load the user and reject non-`active` with 403 `USER_DISABLED`. Delete-user permanent file removal is wired in Task 9; until then refuse deleting users who own files.

- [ ] **Step 5: Run, verify pass; commit** `feat(auth): close sign-up and add admin user management`

### Task 5: Shared pool, caps and pair selection

**Files:**
- Create: `backend/src/modules/storage/pool.ts`, `backend/src/modules/storage/pool-select.ts`, `backend/src/modules/admin/admin-storage.routes.ts`
- Modify: `backend/src/modules/storage/storage.routes.ts`, `backend/src/modules/connected-accounts/connected-account.routes.ts`, `backend/src/modules/system/system.routes.ts:149-153`, `backend/src/app.ts`
- Test: `backend/test/pool-select.test.ts`

**Interfaces:**
- Produces, in `pool-select.ts` (pure):
  - `type Candidate = { id: string; provider: string; createdAt: Date; capBytes: bigint | null; appStoredBytes: bigint; providerFreeBytes: bigint | null; reservedBytes: bigint; pausedUntil: Date | null }`
  - `effectiveFree(c: Candidate): bigint | null` (null = unlimited)
  - `pickPair(cs: Candidate[], needBytes: bigint, policy: { mode: 'most_available' | 'round_robin' | 'priority'; priorityAccountIds: string[]; cursor: number }, now: Date): [string, string] | null`
  - `usablePoolBytes(cs: Candidate[], now: Date): bigint | null`
- Produces, in `pool.ts`:
  - `loadCandidates(tx?): Promise<Candidate[]>`: all connected accounts, resyncing quota older than 5 minutes outside any transaction
  - `reserveUpload(args: { userId: string; plainSize: bigint; fileName: string; mimeType: string; folderId: string | null }): Promise<{ session: UploadSession; fileKey: Buffer; accounts: [ConnectedAccount, ConnectedAccount] }>` throwing codes `NO_ACCOUNT_WITH_ENOUGH_SPACE`, `USER_STORAGE_LIMIT_REACHED`
  - `userStorage(userId): Promise<{ usedBytes: bigint; limitBytes: bigint | null; availableBytes: bigint | null }>`
- Routes at `/admin/storage`: `GET /accounts` (cap, stored, effective free, status, Full flag, lost-copy count), `PATCH /accounts/:id` (`capBytes`), `GET|PATCH /settings` (default cap, routing). `GET /storage/summary` for members returns only `userStorage`.

- [ ] **Step 1: Write failing tests**

`effectiveFree`: cap 20 GB, stored 19 GB, provider free 100 GB gives 1 GB; cap null, provider free 5 GB gives 5 GB; reserved subtracts; cap below stored gives 0n; both unknown gives null. `pickPair`: returns two distinct ids; one eligible account gives null; paused account skipped until `pausedUntil` passes; account lacking room skipped; `most_available` picks the two largest; `priority` follows order; `round_robin` advances with cursor; null free is preferred as `most_available` first only when provider is `s3`, matching existing behaviour.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

`reserveUpload` runs a transaction, first `SELECT id FROM app_settings WHERE id = 1 FOR UPDATE`, so concurrent uploads serialize. Reserved bytes = `reservedBytes` on `UploadSessionReplica` joined to sessions with status `uploading` younger than 7 days. `appStoredBytes` = sum of `healthy` replica sizes on the account. On Google connect, copy `AppSetting.defaultAccountCapBytes` to `capBytes` only when the row is new; reconnecting keeps the existing cap. Gate all `/connected-accounts` routes except the OAuth callback with `requireAdmin`, and stop filtering them by `userId`. Change scope list to `drive.file`, `userinfo.email`, `userinfo.profile`. Delete `routing-policy` per-user routes.

- [ ] **Step 4: Run, verify pass; `npm run build` passes. Step 5: Commit** `feat(storage): shared account pool with caps and pair routing`

### Task 6: Storage provider layer

**Files:**
- Create: `backend/src/modules/storage/provider.ts`, `backend/src/modules/storage/google-provider.ts`, `backend/src/modules/storage/s3-provider.ts`, `backend/src/modules/storage/memory-provider.ts`
- Modify: `backend/src/modules/s3/s3.service.ts`, `backend/src/modules/google/google.service.ts`
- Test: `backend/test/memory-provider.test.ts`

**Interfaces:**
- Produces, in `provider.ts`:
```ts
export type ReplicaUploadState = { sessionUri?: string; s3UploadId?: string; providerFileId?: string; partEtags?: string[] }
export interface StorageProvider {
  beginUpload(account: ConnectedAccount, blobName: string, encryptedSize: bigint): Promise<ReplicaUploadState>
  putChunk(account: ConnectedAccount, state: ReplicaUploadState, offset: bigint, chunk: Buffer, totalSize: bigint): Promise<{ state: ReplicaUploadState; complete: boolean }>
  committedOffset(account: ConnectedAccount, state: ReplicaUploadState, totalSize: bigint): Promise<bigint>
  abortUpload(account: ConnectedAccount, state: ReplicaUploadState): Promise<void>
  readRange(account: ConnectedAccount, providerFileId: string, start: bigint, end: bigint): Promise<Readable>
  deleteBlob(account: ConnectedAccount, providerFileId: string): Promise<void>
}
export function providerFor(account: Pick<ConnectedAccount, 'provider'>): StorageProvider
export function setTestProvider(p: StorageProvider | null): void
export class ProviderQuotaError extends Error {}
export class ProviderUnavailableError extends Error {}
```

- [ ] **Step 1: Write failing tests for memory provider**

`putChunk` at the wrong offset throws; sequential chunks complete at `totalSize`; `committedOffset` reports progress; `readRange` is inclusive; `deleteBlob` then read throws `ProviderUnavailableError`; a simulated partial commit (test hook) leaves `committedOffset` on a 256 KiB multiple short of a sent chunk.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

Google: resumable session with name and `application/octet-stream` only, parent from `ensureGoogleAppFolder`. Map 403 with reasons `userRateLimitExceeded`, `dailyLimitExceeded`, `uploadQuotaExceeded` to `ProviderQuotaError`. Map 401, 404 and token refresh failure to `ProviderUnavailableError`. S3: `CreateMultipartUpload`, `UploadPart` where part number = `offset / 8 MiB + 1` (idempotent on retry), `ListParts` for `committedOffset`, complete on the last part. `buildS3ObjectKey` takes only `prefix` and a blob name. Remove `syncGoogleAppFolderFiles`.

- [ ] **Step 4: Run, verify pass. Step 5: Commit** `feat(storage): add provider interface for blobs`

### Task 7: Encrypted two-copy upload pipeline

**Files:**
- Create: `backend/src/modules/uploads/encrypted-upload.ts`
- Modify (rewrite): `backend/src/modules/uploads/upload.routes.ts`; `backend/src/modules/public-api/public-api.routes.ts` if needed
- Test: `backend/test/integration/upload.test.ts`

**Interfaces:**
- Consumes: `reserveUpload`, `providerFor`, frame functions.
- Produces:
  - `writeEncryptedChunk(sessionId: string, plainOffset: bigint, plaintext: Buffer): Promise<{ complete: boolean; file?: File }>`
  - `resumeOffset(sessionId: string): Promise<bigint>` (plaintext; lower of both copies, rounded down to a whole `UPLOAD_CHUNK_PLAINTEXT`)
  - `failUpload(sessionId: string, reason: string): Promise<void>`
  - Routes unchanged: `POST /uploads`, `POST /uploads/resumable/init` (accepts no `targetAccountId`), `PUT /uploads/resumable/chunk/:id`, `GET /uploads/resumable/status/:id`, and `POST /api/v1/uploads`

- [ ] **Step 1: Write failing integration tests with the memory provider**

Upload a file of `2 * UPLOAD_CHUNK_PLAINTEXT + 17` bytes through resumable routes; assert: two replicas on different accounts; byte-identical blobs; decrypts to the original; blob names match `/^[0-9a-f]{32}\.bin$/`; recorded MIME sent to provider is `application/octet-stream`; plaintext sample absent from both blobs. Retry test: chunk 2 succeeds on account A, fails on B; client resumes from status offset; final blobs still identical and decrypt. Chunk not aligned to `UPLOAD_CHUNK_PLAINTEXT`, except final, gets 400 `CHUNK_NOT_ALIGNED`. One copy failing permanently: file not created, both uploads aborted, status `failed`. Zero-byte file gives `UPLOAD_SIZE_REQUIRED`. Over user limit gives `USER_STORAGE_LIMIT_REACHED`. `ProviderQuotaError` sets `pausedUntil` to now + 24 h. Multipart `POST /uploads` of 20 MB stores correctly. `grep -r "permissions.create" backend/src` has no matches.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

Per chunk: encrypt frames with `isFinal` only on the last frame of the file; for each copy, if its committed offset exceeds the chunk's encrypted start, trim that many leading bytes (safe because encryption is deterministic), and skip entirely when fully committed. Send to both copies concurrently. On both complete, create `File` and two `FileReplica` rows in one transaction, with `session.fileId` as ID. Resumable PUT reads the request body into a Buffer bounded by `UPLOAD_CHUNK_PLAINTEXT`; multipart assembles the same size chunks with backpressure by pausing the Busboy stream until each `writeEncryptedChunk` resolves, and processes one file at a time. Encrypt `sessionUri` with `encryptText`.

- [ ] **Step 4: Run, verify pass; `npm run build`. Step 5: Commit** `feat(uploads): encrypt and write two copies`

### Task 8: Decrypted read path with failover

**Files:**
- Create: `backend/src/modules/files/decrypt-stream.ts`
- Modify (rewrite): `backend/src/modules/files/stream-file.ts`; modify `backend/src/modules/files/file.routes.ts` (`/preview/:token`, `/download`, batch-download), `backend/src/modules/public/public.routes.ts`
- Delete: `backend/src/modules/files/stream-google-file.ts`
- Test: `backend/test/integration/read.test.ts`

**Interfaces:**
- Produces:
  - `openDecryptedStream(file: FileWithReplicas, range: ByteRange | null): Promise<Readable>`
  - `streamProviderFile(file: FileWithReplicas, range: string | undefined, res: Response, options: { disposition?: 'inline' | 'attachment' }): Promise<void>`
  - `type FileWithReplicas = File & { replicas: (FileReplica & { connectedAccount: ConnectedAccount })[] }`

- [ ] **Step 1: Write failing integration tests**

Seek at each boundary from Review Focus returns exact bytes with correct `Content-Range`, `Content-Length`, and 206; past EOF gives 416; first copy deleted from provider still serves from second; tampered first copy falls back to second; both tampered aborts the connection and sends no tampered plaintext; public link serves and decrypts; public link of a disabled owner returns 404; expired link returns 404; batch zip entries decrypt. Mime and filename headers use the real values.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

Pick healthy replicas first. Failover is decided per frame fetch, retrying the same frame on the other copy. Fetch one frame batch at a time up to 8 frames, respecting `res` backpressure. Never write a frame before it authenticates. Mark a replica `lost` only on `ProviderUnavailableError` with 404 semantics, not a transient failure. Unwrap with `openFileKey(file.userId, file.wrappedFileKey)`, so invite and public access use the owner's key.

- [ ] **Step 4: Run, verify pass. Step 5: Commit** `feat(files): decrypt streams with range and failover`

### Task 9: File lifecycle, account removal, and legacy column drop

**Files:**
- Modify: `backend/src/modules/files/file.routes.ts`, `backend/src/modules/folders/folder.routes.ts`, `backend/src/modules/invites/invite.routes.ts`, `backend/src/modules/connected-accounts/connected-account.routes.ts`, `backend/src/modules/admin/admin-users.routes.ts`, `backend/src/modules/audit-logs/audit-log.routes.ts`, `backend/prisma/schema.prisma`
- Create: `backend/src/modules/files/delete-blobs.ts`, Prisma migration
- Test: `backend/test/integration/lifecycle.test.ts`

**Interfaces:**
- Produces: `deleteFileCopies(file: FileWithReplicas): Promise<void>` (removes blobs; failures become `OrphanBlob` rows, never fail the user's delete); `canRemoveAccount(soleCopyCount: number): boolean`.

- [ ] **Step 1: Write failing tests**

Permanent delete removes both blobs; unreachable account creates an `OrphanBlob` and the file is still gone from the UI; rename calls no provider; `/files/sync-google`, `/:id/view-url`, `/:id/public-permission` are 404; member A cannot read, rename, delete, or share member B's file; invite only targets existing users; audit log for a member shows only their entries; admin audit view has no file names; removing an account leaves `File` rows, marks affected copies gone, and is refused with `ACCOUNT_HOLDS_SOLE_COPY` when a file's only copy is there; deleting a user removes their files and copies; folder delete removes both copies of contained files.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

Replace all `file.provider`, `connectedAccount`, `providerFileId` usage with replicas. Stop creating Drive folders; ignore `providerFolderId` and `Folder.connectedAccountId`. Migration drops `File.connectedAccountId`, `File.provider`, `File.providerFileId`, makes `wrappedFileKey` and `encryptedSizeBytes` non-null, and removes `UploadRoutingPolicy`, `AuthHandoff`. Run `npx prisma migrate dev --name family_drive_finalize`.

- [ ] **Step 4: Run, verify pass; `npm run build`. Step 5: Commit** `feat(files): replica lifecycle and drop legacy columns`

### Task 10: Health and Repair

**Files:**
- Create: `backend/src/modules/admin/repair.ts`
- Modify: `backend/src/modules/admin/admin-storage.routes.ts`, `backend/src/server.ts`
- Test: `backend/test/integration/repair.test.ts`

**Interfaces:**
- Produces: `startRepair(): Promise<RepairJob>` (refuses with `REPAIR_RUNNING`), `resumeRepairOnBoot(): Promise<void>`. Routes: `POST /admin/storage/repair`, `GET /admin/storage/repair`, `GET /admin/storage/health` (per-account status and counts only).

- [ ] **Step 1: Write failing tests**

File with one `lost` copy gets a new healthy copy on a third account, byte-identical to the survivor; no account available leaves it counted in `failed`; a `running` job left in DB resumes on boot; `OrphanBlob` rows are cleared when their account is reachable; health response contains no file name.

- [ ] **Step 2: Run, verify failure. Step 3: Implement**

Copy encrypted bytes frame batch by frame batch using `readRange` and the provider upload methods, reserving through the same locked selection, excluding accounts already holding the file. Sequential, one file at a time.

- [ ] **Step 4: Run, verify pass. Step 5: Commit** `feat(admin): add storage health and repair`

### Task 11: Frontend

**Files:**
- Create: `frontend/src/pages/AdminUsersPage.tsx`, `frontend/src/pages/AdminStoragePage.tsx`, `frontend/src/pages/ChangePasswordPage.tsx`, `frontend/src/components/auth/AdminRoute.tsx`
- Delete: `frontend/src/pages/RegisterPage.tsx`, `frontend/src/pages/GoogleAuthPage.tsx`, `frontend/src/components/auth/GoogleLogo.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/pages/LoginPage.tsx`, `frontend/src/lib/auth.ts`, `frontend/src/lib/preview.ts`, `frontend/src/context/UploadContext.tsx:31`, `frontend/src/layouts/DriveLayout.tsx`, `frontend/src/pages/SettingsPage.tsx`, `frontend/src/pages/AllFilesPage.tsx`, `frontend/src/pages/TrashPage.tsx`, `frontend/src/pages/QuotaTrackerPage.tsx`, `frontend/vite.config.ts`

**Interfaces:**
- Consumes: Task 4, 5, 10 routes. Session `user` gains `role`, `mustChangePassword`.

- [ ] **Step 1: Implement closed auth UI**

Login has no Register link or Google button. `mustChangePassword` redirects to `/change-password`.

- [ ] **Step 2: Implement admin pages**

Users: create, limit, reset, disable, delete with confirmation showing file count and size. Storage: connect Google, connect S3, default cap, per-account cap, Full badge, routing, health, Repair progress. Move Quota Tracker and Google credentials into it. Hide admin navigation from members.

- [ ] **Step 3: Update file UI**

`CHUNK_SIZE = 8388384`. Remove Sync Drive, view-url, Office preview, account badges on files, and per-file account fields. Sidebar shows a single storage-left value. Add `/admin` to `navigateFallbackDenylist` in `vite.config.ts`.

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run build`. Expected: success. `grep -rn "officeapps\|view-url\|sync-google\|/register" frontend/src` has no matches.

- [ ] **Step 5: Commit** `feat(frontend): admin area and closed login`

### Task 12: Operations, docs and full check

**Files:**
- Modify: `setup.sh`, `setup.ps1`, `.env.docker.example`, `docker-compose.yml`, `README.md`, `AGENTS.md`, `CLAUDE.md`
- Create: `scripts/mysql-backup.sh`

- [ ] **Step 1: Key generation**

Setup scripts generate `FILE_MASTER_KEY` (32 random bytes, base64), display once, and require typing `I SAVED IT` to continue. They never overwrite an existing key. `docker-compose.yml` passes it with no default, so a missing key stops the container; `.env.docker.example` documents it. Setup creates the first admin through `admin:create`.

- [ ] **Step 2: Backups**

Add a compose `backup` service running `mysqldump` nightly to a named volume, keeping 14 days, using `scripts/mysql-backup.sh`.

- [ ] **Step 3: Docs**

README: closed-site model, Google Cloud **In production** requirement, 100-account unverified cap, never replace the Google Cloud project, master key and DB loss warnings, copy backups off-server, CLI restore steps. Update `AGENTS.md` and `CLAUDE.md` to match. Keep `LICENSE` and copyright.

- [ ] **Step 4: Full verification**

Run: `cd backend && npm run build && npm test && npm run test:integration`, then `cd ../frontend && npm run build`, then `docker compose up -d --build`. Expected: all pass, `GET /health` returns `ok`. Then manual with two real Gmail accounts: connect both, upload an mp4, confirm Drive shows only `.bin` with no preview and no sharing, play and seek in app, revoke one account and confirm playback continues, Repair after adding a third.

- [ ] **Step 5: Commit** `docs: family drive setup, backup and operations`
