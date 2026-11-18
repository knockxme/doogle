#!/usr/bin/env bash
# The real-world test: what the Pi will do. Needs rclone installed.
#
#   ./scripts/rclone-test.sh http://127.0.0.1:4100/api/dav media@example.com devkey
set -euo pipefail
URL="${1:?url}"; USER_EMAIL="${2:?email}"; API_KEY="${3:?api key}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export RCLONE_CONFIG_FAMILYDRIVE_TYPE=webdav
export RCLONE_CONFIG_FAMILYDRIVE_URL="$URL"
export RCLONE_CONFIG_FAMILYDRIVE_VENDOR=owncloud      # makes rclone send X-OC-Mtime
export RCLONE_CONFIG_FAMILYDRIVE_USER="$USER_EMAIL"
export RCLONE_CONFIG_FAMILYDRIVE_PASS="$(rclone obscure "$API_KEY")"

mkdir -p "$TMP/src/tv/Some Show (2024)/Season 01" "$TMP/src/movies/A Movie (2023)"
head -c 3500000 /dev/urandom > "$TMP/src/tv/Some Show (2024)/Season 01/Some Show - S01E01.mkv"
head -c 2100000 /dev/urandom > "$TMP/src/movies/A Movie (2023)/A Movie (2023).mp4"
echo '<movie/>' > "$TMP/src/movies/A Movie (2023)/movie.nfo"

echo "== copy up";            rclone copy "$TMP/src" familydrive:_rclone_test
echo "== list";               rclone lsl familydrive:_rclone_test
echo "== check (sizes)";      rclone check --size-only "$TMP/src" familydrive:_rclone_test
echo "== download + compare"; rclone copy familydrive:_rclone_test "$TMP/back"; diff -r "$TMP/src" "$TMP/back" && echo "   identical"
echo "== rename (MOVE)";      rclone moveto "familydrive:_rclone_test/movies/A Movie (2023)/movie.nfo" "familydrive:_rclone_test/movies/A Movie (2023)/renamed.nfo"
echo "== about (quota)";      rclone about familydrive: || true
echo "== purge";              rclone purge familydrive:_rclone_test
echo "== done"
