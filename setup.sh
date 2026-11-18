#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required." >&2
  exit 1
fi

node_major=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20+ is required. Found $(node --version)." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backend_dir="$script_dir/backend"
frontend_dir="$script_dir/frontend"

random_key() {
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
}

has_master_key() {
  [ -f "$backend_dir/.env" ] && grep -Eq '^FILE_MASTER_KEY=("?)[^"[:space:]]+' "$backend_dir/.env"
}

# Generates a key, shows it once and makes the operator confirm. Sets new_master_key.
# Nothing is written to disk until the operator has confirmed.
new_master_key=""
if ! has_master_key; then
  new_master_key=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
  echo
  echo "=============================================================="
  echo "FILE_MASTER_KEY (shown only once):"
  echo
  echo "  $new_master_key"
  echo
  echo "Every file is encrypted with keys derived from this value."
  echo "If you lose it, every file becomes permanently unreadable."
  echo "Copy it somewhere safe and offline NOW, separate from your"
  echo "database backups."
  echo "=============================================================="
  while :; do
    printf 'Type I SAVED IT to continue: '
    if ! IFS= read -r answer; then
      echo "No confirmation received. Nothing was written." >&2
      exit 1
    fi
    [ "$answer" = "I SAVED IT" ] && break
  done
fi

if [ ! -f "$backend_dir/.env" ]; then
  printf "MySQL DATABASE_URL [mysql://root@localhost:3306/doogle]: "
  IFS= read -r database_url
  database_url=${database_url:-mysql://root@localhost:3306/doogle}

  {
    printf 'DATABASE_URL="%s"\n' "$database_url"
    printf 'APP_PORT=4000\n'
    printf 'FRONTEND_URL="http://localhost:5173"\n'
    printf 'JWT_ACCESS_SECRET="%s"\n' "$(random_key)"
    printf 'TOKEN_ENCRYPTION_KEY="%s"\n' "$(random_key)"
    printf 'ACCESS_TOKEN_TTL_SECONDS=900\n'
    printf 'REFRESH_TOKEN_TTL_DAYS=30\n'
    printf 'MAX_UPLOAD_BYTES=5368709120\n'
    printf 'FILE_MASTER_KEY="%s"\n' "$new_master_key"
    printf 'GOOGLE_CLIENT_ID=""\n'
    printf 'GOOGLE_CLIENT_SECRET=""\n'
    printf 'GOOGLE_REDIRECT_URI="http://localhost:4000/connected-accounts/google/callback"\n'
  } > "$backend_dir/.env"
  echo "Created backend/.env"
elif [ -n "$new_master_key" ]; then
  printf 'FILE_MASTER_KEY="%s"\n' "$new_master_key" >> "$backend_dir/.env"
  echo "Added FILE_MASTER_KEY to backend/.env"
fi

if [ ! -f "$frontend_dir/.env" ]; then
  {
    printf 'VITE_API_URL=http://localhost:4000\n'
  } > "$frontend_dir/.env"
  echo "Created frontend/.env"
fi

(cd "$backend_dir" && npm install && npm run prisma:generate)
(cd "$frontend_dir" && npm install)

echo "Setup complete."
printf 'Run migrations and create the first admin now? [y/N]: '
IFS= read -r run_admin || run_admin=""
case "$run_admin" in
  y|Y|yes|YES)
    printf 'Admin email: '
    IFS= read -r admin_email
    printf 'Admin name: '
    IFS= read -r admin_name
    (cd "$backend_dir" && npm run db:migrate:deploy && npm run admin:create -- --email "$admin_email" --name "$admin_name")
    ;;
  *)
    echo "Later: cd backend && npm run db:migrate:deploy && npm run admin:create -- --email <email> --name <name>"
    ;;
esac
