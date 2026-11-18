#!/usr/bin/env bash
# Checks every WebDAV method Doogle must support, with plain curl.
#
#   ./scripts/dav-smoke-test.sh http://127.0.0.1:4100/api/dav media@example.com devkey
#   ./scripts/dav-smoke-test.sh https://drive.example.com/api/dav media@family you-api-key
#
# Creates and deletes a folder called _smoke_test. Exits non-zero on the first failure.
set -euo pipefail

BASE="${1:?base url, e.g. http://127.0.0.1:4100/api/dav}"
USER_EMAIL="${2:?email}"
API_KEY="${3:?api key}"
BASE="${BASE%/}"
AUTH=(-u "$USER_EMAIL:$API_KEY")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
check() { # check <name> <expected-status> <actual-status>
  if [[ "$2" == "$3" ]]; then echo "  ok   $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL $1: expected $2, got $3"; exit 1; fi
}
code() { curl -s -o "$TMP/out" -w '%{http_code}' "$@"; }

echo "== Doogle WebDAV smoke test: $BASE"

check "OPTIONS"                 200 "$(code -X OPTIONS "$BASE/")"
check "no auth → 401"           401 "$(code -X PROPFIND -H 'Depth: 0' "$BASE/")"
check "wrong key → 401"         401 "$(code -u "$USER_EMAIL:wrong" -X PROPFIND -H 'Depth: 0' "$BASE/")"
check "PROPFIND root"           207 "$(code "${AUTH[@]}" -X PROPFIND -H 'Depth: 1' "$BASE/")"
check "Depth infinity → 403"    403 "$(code "${AUTH[@]}" -X PROPFIND -H 'Depth: infinity' "$BASE/")"

curl -s "${AUTH[@]}" -X DELETE "$BASE/_smoke_test/" >/dev/null || true
check "MKCOL"                   201 "$(code "${AUTH[@]}" -X MKCOL "$BASE/_smoke_test/")"
check "MKCOL again → 405"       405 "$(code "${AUTH[@]}" -X MKCOL "$BASE/_smoke_test/")"
check "MKCOL no parent → 409"   409 "$(code "${AUTH[@]}" -X MKCOL "$BASE/_smoke_test/a/b/")"
check "MKCOL subfolder"         201 "$(code "${AUTH[@]}" -X MKCOL "$BASE/_smoke_test/Show%20Name/")"

# 5.5 MB random file → several pieces on the dev server (1 MiB pieces)
head -c 5767168 /dev/urandom > "$TMP/video.mkv"
SUM="$(sha256sum "$TMP/video.mkv" | cut -d' ' -f1)"
FILE="$BASE/_smoke_test/Show%20Name/S01E01%20%5Btest%5D.mkv"

check "PUT new"                 201 "$(code "${AUTH[@]}" -T "$TMP/video.mkv" -H 'X-OC-Mtime: 1700000000' "$FILE")"
check "GET full"                200 "$(code "${AUTH[@]}" "$FILE")"
[[ "$(sha256sum "$TMP/out" | cut -d' ' -f1)" == "$SUM" ]] && echo "  ok   GET bytes match" || { echo "  FAIL GET bytes differ"; exit 1; }

# Range that crosses a piece boundary
check "GET range"               206 "$(code "${AUTH[@]}" -H 'Range: bytes=1048000-2097300' "$FILE")"
dd if="$TMP/video.mkv" of="$TMP/expect" bs=1 skip=1048000 count=1049301 status=none
cmp -s "$TMP/out" "$TMP/expect" && echo "  ok   range bytes match" || { echo "  FAIL range bytes differ"; exit 1; }

check "GET suffix range"        206 "$(code "${AUTH[@]}" -H 'Range: bytes=-1000' "$FILE")"
tail -c 1000 "$TMP/video.mkv" > "$TMP/expect"
cmp -s "$TMP/out" "$TMP/expect" && echo "  ok   suffix bytes match" || { echo "  FAIL suffix bytes differ"; exit 1; }

check "GET bad range → 416"     416 "$(code "${AUTH[@]}" -H 'Range: bytes=99999999-' "$FILE")"
check "HEAD"                    200 "$(code "${AUTH[@]}" -I "$FILE")"

curl -s "${AUTH[@]}" -X PROPFIND -H 'Depth: 0' "$FILE" > "$TMP/prop"
grep -q '<d:getcontentlength>5767168</d:getcontentlength>' "$TMP/prop" && echo "  ok   PROPFIND size" || { echo "  FAIL PROPFIND size"; cat "$TMP/prop"; exit 1; }
grep -q 'Tue, 14 Nov 2023 22:13:20 GMT' "$TMP/prop" && echo "  ok   X-OC-Mtime kept" || echo "  warn X-OC-Mtime not stored (optional)"

check "PUT overwrite"           204 "$(code "${AUTH[@]}" -T "$TMP/video.mkv" "$FILE")"
: > "$TMP/empty.nfo"
check "PUT empty file"          201 "$(code "${AUTH[@]}" -T "$TMP/empty.nfo" "$BASE/_smoke_test/empty.nfo")"
check "chunked no size → 411"   411 "$(code "${AUTH[@]}" -T - "$BASE/_smoke_test/x.bin" < "$TMP/empty.nfo")"
check "PUT no parent → 409"     409 "$(code "${AUTH[@]}" -T "$TMP/video.mkv" "$BASE/_smoke_test/nope/x.mkv")"

DEST="$BASE/_smoke_test/Show%20Name/S01E01.mkv"
check "MOVE rename"             201 "$(code "${AUTH[@]}" -X MOVE -H "Destination: $DEST" "$FILE")"
check "old name gone → 404"     404 "$(code "${AUTH[@]}" -I "$FILE")"
check "MOVE no-overwrite → 412" 412 "$(code "${AUTH[@]}" -X MOVE -H "Destination: $DEST" -H 'Overwrite: F' "$BASE/_smoke_test/empty.nfo")"
check "MOVE folder into itself" 409 "$(code "${AUTH[@]}" -X MOVE -H "Destination: $BASE/_smoke_test/Show%20Name/inner/" "$BASE/_smoke_test/Show%20Name/")"
check "MOVE folder"             201 "$(code "${AUTH[@]}" -X MOVE -H "Destination: $BASE/_smoke_test/Renamed%20Show/" "$BASE/_smoke_test/Show%20Name/")"
check "moved file readable"     200 "$(code "${AUTH[@]}" -I "$BASE/_smoke_test/Renamed%20Show/S01E01.mkv")"

curl -s "${AUTH[@]}" -X PROPFIND -H 'Depth: 1' "$BASE/_smoke_test/" > "$TMP/list"
grep -q '.dav-upload-' "$TMP/list" && { echo "  FAIL temp upload names visible"; exit 1; } || echo "  ok   no temp files in listing"

check "DELETE file"             204 "$(code "${AUTH[@]}" -X DELETE "$BASE/_smoke_test/empty.nfo")"
check "DELETE folder (tree)"    204 "$(code "${AUTH[@]}" -X DELETE "$BASE/_smoke_test/")"
check "deleted → 404"           404 "$(code "${AUTH[@]}" -X PROPFIND -H 'Depth: 0' "$BASE/_smoke_test/")"
check "DELETE root → 403"       403 "$(code "${AUTH[@]}" -X DELETE "$BASE/")"

echo "== all $pass checks passed"
