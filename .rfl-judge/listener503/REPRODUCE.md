# Reproduce this independent listener judgment

Reviewed candidate: `6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f`.
Required base: deployed M1 `c1dea0db254645755e7a3c818d0f6e0076aeb34e` (not C8).
Host used: ryzen3; Node 24.19.0, pnpm 9.15.4 via Corepack, Rust/Cargo 1.97.1.
No application, production service, provider account, credentials, or test org is required. The checks exercise the actual Rust listener and PRP mutual-authentication/encryption on loopback TCP.

## Source and isolation

Create worktrees under a fresh scratch directory. Public Git reads only:

```sh
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git -c credential.helper= clone --filter=blob:none https://github.com/Smarty-Pants-Inc/paperclip pc
cd pc
git -c credential.helper= fetch origin cl/runnerd-listener-m1.1
git checkout --detach 6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f
git worktree add --detach ../base c1dea0db254645755e7a3c818d0f6e0076aeb34e
git worktree add --detach ../judge 6b7ffb02b8d32a6a1fb4c9c3465738dbf3fb8c4f
```

Use a **different `CARGO_TARGET_DIR` for every worktree**. If seeding dependencies from an existing target, run `cargo +1.97.1 clean --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core` in the new target before building. Root-crate artifacts from another checkout are unsafe: its build script records absolute source paths. See `doc/DEVELOPING.md:1228–1244`.

The first cross-worktree attempt was rejected after exposing this cache hazard. Its outputs are kept in `superseded-cache-attempt/`. The subsequent phase explicitly cleaned the Runner crate at each worktree transition. Final independent acceptance was repeated in separate `target-base` / `target-judge` directories with root-crate cleans, as the `private-*.log` records show. Do not use the superseded head result as evidence.

## Unmodified candidate suites and native typecheck

From `pc`, set a private target and run:

```sh
export CARGO_TARGET_DIR="$PWD/../target-head" CARGO_BUILD_JOBS=6 RUSTUP_TOOLCHAIN=1.97.1
corepack pnpm exec cargo test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable::transport:: -- --nocapture --test-threads=1
corepack pnpm exec cargo test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable:: -- --nocapture --test-threads=1
corepack pnpm exec cargo test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --bin paperclip-runnerd -- --nocapture --test-threads=1
corepack pnpm exec cargo check --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml --workspace
corepack pnpm --dir packages/paperclip-runner run typecheck:rust
```

The last script invokes `pnpm` recursively. This host needed a task-local `pnpm` shell shim that simply executes `corepack pnpm "$@"`, placed on PATH. It ran the profile checks, whole Rust workspace fmt check, and workspace Cargo check successfully. Both candidate and pristine M1 passed. No TypeScript file changes are present, so the monorepo TypeScript suites/typecheck were not run.

Offline Cargo uses this host's existing dependency cache. On a new machine, obtain the public locked dependencies first. Do not reuse a compiled Runner artifact from a different source tree.

## Independent harnesses

Set `ARTIFACTS` to the directory containing this file. The patches add tests only, not implementation changes. Both patches passed `git apply --check` on the corresponding clean revision. `judge_listener.rs` is byte-identical on head and base (see `harness-identity.txt`).

```sh
# From base:
git apply "$ARTIFACTS/judge-base-harness.patch"
export CARGO_TARGET_DIR="$PWD/../target-base"
corepack pnpm exec cargo +1.97.1 test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable::transport::tests::independent_reconnect_ -- --nocapture --test-threads=1
# Expected RED: 0/2, HTTP 503, while A remains live for 300 ms / 2 s.
corepack pnpm exec cargo +1.97.1 test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable::transport::tests::listener_waiter_ -- --nocapture --test-threads=1
# Candidate's four new tests on the parent: 0/4.
corepack pnpm exec cargo +1.97.1 test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable::transport::tests::independent_disconnected_ -- --nocapture --test-threads=1
# PASS on base: a refused/disconnected B is not promoted later.

# From judge:
git apply "$ARTIFACTS/judge-head-harness.patch"
export CARGO_TARGET_DIR="$PWD/../target-judge"
corepack pnpm exec cargo +1.97.1 test --offline --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --lib durable::transport::tests::independent_ -- --nocapture --test-threads=1
```

The full final head harness contains nine tests. Eight were run together (`private-head-independent.log`: six pass, two fail); the subsequently added literal pre-filled-waiter case ran separately (`prefilled-waiters.log`: fails all three internal trials). Its addition did not change any other test or implementation.

- GREEN: reconnect after 300 ms / 2 s; 100 A/B/C admission races; real authenticated A survives while B receives 503 at 15 seconds; shutdown of 15 waiters; rotation of 15 waiters, 32 stale-path refusals, then admission on the new path.
- RED on head: unauthenticated arrivals evict B while A remains live; disconnected B is later published into admission; pre-filled unauthenticated waiters starve B even with real authentication attempts after A releases.

`run-check.sh` captures host, UTC start/end, revision, exact command and exit code. `checks-phase2.sh` preserves the earlier root-cleaned sequential run; the final private-target command lines are in the `private-*.log` files. The logs preserve expected test failures and compiler warnings. Existing deadline-edge tests also print helper-thread failures for deliberately losing handshakes; their enclosing assertions pass. No failed/interrupted attempt is counted as a pass.

## Boundaries

No production Boat run, image release build, deployment, provider turn, GitHub write, or cross-platform qualification was performed. This is a source-and-real-transport judgment of the bounded item, not a claim that a production hire or every C9 incident is fixed.
