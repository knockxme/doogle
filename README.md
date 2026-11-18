# Doogle

A private file drive for one family. You (the admin) create every account; nobody can sign up on their own. Every file is encrypted on your server and saved **twice**, on two different storage accounts (Gmail/Google Drive accounts or S3 buckets). You can turn the second copy off to use all the free space instead. Google and S3 only ever see scrambled files with random names.

Based on [9Drive](https://9drive.zenhosta.com) by Zenhosta, licensed under Apache 2.0 (see `LICENSE`).

---

## Contents

1. [How it works](#how-it-works)
2. [Words used in this guide](#words-used-in-this-guide)
3. [Who can see what](#who-can-see-what)
4. [Install with Docker](#install-with-docker)
5. [Google Cloud setup](#google-cloud-setup)
6. [Put it on the internet](#put-it-on-the-internet)
7. [Day-to-day admin](#day-to-day-admin)
8. [Media library over WebDAV (rclone, Jellyfin)](#media-library-over-webdav-rclone-jellyfin)
9. [Backups and restore](#backups-and-restore)
10. [Updating](#updating)
11. [The master key](#the-master-key)
12. [Settings reference](#settings-reference)
13. [Troubleshooting](#troubleshooting)
14. [What has been tested](#what-has-been-tested)
15. [Known limits and open issues](#known-limits-and-open-issues)
16. [Owner's first check](#owners-first-check)
17. [Install without Docker](#install-without-docker)
18. [Development](#development)

---

## How it works

```
 Browser ──upload──▶ Your server ──encrypt──▶ copy 1 ──▶ storage account A (e.g. Gmail #1)
                                         └──▶ copy 2 ──▶ storage account B (e.g. Gmail #2)

 Browser ◀─play/download── Your server ◀─decrypt── copy 1 (or copy 2 if copy 1 fails)
```

- **Upload:** the browser sends the file in 8 MB pieces. The server encrypts each piece and writes it to two different storage accounts at the same time (one, if the second copy is turned off). Nothing is saved on the server's disk. The upload counts as done only when every copy is complete.
- **Download and playback:** the server reads the encrypted copy, decrypts it on the fly and sends it to the browser. Video seeking works. If one copy cannot be read, the server switches to the other one.
- **The database** (MySQL) is the map. It knows which random blob belongs to which file, and it holds each file's (wrapped) key. Without the database, the blobs in Google are useless.
- **The master key** (`FILE_MASTER_KEY`) unlocks every file key. Without it, nothing can be decrypted.

So the three things that matter are: **the master key, the database, and at least one copy of each file.** Lose the key or the database and every file is gone.

## Words used in this guide

| Word | Meaning |
| --- | --- |
| Storage account | One connected Gmail/Google Drive account, or one S3 bucket. Files are stored there as encrypted blobs. |
| Copy | One encrypted blob of a file on one storage account. Every file has two copies on two different accounts, unless the second copy is turned off. |
| Second copy | The admin switch (Admin > Storage) that decides whether new files are stored twice (on, the default) or once (off). |
| Lost copy | A copy the app could not find any more (for example, someone deleted it in Google Drive). |
| Unhealthy account | An account that refused access (password changed, access revoked, bucket deleted). It is skipped until you reconnect it. |
| Cap | A size limit you set per storage account. It counts encrypted bytes this app stored there. |
| Full | The account has reached its cap or its real free space. New files skip it. |
| Paused | Google said the account hit its daily upload limit (about 750 GB per day). It is skipped for 24 hours. |
| Copy check | An hourly background check that each copy still exists. Every copy is checked about once a week. |
| Repair | A button that makes a new copy for every file that has fewer than two good copies. |
| WebDAV | A standard way for other programs (rclone, and through it Jellyfin, Sonarr...) to use the drive like a folder. Off unless an admin turns it on per user. |
| Storage limit | A size limit you set per family member. It counts each file once at its real size, trash included. |

## Who can see what

- **Family members** see only their own files, files shared with them, and one "storage left" number. They cannot open the admin area.
- **The admin** manages users and storage. The admin screens show no file names and give no access to other people's files.
- **Google / S3** see encrypted blobs named like `3f9c...e1.bin`. They can tell files exist, roughly how big they are and when they were uploaded. Nothing can be previewed or shared from Google Drive.
- **Anyone with the server, the database and the master key** can decrypt everything. This is accepted: it is what lets the admin reset a forgotten password without losing that person's files.
- File and folder **names** are stored in plain text in MySQL, so search works.

## Install with Docker

You need Docker (with Compose) and `openssl`.

**1. Create the settings file.**

```bash
cp .env.docker.example .env
```

**2. Fill in the secrets.** Open `.env` and replace the example values:

- `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`: run `openssl rand -hex 24` for each. Use **only letters and numbers**: a password with `/ : @ # ? %` or `$` breaks the database address and the backend keeps restarting.
- `JWT_ACCESS_SECRET` and `TOKEN_ENCRYPTION_KEY`: run `openssl rand -hex 32` once for each and paste the results. Set `TOKEN_ENCRYPTION_KEY` now: changing it later means reconnecting every storage account. (The backend prints a warning at start if either is still the example value.)
- `FILE_MASTER_KEY`: run `openssl rand -base64 32` and paste the result. **Copy it somewhere safe and offline right now** (see [The master key](#the-master-key)). Docker refuses to start without it.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: from [Google Cloud setup](#google-cloud-setup). You can also leave them and enter them later in **Admin > Storage**.

**3. Start everything.**

```bash
docker compose up -d --build
```

**4. Create your admin account.** It asks for a password (at least 8 characters).

```bash
docker compose exec backend npm run admin:create -- --email you@example.com --name "Your Name"
```

**5. Sign in** at http://localhost:5173.

**6. Connect storage.** Open **Admin > Storage** and connect **at least two** accounts (two Gmail accounts, or Gmail plus an S3 bucket). With fewer than two, uploads are refused, unless you turn the second copy off (then one account is enough).

**7. Add your family.** Open **Admin > Users > Add user**. Give each person a temporary password; they must choose their own at first sign-in.

To stop: `docker compose down`. **Never** add `-v`: `docker compose down -v` deletes the database and every local backup.

## Google Cloud setup

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen. The app asks only for the `drive.file` scope (it can see only files it created) plus email and profile to identify the account.
3. Set the publishing status to **In production**. In "Testing" mode, Google expires the connection every 7 days and every account silently stops working.
4. Create an OAuth client of type **Web application** and add the redirect URI:
   - on your own computer: `http://localhost:4000/connected-accounts/google/callback`
   - on a server with a domain: `https://your-domain/api/connected-accounts/google/callback`
5. Put the client ID, secret and the same redirect URI either in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`) before the first start, or in **Admin > Storage > Google OAuth credentials**.

`.env` values are copied into the database only when no Google config exists yet. After that, **Admin > Storage** is the place to change them; editing `.env` again has no effect.

Things to know:

- An unverified app shows a warning screen when you connect an account (click **Advanced**, then continue). It is limited to 100 connected accounts, which is plenty for a family.
- **Never replace or delete the Google Cloud project.** With `drive.file`, access to the stored files belongs to that project. A new project cannot read the existing blobs.
- On the Google screen, keep the **Google Drive** box ticked. If it is unticked the connection is refused with a message saying so.
- Linking many Gmail accounts to one server may get them flagged by Google. Two copies of every file reduce the risk of loss but do not remove it.

## Put it on the internet

The app container serves the website and forwards everything under `/api/` to the backend. So only **one** address needs to be public:

1. Put an HTTPS reverse proxy (Caddy, nginx, Traefik...) in front of port **5173** only. The backend port 4000 stays bound to `127.0.0.1` and must not be public.
2. In `.env`, set `FRONTEND_URL=https://your-domain` and `TRUST_PROXY_HOPS=2` (your proxy plus the app's own). Without it, every sign-in looks like it comes from your proxy and the sign-in limits hit everyone at once. Leave `VITE_API_URL` at its default: the app then talks to `https://your-domain/api`.
3. Use `https://your-domain/api/connected-accounts/google/callback` as the Google redirect URI, both in Google Cloud and in **Admin > Storage**.
4. Rebuild: `docker compose up -d --build`.

All file bytes pass through your server, so its internet speed limits playback and uploads. Run only one backend container.

## Day-to-day admin

**Users** (**Admin > Users**)
- **Add user:** name, email, temporary password, optional storage limit in GB.
- **Limit:** change someone's storage limit. Empty means unlimited.
- **Reset:** sets a new temporary password and signs that person out everywhere.
- **Disable / Enable:** blocks or unblocks sign-in, API keys, WebDAV and their public links, at once. Nothing is deleted.
- **WebDAV on / off:** lets this user mount their files with rclone (see [Media library over WebDAV](#media-library-over-webdav-rclone-jellyfin)). Turning it off revokes their WebDAV keys.
- **Delete:** permanently deletes the person and **all their files**, after you type their email. Use Disable if unsure.
- At least one active admin must always remain. A second admin can only be created with the `admin:create` command.

**Storage** (**Admin > Storage**)
- **Connect Google / Connect S3:** add a storage account. Reconnecting the same Gmail account or bucket updates it instead of adding a duplicate.
- **Second copy (on / off):** on (the default) stores every new file on two different accounts, so losing an account loses nothing, but each file uses twice its size. Off stores new files once, so all free space can be used; if an account is then lost, the files stored only there are gone. Files keep the copies they already have. After turning it back on, press **Repair** to add a second copy to files stored only once.
- **Default cap for new accounts:** applies only to accounts connected afterwards. Each account's own cap can be changed in the table.
- **Routing** decides which two accounts get a new file:
  - *Most available space:* the two with the most room.
  - *Round robin:* takes turns.
  - *Priority order:* the first two in your list that have room.
- **Health** shows how many files have fewer good copies than the second-copy setting asks for, and each account's status.
- **Copy check:** every hour the app checks a batch of copies to make sure they still exist, so each copy is looked at about once a week. A copy deleted behind the app's back (for example in Google Drive) shows up in Health as a lost copy even if nobody opens that file.
- **Repair** first checks that every copy still exists (on a big library this takes a few minutes before the progress moves), then copies the encrypted bytes of every file with a missing copy onto another account. Run it after an account is lost, or after adding a new one. It runs in the background and resumes after a restart. Playback keeps working from the surviving copy meanwhile.
- **Remove:** takes an account out of the app. It is refused while any file's only good copy is on it (run Repair onto another account first). The blobs stay in that Google Drive or bucket; delete them there by hand if you want.
- **Unhealthy account:** reconnect it (same button as connecting). For S3, enter the bucket details again.

**Family members** can share a file with a public link (it can expire), upload with API keys (**API Keys** page), use trash, and see their activity.

## Media library over WebDAV (rclone, Jellyfin)

WebDAV lets other programs use Doogle like a normal folder. The main use: **rclone** on a Raspberry Pi (or any machine) mounts one user's files at, say, `/media/library`, and Jellyfin, Sonarr and Radarr read, write, rename and delete there as on a local disk. Files are still encrypted and stored twice; renames cost nothing on Google's side.

```
Jellyfin / Sonarr / Radarr  ->  /media/library (rclone mount)  ->  https://your-domain/api/dav  ->  two copies on Google/S3
```

**Set it up**

1. **Admin > Users > Add user**, for example `media@family.local`. Give it a storage limit for the media library (with two copies, a pool of about 1 TB holds about 450 GB).
2. On that user's row, press **WebDAV on**. Only users switched on by an admin can use WebDAV. **WebDAV off** revokes their WebDAV keys at once.
3. Sign in as that user, open **API Keys**, create a key and choose **WebDAV**. Copy the key; it is shown once.
4. In the web app as that user, create the folders you want (`tv`, `movies`...), or let rclone create them.
5. On the Pi, configure rclone (the API Keys page shows this with your address):

```ini
[familydrive]
type = webdav
url = https://your-domain/api/dav
vendor = owncloud
user = media@family.local
pass = <output of: rclone obscure YOUR_WEBDAV_KEY>
```

```bash
rclone mount familydrive: /media/library \
  --vfs-cache-mode full --vfs-cache-max-size 100G --vfs-cache-max-age 72h \
  --vfs-read-chunk-size 16M --buffer-size 32M --dir-cache-time 1m \
  --vfs-write-back 30s --transfers 2 --allow-other
```

**Good to know**

- **Deleting over WebDAV is permanent.** Files do not go to the trash; the space is free at once.
- Sign-in is your email plus the WebDAV key. A normal upload key does not work for WebDAV, and a WebDAV key can read, change and delete everything that user owns. Keep it on the Pi only.
- Use it only over HTTPS, or limit it to your home network and Tailscale with the `allow`/`deny` lines in `frontend/nginx.conf` (block `location /api/dav`).
- **rclone keeps decrypted copies on the Pi's disk** (`--vfs-cache-mode full`). The server never stores plain files, but the Pi does. Use an encrypted disk if that matters to you.
- Movies over 5 GB: raise `MAX_UPLOAD_BYTES` in `.env` (for example `21474836480` for 20 GB) and run `docker compose up -d`.
- Upload speed is about half your internet upload speed (two copies). Google allows about 750 GB of uploads per account per day; a big first import pauses accounts for 24 hours, so copy it in batches.
- After 10 wrong keys from one address in 15 minutes, WebDAV refuses that address for a while.
- Test it: `./scripts/dav-smoke-test.sh https://your-domain/api/dav media@family.local <key>` checks every WebDAV action in a `_smoke_test` folder. `./scripts/rclone-test.sh` does the same with rclone.
- File names are case-sensitive over WebDAV (`Show.mkv` and `show.mkv` are different). If the web app has two files with the same name in a folder, WebDAV shows only the newest; a folder wins over a file.
- Windows Explorer and macOS Finder cannot mount it read-write (they need WebDAV locks). Use rclone.

## Backups and restore

The `backup` service runs `mysqldump` once a day into the Docker volume `backups` (gzipped) and deletes dumps older than 14 days. The first dump is taken as soon as the backend has created the database tables.

- Backups **do not** contain `FILE_MASTER_KEY`. The key is only in `.env`.
- Copy **both** off the server regularly, and keep them in **different places**: the dumps, and the key (offline).
- Copy the dumps out with:

```bash
docker compose cp backup:/backups/. ./backups-copy/
```

### Restore

**Restoring replaces the current database** (the dump drops and recreates every table). Take a fresh dump of the current state first and copy it off the server. The `FILE_MASTER_KEY` in `.env` must be the one that was used with this backup; with another key the backend refuses to start.

```bash
docker compose stop backend
docker compose exec -T backup sh -c 'ls /backups'          # pick a file
docker compose exec -T backup sh -c 'gunzip -c /backups/backup-YYYYMMDDTHHMMSSZ.sql.gz' \
  | docker compose exec -T mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" doogle'
docker compose start backend
```

If you changed `MYSQL_DATABASE`, use that name instead of `doogle`.

On a new server, with a dump you copied off the old one:

```bash
# .env must already hold the same FILE_MASTER_KEY as the old server
docker compose up -d mysql
gunzip -c ./backups-copy/backup-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose exec -T mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" doogle'
docker compose up -d --build
```

## Updating

```bash
docker compose exec -T backup sh -c 'BACKUP_ONCE=1 bash /usr/local/bin/mysql-backup.sh'   # fresh backup first
git pull
docker compose up -d --build
```

Database changes are applied automatically when the backend starts. Check `docker compose logs backend` for `Backend running`. Your `.env`, the database and the backups are kept.

The app used to be called 9Drive. If your `.env` says `MYSQL_DATABASE=9drive` or `MYSQL_USER=9drive`, keep those lines: they are your existing database. New installs use `doogle`.

## The master key

`FILE_MASTER_KEY` derives the keys that encrypt every file. If you lose it, **every file is permanently unreadable**. There is no recovery. Never change it on an existing install. Write it down or keep it in a password manager, separate from the backups.

The backend stores a fingerprint of the key the first time it starts and refuses to start with a different key, so a wrong key can never write unreadable files.

## Settings reference

These go in the root `.env` for Docker (or `backend/.env` without Docker).

| Setting | What it does |
| --- | --- |
| `FILE_MASTER_KEY` | Required. 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts every file. Never change it. |
| `JWT_ACCESS_SECRET` | Signs sign-in tokens. Changing it signs everyone out. |
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored Google/S3 credentials. Changing it means reconnecting every storage account. |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | Database login. |
| `FRONTEND_URL` | The address people open in the browser. Only this address may call the API. |
| `VITE_API_URL` | Leave at the default. Change only if the backend has its own public address. Needs a rebuild. |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` | How long a sign-in lasts (default 1 hour, renewed for 30 days). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google OAuth client, copied into the database at first start only. |
| `MAX_UPLOAD_BYTES` | Largest single file, in bytes. Default 5 GB. |
| `TRUST_PROXY_HOPS` | How many proxies sit in front of the backend: `1` = only the app container (default), `2` = with your own HTTPS proxy. |
| `DAV_ENABLED` | `true` (default) turns on WebDAV at `/api/dav`. Users still need an admin to switch them on. |
| `DAV_CACHE_MB`, `DAV_READ_AHEAD` | RAM for decrypted pieces while files are read over WebDAV (default 256 MB), and how many 8 MB pieces to read ahead (default 2). |

## Troubleshooting

| You see | What to do |
| --- | --- |
| "The family storage pool does not have enough free space" | Two accounts with room are needed. Connect another account, raise a cap, or free space. |
| An account shows **Unhealthy** | Its owner changed the password, revoked access, or the bucket is gone. Reconnect it, then run **Repair**. |
| An account shows **Paused** | Google's daily upload limit. It comes back by itself after 24 hours. |
| "Lost copies" above 0 | Run **Repair**. |
| Backend stops with "FILE_MASTER_KEY does not match" | `.env` has a different key from the one this database was created with. Put the original key back. |
| Every Google account stops working after a week | The Google OAuth app is still in "Testing". Set it to **In production** and reconnect the accounts. |
| Google connection fails with a "redirect_uri_mismatch" error | The redirect URI in Google Cloud and in **Admin > Storage** must be exactly the same, including `https` and `/api`. |
| An upload keeps failing | Press **Retry** in the upload panel; it continues where it stopped, as long as the tab was not closed. |
| "Lost copies" appear without anything happening | The copy check found a copy that was deleted in Google Drive or the bucket. Run **Repair**. |
| rclone says 401 | The user needs **WebDAV on** in Admin > Users, the key must be a **WebDAV** key (not upload-only), and the rclone `user` must be that user's email. |
| rclone says 429 | Too many wrong keys from that address. Wait 15 minutes, then fix the key. |
| Sign-ins get "too many attempts" for everyone | You have an HTTPS proxy in front: set `TRUST_PROXY_HOPS=2` and run `docker compose up -d`. |
| Backend keeps restarting with `P1013 ... empty host in database URL` | `MYSQL_PASSWORD` or `MYSQL_USER` contains a character like `/ : @ # ?`. Use letters and numbers only (`openssl rand -hex 24`). If nothing is stored yet, recreate the database with `docker compose down -v` and `docker compose up -d --build` (this deletes the database). |
| Logs | `docker compose logs -f backend` |

## What has been tested

- **Automatic tests** (`npm test`, `npm run test:integration`): encryption, seeking, uploads with dropped connections, both copies, failover, the copy check, Repair, permissions, WebDAV.
- **The full Docker stack, end to end**, with an S3-compatible test server as storage: sign-in and password change, connecting S3, upload and download through nginx (checked byte for byte, plus seeking), that the buckets hold only encrypted `.bin` files, public links, disabling a user, WebDAV with the smoke test, failover after deleting a copy, Repair, backup and restore, and the wrong-key refusal.
- **Not yet tested:** real Google accounts, rclone itself, a Raspberry Pi, and the pages in a browser. Do the [owner's first check](#owners-first-check) before trusting real files to it.

## Known limits and open issues

- Invites list names but give the recipient no access to the file yet.
- Office files (Word, Excel...) have no preview. Images, video, audio and PDF do.
- One backend process only.
- An upload that stops (tab closed, connection lost) keeps its reserved space for up to a day. Then the hourly cleanup cancels it and deletes its partial copies.
- There is no button to cancel an upload while it runs.
- An account marked **Unhealthy** stays out until you reconnect it, even if the problem was brief.
- PDF preview has not yet been checked in Chrome with the app's strict file security header. Download always works.

## Owner's first check

Do this once with two real Gmail accounts before storing real files:

1. Connect both accounts in **Admin > Storage**.
2. Upload an mp4.
3. Open each Google Drive: you should see only a `Doogle` folder with a `.bin` file, no preview and no sharing.
4. Play the video in the app and jump around in it.
5. Revoke the app's access on one Gmail account (Google Account > Security > Third-party access). Playback must keep working.
6. Connect a third account and press **Repair**. Health should go back to 0 files missing a copy.

## Install without Docker

You need Node.js 22 and MySQL 8+ (Node 20 still runs but is past end of life). Run `./setup.sh` (or `setup.ps1` on Windows). It creates `backend/.env` and `frontend/.env`, generates the master key and shows it once (type `I SAVED IT` to continue), installs packages, and can create the first admin. It never overwrites an existing master key. Then run `npm run dev` in `backend` and in `frontend`.

## Development

```bash
# once: the test database
docker run -d --name family-drive-testdb -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=family_drive_test -p 127.0.0.1:13306:3306 mysql:8.4

cd backend && npm run build && npm test      # unit tests
cd backend && npm run test:integration       # integration tests (also runs the WebDAV smoke script; needs bash, curl and sha256sum)
cd frontend && npm run build
```

See `AGENTS.md` for the code layout and conventions.
