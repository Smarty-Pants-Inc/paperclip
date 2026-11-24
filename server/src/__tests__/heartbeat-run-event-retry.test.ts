import { describe, expect, it, vi } from "vitest";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent, appendHeartbeatRunEventBatch } from "../services/heartbeat-run-events.js";

// unit test agreed: seam 0310 explicitly requests injected SQLSTATE failures; no live-org writes.
const input = { companyId: "company", agentId: "agent", runId: "run", eventType: "tool.output" };
const raw = { id: 1, company_id: "company", agent_id: "agent", run_id: "run", seq: 1,
  event_type: "tool.output", created_at: "2026-11-24T00:00:00.000Z" };
const failure = (code: string) => Object.assign(new Error("database failure"), { code });

describe("run event transaction retries", () => {
  it.each(["40P01", "40001"])("retries a wrapped %s at the whole native append transaction boundary", async code => {
    const error = new Error("Failed query: with existing ...", { cause: failure(code) });
    const committed: unknown[] = [];
    let attempts = 0;
    const transaction = vi.fn(async (action: (tx: Db) => Promise<unknown>) => {
      const attempt = ++attempts;
      const execute = vi.fn()
        .mockResolvedValueOnce([{ company_id: "company", agent_id: "agent", source_cursor: 0 }])
        .mockImplementationOnce(async () => {
          if (attempt === 1) throw error;
          return [{ ...raw, appended: true, source_seq: 1 }];
        });
      const tx = Object.assign(Object.create(PgTransaction.prototype), { execute });
      const result = await action(tx);
      committed.push(result);
      return result;
    });
    const receipt = await appendHeartbeatRunEvent({ transaction } as unknown as Db, { ...input,
      nativeSource: { sourceInstanceId: "source", sourceEventId: "event", sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: { text: "hello" } } });
    expect(receipt).toMatchObject({ disposition: "committed", row: { id: 1, seq: 1, sourceSeq: 1 } });
    expect(committed).toEqual([receipt]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retries an autocommit append (batch=%s) without duplicating the event", async batch => {
    const committed: unknown[] = [];
    const execute = vi.fn().mockRejectedValueOnce(failure("40P01")).mockImplementationOnce(async () => {
      committed.push(raw);
      return [raw];
    });
    const db = { execute } as unknown as Db;
    const receipts = batch ? await appendHeartbeatRunEventBatch(db, [input]) : [await appendHeartbeatRunEvent(db, input)];
    expect(receipts).toMatchObject([{ disposition: "committed", row: { id: 1, seq: 1 } }]);
    expect(committed).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["23503", "55P03"])("throws non-retryable %s unchanged, including cyclic causes", async code => {
    const error = Object.assign(failure(code), { cause: undefined as unknown });
    error.cause = error;
    const execute = vi.fn().mockRejectedValue(error);
    await expect(appendHeartbeatRunEvent({ execute } as unknown as Db, input)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stops after three retries and throws the last error", async () => {
    const error = failure("40P01");
    const execute = vi.fn().mockRejectedValue(error);
    await expect(appendHeartbeatRunEvent({ execute } as unknown as Db, input)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not retry inside a caller-owned transaction", async () => {
    const error = failure("40P01");
    const execute = vi.fn().mockRejectedValue(error);
    const tx = Object.assign(Object.create(PgTransaction.prototype), { execute }) as Db;
    await expect(appendHeartbeatRunEvent(tx, input)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
