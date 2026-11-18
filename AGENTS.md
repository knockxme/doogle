# AGENTS.md

## Project Overview

Family Drive is a closed, admin-managed file drive (built from 9Drive, Apache 2.0). Admins create users; there is no public sign-up. The backend encrypts every file in 1 MiB frames with a per-file key wrapped by `FILE_MASTER_KEY`, and stores two copies (replicas) on two different connected accounts (Google Drive with `drive.file`, or S3). Providers only ever see encrypted blobs named `<32 hex>.bin` with MIME `application/octet-stream`.

## Repository Structure

- `backend/`: Express 5 API, TypeScript (ESM, `.js` suffix on relative imports), Prisma, MySQL.
- `frontend/`: Vite React app, Tailwind. Preserve the current visual style and `components/ui` primitives.
- `docker-compose.yml`: `mysql`, `backend`, `backup` (nightly `mysqldump` to the `backups` volume via `scripts/mysql-backup.sh`), `frontend` (nginx).
- `setup.sh` / `setup.ps1`: create env files, generate and confirm `FILE_MASTER_KEY`, never overwrite an existing one.
- `docs/superpowers/`: spec and plan for the family-drive work. Do not delete `docs/`.

## Backend architecture

- `modules/crypto/`: `keys.ts` (master key parsing, key derivation), `file-keys.ts` (per-file key create/open), `frames.ts` (frame size 1,048,576 bytes, 28 bytes overhead, 12-byte nonce + 16-byte tag), `range.ts` (plaintext range to frame/byte mapping).
- `modules/storage/`: the install-wide pool. `provider.ts` is the provider interface; `google-provider.ts`, `s3-provider.ts`, `memory-provider.ts` (tests) implement it. `pool.ts` reserves space and records account health; `pool-select.ts` picks two different accounts for a file.
- `modules/uploads/`: `encrypted-upload.ts` and `upload.routes.ts`. Browser chunks are 8 frames of plaintext (8,388,384 bytes = 8 MiB encrypted). Resumable sessions live in `UploadSession` and `UploadSessionReplica`. No uploaded data touches disk. `POST /api/v1/uploads` (API key) shares the same handler.
- `modules/files/`: `stream-file.ts` and `decrypt-stream.ts` decrypt on the fly with range support. A frame that fails authentication is retried from the other replica; otherwise the connection is aborted. Never serve unauthenticated bytes. `delete-blobs.ts` removes provider blobs (failures go to `OrphanBlob`).
- `modules/admin/`: `admin-users.routes.ts`, `admin-storage.routes.ts` (accounts, default and per-account caps, settings, health, Repair), `repair.ts` (rebuilds missing replicas, tracked by `RepairJob`), `admin-rules.ts`. Admin screens never expose file names or content.
- `modules/connected-accounts/`: admin-only; Google OAuth and S3 account connection. `modules/google/` and `modules/s3/` hold quota sync and provider specifics.
- `modules/webdav/`: WebDAV at `/api/dav` for rclone. `index.ts`/`methods.ts`/`auth.ts` are the protocol layer on plain Node req/res and only call `ports.ts`; `family-ports.ts` implements the ports with the existing services. Mounted in `app.ts` before `cors()` and `express.json()`. Errors are plain text with WebDAV status codes, not `{ code, message }`. Basic auth = email + API key with scope `dav`, only for users with `User.davEnabled` (set by an admin). Call `forgetDavLogins()` (`logins.ts`) whenever keys, user status or `davEnabled` change. Deletes are permanent; uploads land under a `.dav-upload-` name and are swapped in by `replace` in one transaction. Empty files are File rows with no replicas.
- `modules/files/purge.ts`: permanent deletes in a transaction queue the blobs as `OrphanBlob` rows, then `drainOrphanBlobs` deletes them. `modules/folders/folder-service.ts`: folder create, move checks and tree delete, shared by routes and WebDAV.
- `modules/uploads/stale-uploads.ts`: hourly cleanup started in `server.ts` (idle uploads after 24 h, WebDAV temp leftovers, orphan blobs, and the copy check: `verifyCopies` in `repair.ts` reads the last byte of copies not checked for 7 days, 500 per hour, and marks missing ones lost; Repair runs it over every copy first). Docker images use Node 22.
- `modules/public/`, `modules/invites/`: public links (decrypted by the server, with expiry) and invites (existing users only).
- `config/env.ts`: env validation. The backend refuses to start with an invalid or wrong `FILE_MASTER_KEY`.
- Removed on purpose: public registration, Google sign-in, Drive sync, Drive permission changes (`drive.permissions.create` must not appear in `backend/src`), `/system/update`, `/system/backup`, `/system/restore`, in-app restore and Office preview.

Scripts:
- `npm run dev`, `npm run build` (tsc), `npm run start`, `npm run start:deploy`.
- `npm test`: unit tests (`node:test` via tsx, `backend/test/*.test.ts`).
- `npm run test:integration`: needs MySQL at `127.0.0.1:13306` (root/root, database `family_drive_test`), runs migrations then `backend/test/integration/*.test.ts`.
- `npm run admin:create -- --email <e> --name <n>`: create or reset an admin (prompts for the password).
- `npm run prisma:migrate` (dev), `npm run db:migrate:deploy`, `npm run prisma:generate`.
- `npm run seed:google-config` / `seed:google-config:docker`: store the Google OAuth client in the database from `GOOGLE_*` env.
- `scripts/dav-smoke-test.sh <url> <email> <key>`, `scripts/rclone-test.sh`: manual WebDAV checks against a running stack (the smoke test also runs inside `test:integration`).

Environment: `TRUST_PROXY_HOPS`, `DAV_ENABLED`, `DAV_CACHE_MB`, `DAV_READ_AHEAD`, `DATABASE_URL`, `APP_PORT`, `FRONTEND_URL`, `JWT_ACCESS_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FILE_MASTER_KEY` (32 random bytes, base64, required), `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `MAX_UPLOAD_BYTES`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

Conventions:
- Routes under `backend/src/modules/<feature>/<feature>.routes.ts`, mounted in `app.ts`. Express trusts `TRUST_PROXY_HOPS` proxy hops (default 1); use `req.ip`, never read `X-Forwarded-For` yourself.
- Validate all input with Zod. Errors are `{ code, message }`. BigInt is sent as a string. Unexpected errors go to `next(error)`.
- Schema changes only through Prisma migrations. Do not edit generated Prisma client files.
- No new runtime dependencies. Tests live in `backend/test/`.

Security rules:
- Never commit `.env` files or secrets. Never log tokens, keys, session URIs or raw share tokens.
- Provider tokens are encrypted at rest, app refresh tokens hashed. Keep CORS restricted to `FRONTEND_URL`.
- Never send plaintext, real file names or real MIME types to a provider.
- Losing `FILE_MASTER_KEY` or the MySQL database loses every file. Never change the key on an existing install.

## Frontend

- Entry `src/main.tsx`, routes in `src/App.tsx`, shell `layouts/DriveLayout.tsx`.
- Pages: `LoginPage`, `ChangePasswordPage`, `AllFilesPage` (files, folders, 8 MiB chunked resumable upload, preview), `SharedPage`, `AdminUsersPage`, `AdminStoragePage` (guarded by `AdminRoute`), settings, trash, archived, activity, API keys, `PublicFilePage`.
- `lib/api.ts` (`apiFetch`, token refresh) and `lib/auth.ts` keep token handling centralized. `VITE_API_URL` is embedded at build time.
- Use `@/*` imports, `cn` for classes, existing `Button`, `Card`, `Input`.
- `npm run dev`, `npm run build`.

## Docker

- `docker compose up -d --build`; needs `FILE_MASTER_KEY` in the root `.env` (compose fails without it).
- `docker compose exec backend npm run admin:create -- --email <e> --name <n>`.
- `docker compose down` keeps data; `down -v` deletes the DB and backup volumes.
- Backend is bound to `127.0.0.1:4000`; frontend is on host port `5173`.

## Verification

- `cd backend && npm run build && npm test && npm run test:integration`
- `cd frontend && npm run build`

## Agent Rules

- Prefer small, targeted changes; do not add dependencies; do not commit secrets.
- Do not edit `node_modules`, build output or generated Prisma client.
- Do not write uploaded data to disk.
