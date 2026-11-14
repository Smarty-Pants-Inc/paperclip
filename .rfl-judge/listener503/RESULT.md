# Abandoned-upgrade flood regression result

Base: `8592a129f67ceb417463ca04433e838ed1cf813c` (`cl/runnerd-listener-m1.2`).

## Regression coverage

Added `server_abandoned_upgrade_flood_before_legitimate_waiter` and `server_abandoned_upgrade_flood_after_legitimate_waiter` in `packages/paperclip-runner/runner/crates/runner-core/src/durable/tests/listener_abandoned_flood.rs:204-214`; each scenario runs three trials. The test keeps controller A mutually authenticated and live, sends 15 complete valid HTTP WebSocket-upgrade requests and closes those TCP clients while they wait, then confirms legitimate B is admitted and completes actual PRP authentication. It checks that no waiter is published while A remains live, A can still exchange authenticated frames, B is the admitted peer, no second controller is available, and B is admitted in under 2 seconds. The module is included at `packages/paperclip-runner/runner/crates/runner-core/src/durable/transport.rs:1750`.

No change to `listener.rs` was needed; the existing candidate fix passes the new coverage.

## Evidence

- **RED on `6b7ffb02` listener.rs:** both tests failed, 0/2 passed. In both orderings B's genuine PRP authentication failed with `Broken pipe`; see `red-6b7ffb02.log`.
- **GREEN on `8592a129`:** 2/2 tests passed, covering six total trials. B authenticated in 41–43 ms after A released admission; see `green-regression.log`.
- Transport suite: **48 passed, 0 failed** (`transport-suite.log`).
- Durable suite: **151 passed, 0 failed** (`durable-suite.log`).
- `paperclip-runnerd` suite: **10 passed, 0 failed** (`runnerd-suite.log`).
- F2 `disconnected_waiter_does_not_claim_released_admission`: **1 passed, 0 failed** (`f2-regression.log`).
- `cargo fmt --all -- --check`: **PASS**; `cargo check --offline --locked --workspace`: **PASS** (`rust-check.log`). This is the requested cargo-check-plus-rustfmt alternative to `pnpm typecheck:rust`.
- F1 judge cases remain out of scope and were not run.

All Rust checks used Rust 1.97.1 with an isolated `CARGO_TARGET_DIR`. No push, GitHub write, production access, or credential use.
