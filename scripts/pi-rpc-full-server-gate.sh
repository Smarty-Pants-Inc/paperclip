#!/usr/bin/env bash
set -euo pipefail
umask 0022
# Run from a clean committed checkout with pnpm dependencies installed.
# Optional dependency/cache seeds only accelerate builds; no prebuilt runner is
# executed. Workspace links are always rebound to this exact checkout.
wt=$(cd -- "$(dirname -- "$0")/.." && pwd)
sha=${1:-$(git -C "$wt" rev-parse HEAD)}
mode=${2:-candidate}
case "$mode" in candidate|part1|baseline) ;; *) echo 'mode must be candidate, part1 or baseline' >&2; exit 2;; esac
export L3_MODE="$mode"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
test "$(git -C "$wt" rev-parse HEAD)" = "$sha"
test -z "$(git -C "$wt" status --porcelain --untracked-files=all)" || { echo 'Gate requires a clean committed checkout' >&2; exit 2; }
export PATH="$HOME/.cargo/bin:$PATH"
out=${PAPERCLIP_PI_GATE_OUT:?set an absolute gate output directory outside the checkout}
[[ "$out" = /* && "$out" != "$wt" && "$out" != "$wt/"* ]] || exit 2
mkdir -p "$out"
lock=${PAPERCLIP_PI_GATE_LOCK:-$out/build-and-gate.lock}
exec 9>"$lock"
# Shared-resource serialization, with bounded progress messages while waiting.
until flock -n 9; do echo "$(date -u +%FT%TZ) waiting for gate lock: $lock"; sleep 30; done
export TMPDIR=${TMPDIR:-$out/tmp}
[[ "$TMPDIR" = /* && "$TMPDIR" != /tmp && "$TMPDIR" != /tmp/* ]] || { echo 'Dedicated non-/tmp TMPDIR required' >&2; exit 2; }
mkdir -p "$TMPDIR"
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$out/cargo-target}
export npm_config_cache=${npm_config_cache:-$out/npm-cache}
unset npm_config_ignore_scripts NPM_CONFIG_IGNORE_SCRIPTS
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$out/cache}
run="$out/$sha-$mode-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$run"
printf '%s\n' "$run" > "$out/latest-run.txt"
echo "Gate log: $run/driver.log"
exec > "$run/driver.log" 2>&1
phase() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$run/phases.log"; }
trap 'code=$?; if [ -n "${cargo_pid:-}" ]; then wait "$cargo_pid" || true; fi; printf "%s\n" "$code" > "$run/exit-code"; phase "DRIVER_EXIT=$code"' EXIT
phase "START source=$sha mode=$mode"
git -C "$wt" status --short > "$run/source-status-before.txt"
export L3_WT="$wt" L3_OUT="$out"
if [ -n "${PAPERCLIP_PI_GATE_DEPENDENCY_SEED:-}" ]; then
  export L3_BASE="$PAPERCLIP_PI_GATE_DEPENDENCY_SEED"
  python3 - <<'PYDEPS'
import pathlib,os
base=pathlib.Path(os.environ['L3_BASE']); wt=pathlib.Path(os.environ['L3_WT'])
for current,dirs,files in os.walk(base):
 dirs[:]=[d for d in dirs if d not in ['.git','dist','target','provider-pack','provider-assets']]
 if 'node_modules' not in dirs:continue
 dirs.remove('node_modules')
 src=pathlib.Path(current)/'node_modules'; dst=wt/src.relative_to(base);dst.mkdir(parents=True,exist_ok=True)
 for entry in src.iterdir():
  target=dst/entry.name
  if target.exists() or target.is_symlink():continue
  if entry.name=='@paperclipai':
   target.mkdir(exist_ok=True)
   for child in entry.iterdir():
    resolved=child.resolve()
    try: relative=resolved.relative_to(base)
    except ValueError:relative=None
    dest=target/child.name
    if not dest.exists() and not dest.is_symlink():dest.symlink_to(wt/relative if relative is not None else child)
  else:target.symlink_to(entry)
PYDEPS
fi
phase "DEPENDENCIES_READY"
# Copy compiler artifacts once; never execute the copied runner as candidate.
if [ -n "${PAPERCLIP_PI_GATE_CARGO_SEED:-}" ] && [ ! -e "$CARGO_TARGET_DIR/.l3-seeded" ]; then
  mkdir -p "$CARGO_TARGET_DIR"
  phase "CARGO_CACHE_COPY_START"
  cp -a --reflink=auto "$PAPERCLIP_PI_GATE_CARGO_SEED/." "$CARGO_TARGET_DIR/"
  touch "$CARGO_TARGET_DIR/.l3-seeded"
  phase "CARGO_CACHE_COPY_DONE"
fi
phase "RUNNER_BUILD_START"
cargo build --manifest-path "$wt/packages/paperclip-runner/runner/Cargo.toml" --locked -j 4 -p paperclip-runner-core --bin paperclip-runnerd > "$run/cargo.log" 2>&1 &
cargo_pid=$!
phase "TYPESCRIPT_BUILD_START"
(cd "$wt" && pnpm --filter @paperclipai/paperclip-runner build:typescript) > "$run/typescript.log" 2>&1
test_status=$?
phase "TYPESCRIPT_BUILD_DONE=$test_status"
wait "$cargo_pid"
phase "RUNNER_BUILD_DONE"
# Server gate imports TS via Vitest and the tracked source vendor aliases;
# compile server as well, keeping emitted output on ZFS.
phase "SERVER_BUILD_START"
(cd "$wt" && pnpm --filter @paperclipai/plugin-sdk build && cd server && node ../scripts/run-tsc.mjs) > "$run/server-build.log" 2>&1
phase "SERVER_BUILD_DONE"
cp -a --reflink=auto "$wt/server/dist" "$run/server-dist"
cp -a --reflink=auto "$CARGO_TARGET_DIR/debug/paperclip-runnerd" "$run/paperclip-runnerd"
phase "OFFICIAL_PACK_BUILD_START"
pack="$run/provider-pack"
(cd "$wt/packages/paperclip-runner" && node scripts/build-provider-pack.mjs "$pack") > "$run/provider-pack-build.log" 2>&1
phase "OFFICIAL_PACK_BUILD_DONE"
# Native admission rejects group/world-writable qualified executables. The
# ZFS staging tree can inherit writable modes; remove write authority only.
chmod -R go-w "$pack"
phase "PACK_PERMISSION_HARDENING_DONE"
export PAPERCLIP_PI_FULL_SERVER_E2E=1
export PAPERCLIP_RUNNER_BINARY="$run/paperclip-runnerd"
export PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH="$pack"
if [ -z "${PAPERCLIP_PI_E2E_HOME_FIXTURE:-}" ]; then
  phase "PUBLIC_FIXTURE_BUILD_START (private tool-cap leg will be skipped)"
  "$wt/scripts/build-pi-e2e-home-fixture.sh" "$run/pi-home-fixture" > "$run/fixture-build.log" 2>&1
  export PAPERCLIP_PI_E2E_HOME_FIXTURE="$run/pi-home-fixture"
fi
export PAPERCLIP_PI_E2E_PROTOCOL=messages PAPERCLIP_PI_E2E_THINKING_LEVEL=xhigh PAPERCLIP_PI_E2E_TOOL_CALL=1
export PAPERCLIP_PI_E2E_BIG_OUTPUT_BYTES=300000,1500000 PAPERCLIP_PI_E2E_FINISH=1
export PAPERCLIP_PI_E2E_STRICT_CANDIDATE=1 PAPERCLIP_PI_E2E_EXPECT_FINISH_RED=0
if [ "$mode" = baseline ]; then export PAPERCLIP_PI_E2E_STRICT_CANDIDATE=0; fi
if [ "$mode" = part1 ]; then export PAPERCLIP_PI_E2E_EXPECT_FINISH_RED=1; fi
unset PAPERCLIP_PI_E2E_EXCLUDE_SUBAGENTS
(cd "$PAPERCLIP_PI_E2E_HOME_FIXTURE" && sha256sum --check --quiet SHA256SUMS)
export PAPERCLIP_PI_E2E_FIXTURE_MANIFEST_SHA256=$(sha256sum "$PAPERCLIP_PI_E2E_HOME_FIXTURE/SHA256SUMS" | cut -d' ' -f1)
export L3_RUN="$run" L3_SHA="$sha"
python3 - <<'PY'
import hashlib,json,os,pathlib
run=pathlib.Path(os.environ['L3_RUN']);pack=pathlib.Path(os.environ['PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH']);binary=pathlib.Path(os.environ['PAPERCLIP_RUNNER_BINARY'])
wt=pathlib.Path(os.environ['L3_WT'])
def tree_digest(root):
 h=hashlib.sha256()
 for p in sorted(root.rglob('*')):
  if p.is_file():h.update(str(p.relative_to(root)).encode()+b'\0'+hashlib.file_digest(p.open('rb'),'sha256').hexdigest().encode()+b'\n')
 return h.hexdigest()
manifest=json.loads((pack/'provider-pack.json').read_text())
assert manifest['payload']['runnerSourceRevision']==os.environ['L3_SHA']
d={'head':os.environ['L3_SHA'],'runnerBinary':str(binary),'runnerBinarySha256':hashlib.file_digest(binary.open('rb'),'sha256').hexdigest(),'providerPack':str(pack),'providerPackDigest':manifest['digest'],'providerPackManifestSha256':hashlib.sha256((pack/'provider-pack.json').read_bytes()).hexdigest(),'providerPackArtifacts':manifest['payload']['artifacts']}
d['serverDist']=str(run/'server-dist')
d['serverDistTreeSha256']=tree_digest(run/'server-dist')
d['gateTestSha256']=hashlib.sha256((wt/'server/src/__tests__/native-pi-rpc-full-server.e2e.test.ts').read_bytes()).hexdigest()
d['stopTestSha256']=hashlib.sha256((wt/'server/src/__tests__/native-pi-rpc-stop-warm.e2e.test.ts').read_bytes()).hexdigest()
d['gateScriptSha256']=hashlib.sha256((wt/'scripts/pi-rpc-full-server-gate.sh').read_bytes()).hexdigest()
d['nativeObserverSha256']=hashlib.sha256((wt/'server/src/__tests__/helpers/native-pi-home-load-proof.ts').read_bytes()).hexdigest()
d['fixtureManifestSha256']=os.environ['PAPERCLIP_PI_E2E_FIXTURE_MANIFEST_SHA256']
(run/'artifacts.json').write_text(json.dumps(d,indent=2)+'\n')
PY
tests=(src/__tests__/native-pi-rpc-full-server.e2e.test.ts)
if [ "${PAPERCLIP_PI_GATE_INCLUDE_STOP:-0}" = 1 ]; then tests+=(src/__tests__/native-pi-rpc-stop-warm.e2e.test.ts); fi
phase "GATE_START"
set +e
(cd "$wt/server" && timeout 600 ../node_modules/.bin/vitest run --config vitest.config.ts "${tests[@]}") > "$run/gate.log" 2>&1
code=$?
set -e
phase "GATE_DONE=$code"
export L3_GATE_EXIT="$code"
python3 - <<'PY'
import json,os,pathlib,re
run=pathlib.Path(os.environ['L3_RUN']);log=(run/'gate.log').read_text(errors='replace')
roots=re.findall(r'evidence retained at ([^\s\x1b]+)',log)
if not roots:roots=re.findall(r'"root":"([^"]+native-pi-full-server-[^"]+)"',log)
root=pathlib.Path(roots[-1]) if roots else None
receipt={'sourceSha':os.environ['L3_SHA'],'gateMode':os.environ['L3_MODE'],'exitCode':int(os.environ['L3_GATE_EXIT']),'artifacts':json.loads((run/'artifacts.json').read_text()),'gateLog':str(run/'gate.log'),'phases':(run/'phases.log').read_text().splitlines(),'evidenceRoot':str(root) if root else None,'buildNotes':['Official build-provider-pack.mjs with normal lifecycle scripts; pinned provider runtime hydration and verification remain enabled.','Full runner build:typescript including checks, verified provider entrypoints and pinned Copilot installation.','Post-build pack metadata hardened with chmod -R go-w (content/digests unchanged); no executable write-authority relaxation.','Plugin SDK/shared and full server tsc rebuilt. Full server E2E executes exact-SHA source through Vitest.','Fixture finish summary/evidence aligned to ordinary final-message fallback; no product behavior patched.']}
if root:
 if (root/'runs.json').exists():
  runs=json.loads((root/'runs.json').read_text())
  receipt['failedRuns']=[{k:row.get(k) for k in ['id','status','errorCode','error']} for row in runs if row['status'] in ['failed','timed_out']]
 failures=[]
 for event_file in root.glob('events-*.json'):
  for event in json.loads(event_file.read_text()):
   text=json.dumps(event)
   if any(code in text for code in ['pi_rpc_transport_failed','durable_pending_tool_calls','semantic_tool.result command failed']):failures.append({'eventFile':str(event_file),'event':event})
 if failures:
  p=run/'failure-events.json';p.write_text(json.dumps(failures,indent=2)+'\n');receipt['failureEvents']=str(p)
 for name in ['proof.json','native-pi-home-load-proof.final.json','finish-state-after-finish.json','finish-state-after-warm-1.json','finish-state-after-warm-2.json']:
  p=root/name
  if p.exists():receipt[name]=str(p)
(run/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('RECEIPT',run/'receipt.json')
PY
git -C "$wt" status --short > "$run/source-status-after.txt"
exit "$code"
