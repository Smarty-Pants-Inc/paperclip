#!/usr/bin/env bash
umask 0022
set -euo pipefail
# Usage: build-pi-e2e-home-fixture.sh NEW_OUTPUT_DIRECTORY
# Network: public npm registry only. Never sources auth/config or a real Pi home.
exec python3 - "$(cd -- "$(dirname -- "$0")/.." && pwd)" "${1:?new fixture output directory required}" <<'PYTHON'
import base64, hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile, urllib.request
os.umask(0o022)
repo = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=False)
locks = repo / "server/src/__tests__/fixtures/pi-home"
packages = root / "pi-packages"
packages.mkdir()
# The tarball and every transitive dependency are integrity-pinned. No private
# extensions, settings, models, credentials or sandbox snapshots are copied.
url = "https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.88.0.tgz"
integrity = "Hc7GT36HTU1IsT/MPQbxnqmA90G1tfWJMFrxZ6ISURadGaIx7uad/qzkwL4epgBYRUMB7KOB9r+8k8YhXKP1lw=="
with urllib.request.urlopen(url, timeout=60) as response:
    data = response.read()
assert base64.b64encode(hashlib.sha512(data).digest()).decode() == integrity, "pi-subagents tarball integrity mismatch"
archive = root / "pi-subagents-0.88.0.tgz"
archive.write_bytes(data)
with tarfile.open(archive) as tar:
    tar.extractall(packages, filter="data")
(packages / "package").rename(packages / "pi-subagents")
archive.unlink()
for name in ["pi-subagents", "langfuse-pi"]:
    dest = packages / name
    dest.mkdir(exist_ok=True)
    for source in (locks / name).iterdir():
        shutil.copyfile(source, dest / source.name)
    subprocess.run(["npm", "ci", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], cwd=dest, check=True)
agent = root / "agent"
agent.mkdir()
settings = {"packages": [str(packages / name) for name in ["pi-subagents", "langfuse-pi"]],
            "subagents": {"defaultSubagentOnlyExtensions": [str(packages / "langfuse-pi")]}}
(agent / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
(root / "README.md").write_text("Public-only native Pi E2E home. Built from pi-subagents@0.88.0 and @langfuse/pi-observability-plugin@0.1.2 plus integrity-pinned public npm dependencies. Private tool-cap/redact-secrets is intentionally absent; its large-output persistence leg is skipped. No user home, auth, models, client data or private source is included.\n")
lines = []
for path in sorted(root.rglob("*")):
    if path.is_file():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(root)}\n")
(root / "SHA256SUMS").write_text("".join(lines))
print(root)
PYTHON
