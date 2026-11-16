// RFL judge probe 08:31Z (#20825 check 4: what run-level recovery does with B's failure), copied from
// /srv/scratch/paul/tasks/direct/rfl-loopfix-judge/artifacts/judge-probe-20825-classify.test.ts.
// Change from the probe: "B edge (head)" now asserts the RED (never a permanent
// terminal_failure); every other case keeps the probe's report-only assertion.
import { appendFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";

const report = (value: unknown) => appendFileSync(process.env.JUDGE_OUT ?? "/dev/null", `${JSON.stringify(value)}\n`);

// The codex session's notification pump turns the transport failure into
// failProtocol("notification_transport_failed", "Notification transport failed closed: <message>");
// the next turn start then throws NativeProviderTerminalFailure(protocolFailureCode, false, protocolFailureMessage)
// (codex-session-notifications.ts:80-91,101-105; codex-session-state.ts:522-550; codex-harness-session.ts:244-245).
const cases = [
  ["B edge (head)", new NativeProviderTerminalFailure("notification_transport_failed", false,
    "Notification transport failed closed: native_runner_idle_warm_owner_exited: lifecycle=unreported")],
  ["A named (head)", new NativeProviderTerminalFailure("notification_transport_failed", false,
    "Notification transport failed closed: native_runner_replacement_exited_before_authentication: lifecycle=recoverable_failure recoverableFailure=connection_refused")],
  ["lease stand-down (head)", new NativeProviderTerminalFailure("notification_transport_failed", false,
    "Notification transport failed closed: native_runner_lease_expired_requires_bootstrap: lifecycle=recoverable_failure recoverableFailure=lease_expired_requires_bootstrap")],
  ["base: runner restore failed", new NativeProviderTerminalFailure("notification_transport_failed", false,
    "Notification transport failed closed: native_runner_process_exited: runnerd exited 3 times within 60000ms of being restored")],
  ["base: grace exceeded", new NativeProviderTerminalFailure("notification_transport_failed", false,
    "Notification transport failed closed: transport_reconnect_grace_exceeded: runner process recovery exceeded 420000ms")],
  ["plain B error", new Error("native_runner_idle_warm_owner_exited: lifecycle=unreported")],
] as const;

it.each(cases)("RFL judge probe 08:31Z: classifies %s", (label, error) => {
  const code = nativeSessionFailureSourceCode(error);
  const disposition = nativeSessionFailureDisposition(1, new Date("2026-11-16T00:00:00Z"), code);
  report({ label, sourceFailureCode: code, phase: disposition.phase, failureCode: disposition.failureCode });
  expect(code).toBeTypeOf("string");
  if (label === "B edge (head)") expect(disposition.phase).not.toBe("terminal_failure");
});
