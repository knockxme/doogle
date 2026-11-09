# Private Family Drive: Design

Fork of 9Drive (Apache 2.0; keep `LICENSE` and the copyright notice).

## Intent

The owner has about 4 TB of Google storage and wants 10 to 20 or more Gmail accounts pooled into one private drive for family. Family members log in and use it like a normal drive. Anyone who opens one of those Google accounts directly must see only meaningless encrypted blobs: an uploaded `.mp4` must not be playable, named, or recognisable from Google Drive.

The site is closed. There is no public sign-up. Only the admin creates users and only the admin adds storage.

## Goals

1. **Closed access.** Login only. Admin creates users, resets passwords, sets limits.
2. **Encrypted at rest on every provider.** File contents, names and types are hidden from Google and S3.
3. **Privacy between people.** Each person sees only their own files and what is explicitly shared with them. The app gives the admin no way to browse, list or open another person's files or see their file names.
4. **Unlimited admin-added Google accounts** forming one shared pool.
5. **Two copies of every file** on two different accounts, with automatic read failover and admin-triggered repair.
6. **Two kinds of limit.** A per-user storage limit, and a per-Google-account upload cap with an admin-set default.

## Non-goals

- End-to-end or zero-knowledge encryption. See "Trust model".
- Splitting one file across accounts. Each copy is whole on one account.
- Office document preview. Download still works.
- Sync Drive. Google Drive is dumb blob storage.
- Rebranding, which was not requested.
- Migrating existing plaintext files. This is a fresh install.

## Anti-goals

These count as failure even if everything else works:

- Any plaintext byte, real filename or real MIME type reaches Google or S3.
- Any Drive file gets an `anyone` permission or a Google share link.
- An upload is reported complete with only one copy stored.
- A family member can reach another person's files, or any admin function.
- An admin screen or endpoint exposes another person's file names or content.

## Trust model (decided by the owner)

The admin can reset a password and the user keeps their files, so the server must be able to decrypt without the user's password. The owner accepted this consequence: someone with server access, the database and the master key could technically decrypt files. The protection is:

| Party | What they get |
| --- | --- |
| Google, or anyone inside a Google account | Encrypted blobs, random names. Existence, approximate size and upload time remain visible. |
| Family member | Only their own files and what is shared with them, enforced by the app, with per-user keys. |
| Admin, through the app | User management and storage health. No file names, no file access. |
| Person with server, DB and master key | Can decrypt. Accepted. |

## Current code that must change

Findings from reading the code, all of which violate the goals:

- `modules/uploads/upload.routes.ts` (lines 229 and 506), and `modules/files/file.routes.ts` (`public-permission` route and `view-url` route) grant `anyone`/`writer` on Drive files. Remove all of them and the routes.
- `uploads/upload.routes.ts` buffers the whole file in memory (`Buffer.concat`). Replace with streaming.
- `/auth/register` and the `/auth/google/*` routes create accounts publicly. Remove, along with the Register page and Google sign-in UI.
- `modules/system/*` (update, backup, restore, google-config) only needs `requireAuth`, so any user can reach it.
- `/system/backup` and `/system/restore` expect a database file on disk, but the database is MySQL. They do not work.
- `/system/update` runs `update.sh` or `git pull`, which would overwrite this fork from upstream. Remove.
- `ConnectedAccount` is per-user and `selectAccount` filters by `userId`. The pool must be install-wide.
- `DELETE /connected-accounts/:id` cascades to `File` rows, which would destroy file records.
- `requireAuth` does not check `User.status`, so a disabled user would keep working.
- `frontend/src/lib/preview.ts` sends file URLs to Microsoft's Office viewer. Remove.
- `buildS3ObjectKey` includes the filename. Must not.
- Renames currently propagate to Drive (`file.routes.ts` line 275), and virtual folders can create real Drive folders (`providerFolderId`). Both leak names. Stop both; everything is stored flat.
- OAuth scope is full `drive` (`system.routes.ts` line 150).

## Users and admin

- `User` gains `role` (`admin` or `member`), `mustChangePassword`, `storageLimitBytes` (null means unlimited).
- First admin is created by a CLI script (`npm run admin:create`), and by the setup scripts. There is no web bootstrap route.
- Admin area, gated by a new `requireAdmin` middleware and hidden from members in the UI:
  - Users: create with temporary password and storage limit, edit limit, reset password, disable, delete.
  - Storage: connect Google accounts, connect S3, caps, routing, account health, Repair.
  - Google credentials and system settings.
- A new user must change the temporary password at first login. A password reset sets the flag again and revokes all that user's sessions.
- `requireAuth` must reject non-active users.
- Deleting a user permanently deletes their files and copies, after an explicit confirmation showing the count and size. Disable is the non-destructive option.
- Add login rate limiting, since the login page is on the public internet.
- Remove reCAPTCHA.
- API keys stay per-user and obey the user's storage limit.
- Audit log: members see only their own. The admin view must not show other users' file names; it shows action types and user only.

## Storage pool

- `ConnectedAccount` remains the model, but is treated as install-wide. `userId` records who connected it. All routing, quota and file access stop filtering it by the requesting user.
- Only admins can list, connect or remove accounts. Members see one "storage left" number.
- `UploadRoutingPolicy` becomes a single global policy.
- `Folder.connectedAccountId` pinning is removed.
- OAuth scope narrows to `drive.file`, so the app can touch only files it created. Scope is set in `system.routes.ts` and removed from any full-Drive assumption. `ensureGoogleAppFolder` keeps working because the app creates that folder.

### Account upload cap

- New global setting: default account cap in bytes (null means no cap), edited by the admin.
- `ConnectedAccount.capBytes` is copied from the default when an account connects, and can be overridden per account by the admin.
- Changing the default affects only accounts connected afterward.
- Cap is measured against encrypted bytes this app has stored on that account (sum of its live copies, including files in trash).
- Effective free space = the smaller of (cap minus app-stored bytes) and Google's reported free space.
- An account at its cap shows as **Full** in the admin UI and routing skips it. Lowering a cap below current usage moves nothing; the account just becomes Full.

### Per-user limit

- Counts each file once at its real size, not doubled, and includes trash.
- Enforced at upload start, counting that user's in-progress uploads.
- Members see `min(limit remaining, pool usable space)`. Pool usable is effective free space across accounts divided by two, approximately.

## Two copies

- New `FileReplica` model: `fileId`, `connectedAccountId`, `providerFileId`, `status`, `sizeBytes` (encrypted size). `File` drops `connectedAccountId`, `provider` and `providerFileId`.
- Removing a storage account deletes its replica rows and must not touch `File` rows. Refuse removal if any file's only remaining copy is on that account.
- Routing picks two different accounts that both fit the encrypted size, using the global policy. Fewer than two eligible accounts means a clear refusal.
- Reservations must count in-progress uploads across all users, so concurrent uploads cannot overfill an account.
- An upload is complete only when both copies are confirmed. If either fails, the upload fails and partial data is cleaned up.
- Google's roughly 750 GB/day per-account upload limit: on the corresponding Drive error, mark the account paused for 24 hours and skip it in routing.
- Reads use the first healthy copy and fall back to the other on failure.
- Admin health view shows per-account status and how many files have lost a copy, with no file names. An account becomes unhealthy when its token refresh fails or reads consistently fail.
- **Repair** (admin button): for each file with fewer than two healthy copies, copy the encrypted bytes from the surviving copy to another eligible account, with no decryption. Runs as a background job in the backend process, records progress in the DB, and resumes after restart.
- Permanent delete removes both copies. A copy on an unreachable account stays recorded for later cleanup.

## Encryption

- New env var `FILE_MASTER_KEY`, 32 random bytes, separate from `TOKEN_ENCRYPTION_KEY`. The app refuses to start without it.
- A key fingerprint is stored in the DB at first boot. A mismatch at startup is a fatal error, so a wrong key can never write unreadable data.
- Key hierarchy: per-user key derived by HKDF from the master key and user ID; a random per-file key, wrapped with the owner's key and stored on the `File` row.
- Shared and public access decrypt with the owner's derived key, server-side.

### Blob format

No header. Format version is stored in the DB.

- The stream is fixed 1 MiB frames: 12-byte nonce, ciphertext, 16-byte GCM tag. Plaintext per frame `P` = 1,048,548 bytes. The last frame may be shorter.
- AES-256-GCM. Additional authenticated data binds file ID, frame index and a final-frame flag, preventing reorder, swap or truncation.
- Nonce = truncated HMAC-SHA256 (key derived from the per-file key) of frame index and frame plaintext. Re-encrypting the same frame gives identical bytes, which makes partial resume safe, and different plaintext never reuses a nonce.
- Encrypted size = plaintext size + 28 × frame count.
- Why 1 MiB frames: whole frames are multiples of 256 KiB, which Google's resumable upload requires for non-final chunks.

### Upload path

- Browser uploads remain resumable and chunked, with chunk size set to a whole multiple of `P`.
- Server encrypts each chunk and forwards it to both Google resumable sessions, in memory only, never on disk.
- Resume offset reported to the client is the lower of the two sessions, rounded down to a frame boundary. Bytes a copy already holds are trimmed before sending.
- Upload session state holds two Google session URIs, encrypted at rest because they are bearer credentials.
- The multipart routes (`POST /uploads`, `POST /api/v1/uploads`) use the same pipeline, streaming with backpressure rather than buffering.
- Provider-side name: random hex plus `.bin`. Provider-side MIME: `application/octet-stream`.

### Read path

- Map the requested plaintext byte range to frames, fetch only those frames from the provider with a Range request, decrypt, trim, and respond with correct `Content-Length`, `Content-Range` and `206` using plaintext sizes. Video seeking must work.
- `streamProviderFile` becomes the single entry point used by preview, download, public link, preview token and batch zip.
- Authentication failure on a frame: try the other copy, otherwise abort the connection and log. Never serve unauthenticated bytes.

## Sharing

Public links and invites stay, decrypting through the server. Google links are never used. Public links support expiry. Invites target existing users only.

Preview stays for images, video, audio and PDF.

## Key and data safety

- Setup scripts generate `FILE_MASTER_KEY`, display it once, and require the operator to confirm saving it offline. Losing it makes all files permanently unreadable.
- The database is the only map from blobs to files and holds the wrapped keys. Losing it also loses everything.
- Replace the broken backup with nightly `mysqldump` to a Docker volume via compose, with restore documented as a CLI procedure. Remove in-app restore. README must tell the owner to copy backups off the server.
- Names of files and folders stay plaintext in MySQL so search works. Builder's call to keep it this way; the database is on the owner's server and is covered by the accepted trust model.

## Google Cloud operational notes (for README)

- OAuth app must be **In production**, otherwise tokens expire every 7 days. An unverified app shows a warning screen at connect and has a 100-account cap.
- **Never replace the Google Cloud project.** With `drive.file`, access is tied to that project, so a new project cannot read existing blobs.
- Many Gmail accounts linked to one server may be flagged by Google. Two copies reduce this risk but do not remove it.

## Deployment

Docker on the owner's server, as today. All streaming passes through the server, so its bandwidth caps playback.

## Constraints

- Follow `AGENTS.md`: Zod validation, `.js` import suffixes, schema changes through Prisma migrations, BigInt to string in JSON, stable error codes.
- The repo has no test runner. Encryption, range mapping and routing need tests; add a minimal one (Node's built-in `node:test` through `tsx`, no new runtime dependencies).
- No uploaded data on disk.

## Decisions left to the builder

Internal module layout, order of work, exact UI of admin screens, Repair concurrency, frame-buffering details, and the exact chunk size multiple. S3 stays as an optional admin-only provider, encrypted identically; an S3 bucket counts as one account for the two-copies rule.

## Calls made without explicit confirmation

- Sync Drive, Google sign-in, Office preview and one-click update removed.
- `drive.file` scope.
- Default-cap changes affect only future accounts; per-account override exists.
- Caps count encrypted bytes; user limits count real size once.
- Whole-file placement, 5 GB max upload retained (configurable).
- Deleting a user deletes their files.
- File names stay plaintext in the local database.
- Backups via nightly `mysqldump`; in-app restore removed.
