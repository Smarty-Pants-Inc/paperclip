#!/usr/bin/env bash
# G3 core no-silent rows (C35, E3.01 control, E3.04, E3.05, E3.09) against a Paperclip fork commit.
# Usage: scripts/g3-core-rows.sh <fork-commit-sha> [image-id-label]
# Prints ONE table line: | g3-core | <label> | <sha> | C35 | E3.01ctl | E3.04 | E3.05 | E3.09 | passed/total | verdict |
# Needs: git with the Smarty-Pants-Inc/paperclip remote as 'origin', node 24, corepack. Runs embedded Postgres.
set -euo pipefail
SHA="${1:?fork commit sha}"; LABEL="${2:-$SHA}"
ROOT="$(git rev-parse --show-toplevel)"; TEST_REF="${G3_TEST_REF:-origin/fv2/g3-core-rows}"
W="$(mktemp -d "${TMPDIR:-/tmp}/g3rows.XXXXXX")"; trap 'git -C "$ROOT" worktree remove --force "$W/src" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
git -C "$ROOT" fetch -q origin "$SHA" fv2/g3-core-rows 2>/dev/null || true
git -C "$ROOT" worktree add -q --detach "$W/src" "$SHA"
git -C "$ROOT" show "$TEST_REF:server/src/services/heartbeat/g3-core-progress.test.ts" > "$W/src/server/src/services/heartbeat/g3-core-progress.test.ts"
cd "$W/src"
mkdir -p "$W/bin"; printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$W/bin/pnpm"; chmod +x "$W/bin/pnpm"; export PATH="$W/bin:$PATH"
corepack pnpm install --frozen-lockfile >"$W/install.log" 2>&1
for p in @paperclipai/shared @paperclipai/plugin-sdk @paperclipai/adapter-utils; do corepack pnpm --filter "$p" build >>"$W/build.log" 2>&1; done
cd server
npx --no-install vitest run src/services/heartbeat/g3-core-progress.test.ts --reporter=json --outputFile="$W/r.json" >"$W/test.log" 2>&1 || true
python3 - "$W/r.json" "$LABEL" "$SHA" <<'PY'
import json,sys,re
r=json.load(open(sys.argv[1])); res={}
tot=pas=0
for f in r.get("testResults",[]):
  for t in f.get("assertionResults",[]):
    tot+=1; ok=t.get("status")=="passed"; pas+=ok
    n=t.get("fullName","")+" "+t.get("title","")
    for row in ["C35","E3.01","E3.04","E3.05","E3.09"]:
      if row in n: res[row]=res.get(row,True) and ok
cell=lambda k: ("GREEN" if res[k] else "RED") if k in res else "n/a"
v="GREEN" if tot and pas==tot else "RED"
print(f"| g3-core | {sys.argv[2]} | {sys.argv[3][:12]} | C35 {cell('C35')} | E3.01ctl {cell('E3.01')} | E3.04 {cell('E3.04')} | E3.05 {cell('E3.05')} | E3.09 {cell('E3.09')} | {pas}/{tot} | {v} |")
PY
