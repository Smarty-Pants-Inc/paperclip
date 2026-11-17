import { createDb } from "@paperclipai/db";
import {
  archivedCopyStateKeys, readBackQuarantineRecheck, readQuarantinedCopyFacts, repairStopOnlyQuarantinedCopies,
} from "../src/services/native-runtime/quarantined-stop-copies.js";
import { isCloudManagedInstance } from "../src/services/cloud-instance.js";
import { cloudRuntimeConfigService } from "../src/services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../src/services/cloud-runtime-config-snapshot.js";

// Same shape as migrate-run-evidence.ts: dry-run by default, --apply to write.
// Run on the server host with the server's own environment (PAPERCLIP_HOME or
// PAPERCLIP_RUNNER_STATE_DIR), so the runnerd state base is the server's.
if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the intended instance");
const args = process.argv.slice(2);
const booleans = new Set(["--apply", "--read-back"]);
const flags = new Set([...booleans, "--company"]);
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (!flags.has(flag)) throw new Error(`Unknown repair option: ${flag}`);
  if (!booleans.has(flag) && (!args[++index] || args[index]!.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}`);
  }
}
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const db = createDb(process.env.DATABASE_URL);
try {
  if (isCloudManagedInstance()) {
    const stored = await cloudRuntimeConfigService(db).inspectStored();
    if (!stored) throw new Error("cloud_runtime_configuration_missing");
    setCloudRuntimeConfigSnapshot(stored);
  }
  if (args.includes("--read-back")) {
    // Read-only: every state key that still has quarantined copies, and what the
    // next inspection's quarantine recheck returns for its session root.
    const keys = [...new Set((await readQuarantinedCopyFacts(db)).flatMap(item =>
      item.copy && (!value("--company") || item.run?.companyId === value("--company")) ? [item.copy.stateKey] : [])), ...archivedCopyStateKeys()])];
    const recheck = Object.fromEntries(keys.map(key => [key, readBackQuarantineRecheck(key)]));
    console.log(JSON.stringify({ recheck }, null, 2));
  } else {
    const result = await repairStopOnlyQuarantinedCopies(db, { apply: args.includes("--apply"), companyId: value("--company") });
    console.log(JSON.stringify(result, null, 2));
    if (result.blocked > 0) process.exitCode = 1;
  }
} finally {
  await db.$client.end();
}
