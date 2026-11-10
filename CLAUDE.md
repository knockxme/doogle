# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` holds the architecture, conventions, security rules and commands. Extra notes:

## Commands

- Backend: `cd backend && npm run build && npm test && npm run test:integration`.
- The integration tests need the local test MySQL on `127.0.0.1:13306` (container `family-drive-testdb`, mysql:8.4, root password `root`). Start it with `docker start family-drive-testdb` if it is stopped.
- Frontend: `cd frontend && npm run build`.
- `cd backend && npm run test:s3` and `npm run test:api-upload` are manual smoke scripts in `backend/src/scripts/`.
- On Windows, if `prisma generate` fails because a file is locked, stop the dev servers first.

## Things to remember

- ESM with `module: NodeNext`: relative imports need a `.js` suffix even in `.ts` files.
- Code that touches a stored blob goes through the provider layer (`modules/storage/provider.ts`); do not call Google or S3 SDKs from routes.
- Upload placement is whole-file: `pool-select.ts` chooses two different accounts, `pool.ts` reserves space on both. Reads try one replica and fall back to the other; Repair rebuilds missing replicas.
- The Google OAuth client comes from the database (`ProviderConfig`, seeded from `GOOGLE_*` or saved by an admin), not from `env.ts`.
- Frontend: `lib/api.ts` falls back to `/api` (proxied by `frontend/nginx.conf`, request buffering off) when `VITE_API_URL` is unset or the default. The PWA service worker (`vite.config.ts`) has a `navigateFallbackDenylist` of backend path prefixes; add new top-level backend routes there.
- Do not run `setup.sh` / `setup.ps1` against the real `backend/.env`; test them in a temporary copy.
