#!/usr/bin/env bash
set -euo pipefail
# PostgreSQL official initdb / pg_ctl path; no shared DB, TCP listener or password.
# https://www.postgresql.org/docs/18/app-initdb.html
# https://www.postgresql.org/docs/18/app-pg-ctl.html
# Run on an admitted work host, never on Ryzen 1.
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" ]] || { echo 'PostgreSQL 18 binaries required (PG_BIN may select installed version)' >&2; exit 2; }
: "${SCREEN_CAPTURE_TEST_EVIDENCE:?Set an evidence directory outside disposable cluster}"
mkdir -p "$SCREEN_CAPTURE_TEST_EVIDENCE"
root=$(mktemp -d "${TMPDIR:-/tmp}/hl-screen-capture.XXXXXX")
chmod 700 "$root"
started=0
cleanup() {
  rc=$?
  trap - EXIT
  if (( started )); then
    if ! "$PG_BIN/pg_ctl" -D "$root/data" -m fast -w -t 20 stop >>"$SCREEN_CAPTURE_TEST_EVIDENCE/cleanup.log" 2>&1; then
      echo "CLEANUP_FAILED cluster retained: $root" >&2
      exit 1
    fi
  fi
  [[ ! -f "$root/server.log" ]] || cp "$root/server.log" "$SCREEN_CAPTURE_TEST_EVIDENCE/postgres.log"
  rm -rf -- "$root" # Owned synthetic DB only; no agent session or trace here.
  echo 'CLEANUP_COMPLETE owned PostgreSQL stopped and private cluster removed'
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
mkdir "$root/socket"
"$PG_BIN/initdb" -D "$root/data" --auth-local=peer --auth-host=reject --no-locale --encoding=UTF8 >"$SCREEN_CAPTURE_TEST_EVIDENCE/initdb.log"
port=$((20000 + $$ % 20000))
"$PG_BIN/pg_ctl" -D "$root/data" -l "$root/server.log" -o "-k '$root/socket' -p $port -c listen_addresses='' -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=12" -w -t 20 start >"$SCREEN_CAPTURE_TEST_EVIDENCE/start.log"
started=1
export SCREEN_CAPTURE_TEST_OWNED=yes SCREEN_CAPTURE_TEST_PGHOST="$root/socket" SCREEN_CAPTURE_TEST_PGPORT="$port" SCREEN_CAPTURE_TEST_PGUSER
SCREEN_CAPTURE_TEST_PGUSER=$(id -un)
node --test "$@" test/capture.test.mjs
