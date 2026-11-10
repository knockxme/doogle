# Family Drive

A private, closed file drive for a family. The owner creates every account. Files are encrypted by the server and stored as two copies on two different Google accounts (or S3 buckets). Google only ever sees encrypted blobs with random names.

Based on [9Drive](https://9drive.zenhosta.com) by Zenhosta, licensed under Apache 2.0 (see `LICENSE`).

## Trust model

- There is no public sign-up. Only an admin creates users.
- Google, or anyone inside a connected Google account, sees encrypted blobs with random names. They can see that files exist, roughly how big they are and when they were uploaded. Nothing is shared or previewable from Drive.
- A family member sees only their own files and what was shared with them.
- An admin manages users and storage health through the app. The admin screens show no file names and give no file access.
- Someone who controls the server, the database and `FILE_MASTER_KEY` can decrypt everything. This is accepted, because it is what lets an admin reset a password without losing the user's files.
- File and folder names are stored in plain text in MySQL so search works.

## Docker quick start

You need Docker and `openssl`.

```bash
cp .env.docker.example .env
```

Edit `.env`. Change the database passwords, `JWT_ACCESS_SECRET` and `TOKEN_ENCRYPTION_KEY` (any long random strings, 32+ characters), and fill in the Google client ID and secret (see below). Then generate the master key:

```bash
openssl rand -base64 32
```

Put the output in `.env` as `FILE_MASTER_KEY=...`, and **copy it somewhere safe and offline right now** (see "The master key"). Docker refuses to start without it.

```bash
docker compose up -d --build
docker compose exec backend npm run admin:create -- --email you@example.com --name "Your Name"
```

The last command asks for the password. Then open http://localhost:5173 and sign in. Add family members from **Admin > Users**; they must change their password at first sign-in.

The backend is bound to `127.0.0.1:4000` and trusts one proxy hop. For internet access put a TLS reverse proxy in front of both ports, set `FRONTEND_URL`, `VITE_API_URL` and `GOOGLE_REDIRECT_URI` to your public addresses, then rebuild (`docker compose up -d --build`). All file bytes pass through the server, so its bandwidth limits playback and uploads.

The backend refuses to start if `FILE_MASTER_KEY` is wrong for the existing data.

**Warning:** `docker compose down -v` deletes the `mysql_data` volume (the database) and the `backups` volume (every local backup) in one command. Use plain `docker compose down` to stop. Never use `-v` unless you have copies of both off the server.

Without Docker, `./setup.sh` (or `setup.ps1` on Windows) creates `backend/.env` and `frontend/.env`, generates and shows the master key once, and offers to create the first admin. You need Node.js 20+ and MySQL 8+.

## Google Cloud setup

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. The app only requests the `drive.file` scope (plus email and profile to identify the account).
3. Set the publishing status to **In production**. In "Testing" mode, tokens expire every 7 days and every account silently stops working.
4. Create an OAuth client (Web application). Add the redirect URI `http://localhost:4000/connected-accounts/google/callback`, or your public address.
5. Put the client ID and secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`) and run `docker compose up -d --build`.

Things to know:

- An unverified app shows a warning screen when you connect an account (click Advanced, then continue), and is limited to 100 connected accounts. That is plenty for a family.
- **Never replace or delete the Google Cloud project.** With `drive.file`, access to the files is tied to that project. A new project cannot read the existing blobs.
- Linking many Gmail accounts to one server may get them flagged by Google. Two copies of every file reduce the risk of loss but do not remove it.

## Adding storage

Sign in as admin and open **Admin > Storage**.

- **Add a Gmail account:** click connect, sign in with that Gmail account, accept the warning screen. You need at least two accounts (or buckets) for two copies; an S3 bucket counts as one account.
- **Caps:** set a default cap for new accounts, and override it per account. Changing the default affects only accounts added later. Caps count encrypted bytes.
- **Two copies, health and Repair:** every file lives on two different accounts. The storage page shows each account's health. If an account is revoked or lost, or you add a new one, press **Repair** to rebuild missing copies. Playback continues from the surviving copy meanwhile.

## Backups

The compose `backup` service runs `mysqldump` once a day into the named Docker volume `backups`, gzipped, and deletes dumps older than 14 days. The first dump is taken when the service starts.

The database is the only map from encrypted blobs to files, and it holds the wrapped file keys. **Losing the database loses everything**, just like losing the master key.

- Backups never contain `FILE_MASTER_KEY`. The key is only in `.env`.
- Copy **both** off the server regularly, and store them in **different places**: dumps from the volume, and the key kept offline.
- `docker compose down -v` also deletes the `backups` volume, together with the database. Do not use `-v`.
- To copy the latest dump out:

```bash
docker compose cp backup:/backups/. ./backups-copy/
```

### Restore

**Restoring replaces the current database** (the dump drops and recreates every table). Take a fresh dump of the current state first, and copy it off the server. The `FILE_MASTER_KEY` in use must be the one that matches the backup being restored; with a different key the backend refuses to start, or files cannot be read.

```bash
docker compose stop backend
docker compose exec -T backup sh -c 'ls /backups'          # pick a file
docker compose exec -T backup sh -c 'gunzip -c /backups/backup-YYYYMMDDTHHMMSSZ.sql.gz' \
  | docker compose exec -T mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" 9drive'
docker compose start backend
```

(If you changed `MYSQL_DATABASE`, use that name instead of `9drive`.) On a new server, put the same `FILE_MASTER_KEY` in `.env` first, start only `mysql`, restore, then start the rest.

## The master key

`FILE_MASTER_KEY` derives the keys that encrypt every file. If you lose it, **every file is permanently unreadable**, with no recovery. Never change it on an existing install. Setup shows it once; write it down or store it in a password manager, separate from the backups.

## Known limits

- Invites list names but grant no file access to the recipient.
- Office files (Word, Excel and so on) have no preview. Images, video, audio and PDF do.
- One backend process only. Do not run several copies.
- Real Google and S3 behaviour has not been tested against live accounts. Tests use fakes.

### Owner's first check (not yet done)

Before trusting the system with real files, with two real Gmail accounts: connect both; upload an mp4; confirm Drive shows only a `.bin` file with no preview and no sharing; play and seek in the app; revoke one account and confirm playback continues; add a third account and press Repair.

## Development

```bash
cd backend && npm run build && npm test      # unit tests
cd backend && npm run test:integration       # needs MySQL on 127.0.0.1:13306 (root/root)
cd frontend && npm run build
```

See `AGENTS.md` for the code layout and conventions.
