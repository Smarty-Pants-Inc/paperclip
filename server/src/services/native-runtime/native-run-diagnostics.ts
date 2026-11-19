import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { nativeRunDiagnostics, type Db } from "@paperclipai/db";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";

type Binding = { companyId: string; issueId: string; runId: string };

/** Capture the SAME already-sanitized event sent to the run log. The INSERT
 * takes only the run FK's KEY SHARE, compatible with event allocation's NO KEY
 * UPDATE. It neither reads nor updates next_event_seq. A custody failure is
 * propagated: callers cannot admit work while the only copy is a Promise. */
export function nativeRunDiagnosticCustody(db: Db, binding: Binding) {
  return async (events: readonly AdapterRuntimeEvent[]): Promise<() => Promise<void>> => {
    if (!events.length) return async () => {};
    const rows = events.map(event => ({ ...binding, id: randomUUID(), event: { ...event } }));
    await db.insert(nativeRunDiagnostics).values(rows);
    return async () => {
      await db.delete(nativeRunDiagnostics).where(and(eq(nativeRunDiagnostics.companyId, binding.companyId),
        eq(nativeRunDiagnostics.runId, binding.runId), inArray(nativeRunDiagnostics.id, rows.map(row => row.id))));
    };
  };
}

/** Recovery/finalization cannot know whether a killed writer committed its
 * sink just before dying. Retain the exact receipt and explicitly account for
 * unconfirmed delivery, rather than replaying a possibly duplicated span or
 * claiming it was delivered. These rows survive until the run is deleted. */
export async function accountUnconfirmedNativeRunDiagnostics(db: Db, binding: Pick<Binding, "companyId" | "runId">): Promise<void> {
  await db.update(nativeRunDiagnostics).set({ lossReason: "delivery_unconfirmed_at_finalization" }).where(and(
    eq(nativeRunDiagnostics.companyId, binding.companyId), eq(nativeRunDiagnostics.runId, binding.runId), isNull(nativeRunDiagnostics.lossReason)));
}
