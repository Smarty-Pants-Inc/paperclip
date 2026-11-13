import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issueComments } from "@paperclipai/db";
import { expect, it } from "vitest";
import { assertNativePiHomeProof, readNativePiHomeProof } from "./helpers/native-pi-home-load-proof.js";
import { piDescendant, readPiSessionFile, stopWarmProof, type NativePiStopFixture } from "./native-pi-stop.fixture.js";

// Keep reason: recorded production Stop failures/data safety. Only the provider
// is scripted. HTTP admission, DB, runnerd, proxy, Pi 1.5.2, native bash and
// pi-subagents are real. C6 remains the unmodified REG-03 journey in stop-warm.
// This qualifies local execution, NOT sandbox allocation/remote containment.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const cells = ["C1", "C2", "C3", "C4", "C5", "C7"] as const;
type Cell = typeof cells[number];
type Run = typeof heartbeatRuns.$inferSelect;

function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; }
  catch { return false; }
}
function sleepChild(bashPid: number): number | null {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1]!.split(" ");
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (Number(stat[1]) === bashPid && /(?:^|\/)sleep$/.test(command[0]!) && command[1] === "120") return Number(entry);
    } catch { /* process ended during observation */ }
  }
  return null;
}
function sse(res: ServerResponse, id: number, text: string, tool?: { name: string; input: unknown }, slow = false) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit("message_start", { message: { id: `matrix-${id}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
  emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  const finish = () => {
    emit("content_block_stop", { index: 0 });
    if (tool) {
      emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: `matrix-tool-${id}`, name: tool.name, input: {} } });
      emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
      emit("content_block_stop", { index: 1 });
    }
    emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    emit("message_stop", {}); res.end();
  };
  if (!slow) { finish(); return; }
  // The real provider stream is the event source. A bounded 120s scripted
  // stream is deliberately interrupted by Stop; its timer is owned by res.
  let chunks = 0;
  const timer = setInterval(() => {
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: ` STREAM_CHUNK_${++chunks}` } });
    if (chunks === 600) { clearInterval(timer); finish(); }
  }, 200);
  res.once("close", () => clearInterval(timer));
}

async function matrixProof(cell: Cell) {
  const fact = `PI_ONLY_MATRIX_${randomUUID()}`;
  const childTask = `SMX_CHILD_${randomUUID()}`;
  const requests: Array<Record<string, any>> = [];
  const observations: Array<Record<string, unknown>> = [];
  let phase: "plant" | "plant-end" | "action" | "child" | "recall" = "plant";
  let cycle = 1, recallCount = 0, streaming = false, streamClosed = false;
  let failCheckpoint = false, checkpointFailures = 0;
  let fixture: NativePiStopFixture | undefined;
  let result: Record<string, unknown> = { cell, result: "RED", recall: false };
  try {
    await stopWarmProof(1, false, {
      allowFailedRuns: cell === "C7",
      cleanup: () => { failCheckpoint = false; },
      ...(cell === "C7" ? { checkpointFailure: () => {
        if (!failCheckpoint) return undefined;
        checkpointFailures++;
        return Object.assign(new Error("Stop-matrix injected controller checkpoint write failure"), { code: "EIO" });
      } } : {}),
      model: (parsed, res, { root, stage }) => {
        const messages = parsed.messages ?? [];
        const remembersFact = messages.some((message: any) => message.role === "assistant" && JSON.stringify(message.content).includes(fact));
        const row = { phase, path: "/v1/messages", model: parsed.model, remembersFact, lastMessage: messages.at(-1), messages,
          tools: (parsed.tools ?? []).map((tool: any) => tool.name) };
        requests.push(row);
        if (phase === "plant") {
          phase = "plant-end";
          // Fact exists only in the model's private assistant/tool-use message.
          // The published final reply does not disclose it to Paperclip.
          sse(res, requests.length, fact, { name: "bash", input: { command: "printf MATRIX_PLANT_TOOL_OK" } });
        } else if (phase === "plant-end") {
          sse(res, requests.length, "MATRIX_TURN_ONE_READY");
        } else if (phase === "action" && cell === "C3") {
          streaming = true;
          res.once("close", () => { streamClosed = true; stage("slow provider stream closed"); });
          sse(res, requests.length, "MATRIX_SLOW_STREAM", undefined, true);
        } else if (phase === "action" && cell === "C4") {
          phase = "child";
          sse(res, requests.length, "Delegating the bounded loopback child.", { name: "subagent", input: {
            agent: "delegate", task: childTask, model: "paperclip/faux", async: false,
            options: { timeoutMs: 180_000, context: "fresh" },
          } });
        } else if (phase === "action" || phase === "child") {
          const kind = phase === "child" ? "child" : "parent";
          sse(res, requests.length, "Working until Stop.", { name: "bash", input: {
            command: `echo $$ > ${join(root, `${kind}-${cycle}.pid`)}; sleep 120; echo BAD > ${join(root, `after-${kind}-${cycle}.txt`)}`,
          } });
        } else {
          recallCount++;
          const reply = `MATRIX_RECALL_${recallCount} ${remembersFact ? fact : "HISTORY_LOST"}`;
          sse(res, requests.length, reply, cell === "C5" && cycle === 1 ? { name: "bash", input: {
            command: `echo $$ > ${join(root, "parent-2.pid")}; sleep 120; echo BAD > ${join(root, "after-parent-2.txt")}`,
          } } : undefined);
        }
      },
      exercise: async f => {
        fixture = f;
        const { root, db, api, companyId, agentId, bundles, waitFor, stage, nativeHomeProof } = f;
        result = { ...result, root, companyId, agentId };
        const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
        const comments = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        const { heartbeatService } = await import("../services/heartbeat.js");
        const heartbeat = heartbeatService(db);
        const drain = (run: Run) => heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 });
        const settled = async (runId: string) => waitFor(`run ${runId} settled`, async () => {
          const row = (await runs()).find(run => run.id === runId);
          return row && ["succeeded", "failed", "timed_out", "cancelled"].includes(row.status) ? row : null;
        });
        const identity = () => {
          for (const bundle of [...bundles].reverse()) {
            const runnerPid = bundle.transport.processInfo?.()?.pid;
            const piPid = runnerPid ? piDescendant(runnerPid) : null;
            if (!runnerPid || !piPid) continue;
            const file = readPiSessionFile(piPid);
            const bytes = readFileSync(file, "utf8");
            const header = JSON.parse(bytes.split("\n")[0]!);
            return { runnerPid, piPid, file, headerUuid: header.id, header };
          }
          return null;
        };
        const issue = await api("POST", `/companies/${companyId}/issues`, { title: `Stop matrix ${cell}`, description: "Keep your private memory and answer ordinary follow-ups.", status: "todo", assigneeAgentId: agentId }, 201);
        result.issueId = issue.id;
        const first = await waitFor("turn 1 completed", async () => (await runs()).find(run => run.status === "succeeded") ?? null);
        await drain(first);
        const original = await waitFor("turn 1 Pi JSONL identity", async () => identity());
        expect(original.headerUuid, "real Pi JSONL header UUID").toBeTruthy();
        expect(readFileSync(original.file, "utf8")).toContain(fact);
        expect((await comments(issue.id)).some(comment => comment.body.includes(fact)), "Pi-only fact was not published to the thread").toBe(false);
        expect(requests[0]!.tools).toContain("bash");
        expect(requests[0]!.tools).toContain("subagent");
        expect(requests[0]!.tools).toContain("paperclip_finish");
        await assertNativePiHomeProof(nativeHomeProof, original.piPid);
        await writeFile(join(root, "matrix-turn1.jsonl"), readFileSync(original.file));
        result = { ...result, original, normalizedSessionId: first.nativeSessionId, turn1RunId: first.id };
        stage(`${cell} turn 1 private fact planted`, { ...original, runId: first.id, nativeSessionId: first.nativeSessionId });
        const seen = new Set([first.id]);
        const newRun = async () => waitFor("plain message admitted as a new run", async () => (await runs()).find(run => !seen.has(run.id)) ?? null);
        let final = first;
        let secondStopRun: Run | undefined;
        for (cycle = 1; cycle <= (cell === "C5" ? 2 : 1); cycle++) {
          let actionRun = secondStopRun ?? first;
          let bashPid: number | undefined, sleepPid: number | undefined;
          if (cell !== "C1") {
            const beforeUpdates = readNativePiHomeProof(nativeHomeProof.receiptPath)?.rpcRecordCounts?.message_update ?? 0;
            if (!secondStopRun) {
              phase = "action";
              await api("POST", `/issues/${issue.id}/comments`, { body: cell === "C4" ? "Use a delegate child for this bounded task; keep it working until I stop you." : "Keep working until I press Stop." }, 201);
              actionRun = await newRun(); seen.add(actionRun.id);
            }
            if (cell === "C3") {
              await waitFor("real slow stream reached native Pi", async () => streaming && (readNativePiHomeProof(nativeHomeProof.receiptPath)?.rpcRecordCounts?.message_update ?? 0) > beforeUpdates ? true : null);
            } else {
              bashPid = await waitFor("real native sleep-120 bash started", async () => {
                try { const pid = Number(readFileSync(join(root, `${cell === "C4" ? "child" : "parent"}-${cycle}.pid`), "utf8").trim()); return pid > 0 ? pid : null; }
                catch { return null; }
              });
              sleepPid = await waitFor("real sleep 120 process child", async () => sleepChild(bashPid!));
              if (cell === "C4") {
                expect(requests.some(request => request.phase === "child"), "the real subagent made its own model request").toBe(true);
                expect(readNativePiHomeProof(nativeHomeProof.receiptPath)?.toolExecutions).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolName: "subagent" }));
              }
            }
          }
          const beforeStop = identity();
          expect(beforeStop).toMatchObject(original);
          stage(`${cell} Stop action`, { cycle, runId: actionRun.id, status: actionRun.status, ...beforeStop, bashPid, sleepPid,
            idleAction: cell === "C1" ? "run-level board cancel on the completed idle-warm run (composer Stop is live-execution-only)" : undefined });
          const started = Date.now();
          const response = await api("POST", `/heartbeat-runs/${actionRun.id}/cancel`, {}, 200, 5000);
          // REG-30 uses the existing controller persistence seam. Fail real
          // checkpoint writes AFTER the actual Stop HTTP acknowledgment, not
          // a fabricated transport error, event, status or recovery record.
          if (cell === "C7") failCheckpoint = true;
          const stopped = await settled(actionRun.id);
          expect(stopped.status).toBe(cell === "C1" ? "succeeded" : "cancelled");
          expect(Date.now() - started, "Stop route + DB status under 5 seconds").toBeLessThan(5000);
          if (sleepPid && bashPid) await waitFor("stopped bash/sleep exited", async () => alive(bashPid!) || alive(sleepPid!) ? null : true, Math.max(1, 5000 - (Date.now() - started)));
          if (cell === "C3") await waitFor("provider stream aborted, not merely hidden", async () => streamClosed ? true : null, 5000);
          await drain(stopped);
          const afterStop = identity();
          observations.push({ cycle, actionRunId: actionRun.id, stoppedStatus: stopped.status, responseStatus: response.status,
            cancelMs: Date.now() - started, beforeStop, afterStop, bashPid, sleepPid, streamClosed, checkpointFailures });
          // Healthy clean Stop must keep its resident. The failure cell may
          // instead refuse safely; its notice and next-message contract below
          // still cannot lose the original conversation.
          if (cell !== "C7") expect(afterStop).toMatchObject(original);
          expect(existsSync(join(root, `after-${cell === "C4" ? "child" : "parent"}-${cycle}.txt`))).toBe(false);
          await writeFile(join(root, `matrix-after-stop-${cycle}.jsonl`), readFileSync(original.file));
          phase = "recall";
          const beforeComments = await comments(issue.id);
          await api("POST", `/issues/${issue.id}/comments`, { body: cell === "C5" && cycle === 1
            ? "Recall your private fact from our first turn, then keep working until I stop you again."
            : "What private fact did you keep from our first turn? No tool is needed." }, 201);
          let next = await newRun(); seen.add(next.id);
          if (cell === "C5" && cycle === 1) {
            await waitFor("plain first follow-up recalled and entered second tool", async () => existsSync(join(root, "parent-2.pid")) ? true : null);
            const request = requests.filter(request => request.phase === "recall").at(-1);
            expect(request?.remembersFact).toBe(true);
            expect(JSON.stringify(request?.lastMessage)).not.toContain(fact);
            expect(readFileSync(original.file, "utf8")).toContain(`MATRIX_RECALL_1 ${fact}`);
            expect((await runs()).find(run => run.id === next.id)?.nativeSessionId).toBe(first.nativeSessionId);
            expect(identity()).toMatchObject(original);
            secondStopRun = next;
            observations.push({ cycle, firstPlainFollowupRunId: next.id, recalledInNativeAssistantMessage: true, secondStopImmediatelyFollowsThisMessage: true });
            continue;
          }
          final = await settled(next.id);
          await drain(final);
          if (cell === "C7" && final.status !== "succeeded") {
            // Unsafe auto-continue gets exactly one visible explanation, and
            // the next PLAIN message must work without Retry/reset/DB edits.
            failCheckpoint = false;
            const notices = (await comments(issue.id)).filter(comment => !beforeComments.some(before => before.id === comment.id)
              && /automatic recovery|recovery blocked|cannot.*continu|could not.*continu|reconciliation/i.test(comment.body));
            observations.push({ refusedRun: final, notices });
            expect(checkpointFailures, "real checkpoint callback actually failed").toBeGreaterThan(0);
            expect(notices, "exactly one visible unsafe-continuation notice").toHaveLength(1);
            await api("POST", `/issues/${issue.id}/comments`, { body: "Please continue our conversation and recall your earlier private fact." }, 201);
            next = await newRun(); seen.add(next.id);
            final = await settled(next.id); await drain(final);
          }
          const current = identity();
          const replies = (await comments(issue.id)).filter(comment => comment.authorAgentId === agentId && comment.body.includes(`MATRIX_RECALL_${recallCount}`));
          const recallRequest = requests.filter(request => request.phase === "recall").at(-1);
          const continuity = { cycle, runId: final.id, status: final.status, errorCode: final.errorCode, current,
            samePiPid: current?.piPid === original.piPid, sameNormalizedSessionId: final.nativeSessionId === first.nativeSessionId,
            sameSessionFile: current?.file === original.file, sameHeaderUuid: current?.headerUuid === original.headerUuid,
            recalled: recallRequest?.remembersFact === true && replies.some(reply => reply.body.includes(fact)), replies: replies.map(reply => reply.body) };
          observations.push(continuity); result = { ...result, ...continuity };
          stage(`${cell} plain follow-up observation`, continuity);
          expect(final.status).toBe("succeeded");
          expect(current).not.toBeNull();
          expect(final.nativeSessionId, "same normalizedSessionId").toBe(first.nativeSessionId);
          expect(current!.file, "original Pi JSONL file, not a replacement conversation").toBe(original.file);
          expect(current!.headerUuid, "unchanged Pi session header UUID").toBe(original.headerUuid);
          if (cell !== "C7") expect(current!.piPid, "same healthy resident Pi PID").toBe(original.piPid);
          expect(recallRequest?.remembersFact, "Pi sends the original assistant-only fact in history").toBe(true);
          expect(JSON.stringify(recallRequest?.lastMessage), "plain follow-up did not replay the private fact").not.toContain(fact);
          expect(replies.some(reply => reply.body.includes(fact)), "visible reply recalled the Pi-only fact").toBe(true);
          if (cell === "C1") {
            const intent = response.resultJson?.nativeCancellation;
            const dispatched = intent?.dispatchState === "acknowledged" && intent?.dispatched === true;
            observations.push({ idleStopAcknowledged: dispatched, nativeCancellation: intent ?? null });
            expect(dispatched, "idle Stop must actually dispatch; cancelling a succeeded historical run is a no-op, not idle-Stop coverage").toBe(true);
          }
          await writeFile(join(root, `matrix-after-recall-${cycle}.jsonl`), readFileSync(current!.file));
        }
        // Local production targets do not currently install controller DB
        // checkpoint persistence (native-session-executor.ts:11846-11847).
        // If this existing seam is not reached, report C7 RED/uninduced;
        // never manufacture a failed checkpoint or count a clean Stop green.
        if (cell === "C7") expect(checkpointFailures, "REG-30 fault was reached, not a clean-control pass").toBeGreaterThan(0);
        await assertNativePiHomeProof(nativeHomeProof, identity()!.piPid);
        result = { ...result, result: "GREEN", recall: true, finalRunId: final.id, checkpointFailures };
        stage("GREEN", result);
      },
    });
  } catch (error) {
    result = { ...result, result: "RED", failure: error instanceof Error ? error.stack : String(error), checkpointFailures };
    throw error;
  } finally {
    failCheckpoint = false;
    if (fixture) {
      // The shared fixture captures runs.json/events-*.json before DB shutdown.
      // Do not reopen that closed database from this outer result writer.
      await writeFile(join(fixture.root, `matrix-${cell}.json`), JSON.stringify({ ...result, observations, requests }, null, 2) + "\n");
      console.log(`[stop-matrix] ${cell} ${result.result} evidence=${fixture.root}`);
    }
  }
}

it.skipIf(!enabled).each(cells)("%s Stop matrix: real server, same Pi conversation, private-fact recall", cell => matrixProof(cell), 600_000);
