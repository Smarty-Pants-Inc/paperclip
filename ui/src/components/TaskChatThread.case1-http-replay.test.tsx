// @vitest-environment jsdom
// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21334
// Agreed boundary: mounted TaskChatThread + REAL transcript hooks, parsers and adapters;
// only HTTP is substituted. This is captured-record replay, NOT installed-screen proof.
import { writeFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TaskChatThread } from "./TaskChatThread";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { issuesApi } from "@/api/issues";
import { activityApi } from "@/api/activity";
import capture from "./__fixtures__/case1-empty-reply-http.json";

// Shell context only: no transcript hook, projection, adapter, turn or bubble is mocked.
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/case1", hash: "", search: "", key: "case1", state: null }),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const RUN = "475641c1-7327-4d88-98e9-6a38a1641546";
const BEFORE = "85fa6e2e-b6b9-4c18-a22d-6862b894f547";
const RECOVERY = "2357cdd2-8c06-42b0-83ee-792dbc7864f2";
const AFTER = "89fbb50e-c554-4e25-a4fe-21fd91bcfcf7";
const TURN = `[data-thread-anchor="${RUN}:turn"]`;
const IDENTITY = '[data-turn-position="identity"]';
const BODIES = '[data-testid="task-chat-turn-timeline"], [data-testid="task-chat-final-response"], [data-testid="task-chat-run-health-banner"]';
const chunk = "Status: " + "x".repeat(194); // 202 chars, one plain non-JSON line; real prose withheld.
const ts = "2026-11-19T19:50:12.238Z";
// Padding is redaction scaffolding only; preserves the captured page's total 327 bytes.
const logRecord = { ts, stream: "stdout", seq: 1, chunk, attemptId: "redacted-attempt".padEnd(39, "x") };
const logContent = JSON.stringify(logRecord) + "\n";
let host: HTMLDivElement;
let root: Root | null;
let client: QueryClient;
let requests: string[];
let unexpected: string[];
let targetExtraEvents: unknown[];
let releaseLog: (() => void) | null;
let logGate: Promise<void>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
function event(seq: number, eventType: string, payload: Record<string, unknown>) {
  return { id: seq, companyId: capture.companyId, runId: RUN, agentId: capture.agentId, seq,
    eventType, stream: "system", level: "info", color: null, message: null, createdAt: ts,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceEventId: `control-${seq}`, sourceSeq: seq,
      sourceInstanceId: "control-runner", sourceKind: "runner", runId: RUN, normalizedSessionId: "control-session",
      eventType, schemaVersion: 1, priority: 1, emittedAt: ts, payload } } };
}
async function http(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), "http://localhost");
  const path = url.pathname;
  requests.push(url.pathname + url.search);
  expect(init?.method ?? "GET").toBe("GET");
  if (path === `/api/issues/${capture.issueId}/comments`) return json([...capture.comments].reverse());
  if (path === `/api/issues/${capture.issueId}/runs`) return json([...capture.runs].reverse());
  const heartbeat = /^\/api\/heartbeat-runs\/([^/]+)\/(events|log)$/.exec(path);
  if (heartbeat) {
    const [, id, kind] = heartbeat;
    if (kind === "events" && url.searchParams.get("view") === "conversation") {
      return json(id === RUN ? targetExtraEvents : []);
    }
    if (kind === "log") {
      if (id === RUN) {
        await logGate;
        return json({ runId: RUN, store: "s3_segments", logRef: "redacted-case1-log", content: logContent });
      }
      // Neighbouring logs were not supplied. Do NOT invent their transcripts.
      return json({ error: "Neighbour log not part of this capture" }, 404);
    }
  }
  if (path.endsWith("/documents/plan")) return json({ error: "No plan in replay" }, 404);
  if (path.endsWith("/runner-goal")) return json({ agentId: null, goal: null, capability: { availability: "unavailable" } });
  if (path === "/api/auth/get-session") return json({ session: { id: "replay-session", userId: capture.userId },
    user: { id: capture.userId, email: null, name: "Paul (replay alias)", image: null }, sentryDsn: null });
  if (path === "/api/instance/settings/experimental") return json({ enableStreamlinedUi: true, enableCoordinatorWorkspace: false });
  if (path === "/api/instance/settings/general") return json({ censorUsernameInLogs: false });
  if (path === "/api/workspace-preferences/me") return json({ userId: capture.userId, agentReasoningDisplay: {} });
  if (path.endsWith("/tool-icons")) return json({ icons: [] });
  if (path.endsWith("/mcp-app-views")) return json([]);
  unexpected.push(path + url.search);
  return json({ error: "HTTP read outside replay" }, 404);
}
function newCache() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}
async function mount() {
  newCache();
  root = createRoot(host);
  // Real API clients cross HTTP first, preserving runId:null separately from createdByRunId.
  const [comments, runs] = await Promise.all([issuesApi.listComments(capture.issueId), activityApi.runsForIssue(capture.issueId)]);
  const agent = { id: capture.agentId, name: "Case 1 agent", status: "idle", adapterType: "paperclip_runner" } as Agent;
  await act(async () => root!.render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider>
    <CoordinatorPresentation value={false}><TaskChatThread
      issueId={capture.issueId} companyId={capture.companyId} currentUserId={capture.userId}
      agentMap={new Map([[agent.id, agent]])} userLabelMap={new Map([[capture.userId, "Paul (replay alias)"]])}
      comments={comments} linkedRuns={runs} liveRuns={[]} compactHistory={true}
      issueStatus="in_review" issueAssigneeAgentId={agent.id} showComposer={false} onAdd={async () => {}}
    /></CoordinatorPresentation>
  </TooltipProvider></ThemeProvider></QueryClientProvider>));
}
async function unmount() {
  await act(async () => { root?.unmount(); });
  root = null;
  client.clear();
}
async function hydrate() {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(requests).toContain(`/api/heartbeat-runs/${RUN}/log?offset=0&limitBytes=32000`);
  });
  await act(async () => { releaseLog?.(); await logGate; });
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
    expect(host.querySelector('[data-testid="task-chat-thread"] > [aria-busy="false"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task-chat-history-content"]')?.hasAttribute("inert")).toBe(false);
  });
  // Drain the real hook's parse/projection commits, not merely the fetch receipt.
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
}
function anchor(id: string) {
  const nodes = host.querySelectorAll(`[data-thread-anchor="${id}"]`);
  expect(nodes, `saved comment ${id} remains exactly once`).toHaveLength(1);
  return nodes[0]!;
}
function earlier(a: Element, b: Element) {
  expect(Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
}
function keepSavedConversation() {
  for (const comment of capture.comments.filter(c => c.authorType === "user" || c.authorType === "agent")) {
    expect(anchor(comment.id).textContent).toContain(comment.body);
  }
  earlier(anchor(BEFORE), anchor(RECOVERY));
  earlier(anchor(RECOVERY), anchor(AFTER));
}
function keepTransportBoundary() {
  expect(requests).toContain(`/api/heartbeat-runs/${RUN}/events?view=conversation&afterSeq=0&limit=1000`);
  expect(requests).toContain(`/api/heartbeat-runs/${RUN}/log?offset=0&limitBytes=32000`);
  expect(requests.filter(url => /\/events\?/.test(url) && !url.includes("view=conversation"))).toEqual([]);
  expect(requests.filter(url => url.includes(`/${RUN}/log`)).every(url => !url.includes("alignStartToRecord"))).toBe(true);
  expect(unexpected).toEqual([]);
}
function saveEvidence(label: string) {
  const turn = host.querySelector(TURN);
  const anchors = [...host.querySelectorAll("[data-thread-anchor]")].map(node => node.getAttribute("data-thread-anchor"));
  const observation = { label, identityOnly: Boolean(turn?.querySelector(IDENTITY)) && !turn?.querySelector(BODIES),
    turnText: turn?.textContent ?? null,
    timeline: Boolean(turn?.querySelector('[data-testid="task-chat-turn-timeline"]')),
    final: Boolean(turn?.querySelector('[data-testid="task-chat-final-response"]')),
    health: Boolean(turn?.querySelector('[data-testid="task-chat-run-health-banner"]')),
    chronologicalAnchors: anchors.filter(id => [BEFORE, `${RUN}:turn`, RECOVERY, AFTER].includes(id ?? "")),
    requests: [...requests], unexpected: [...unexpected] };
  console.info("CASE1_REPLAY", label, JSON.stringify({ identityOnly: observation.identityOnly,
    turnText: observation.turnText, timeline: observation.timeline, final: observation.final, health: observation.health,
    chronologicalAnchors: observation.chronologicalAnchors }));
  if (process.env.CASE1_EVIDENCE_DIR) {
    writeFileSync(`${process.env.CASE1_EVIDENCE_DIR}/${label}.html`, host.innerHTML);
    writeFileSync(`${process.env.CASE1_EVIDENCE_DIR}/${label}.json`, JSON.stringify(observation, null, 2) + "\n");
  }
}
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host);
  root = null; requests = []; unexpected = []; targetExtraEvents = [];
  logGate = new Promise(resolve => { releaseLog = resolve; });
  window.matchMedia = vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as never;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(http));
});
afterEach(async () => { releaseLog?.(); if (root) await unmount(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("case 1 / run 475641c1: captured HTTP fallback, not a fabricated transcript", () => {
  it("omits the historical identity-only row between Paul's saved messages after hydration and a fresh-cache remount", async () => {
    expect(capture.runs).toHaveLength(21); expect(capture.comments).toHaveLength(50);
    expect(chunk).toHaveLength(202); expect(chunk.split("\n")).toHaveLength(1); expect(() => JSON.parse(chunk)).toThrow();
    expect(new TextEncoder().encode(logContent)).toHaveLength(327);
    expect(capture.runs.find(run => run.runId === RUN)).toMatchObject({ status: "failed", runtimeMode: "native",
      adapterType: "paperclip_runner", errorCode: "native_continuation_requires_reconciliation" });
    expect(capture.comments.find(comment => comment.id === RECOVERY)).toMatchObject({ runId: null,
      createdByRunId: "03f3bbee-3f6b-4fde-a730-4986ee221702" });
    const identityOnlyMounts: string[] = [];
    for (const label of ["initial", "fresh-cache-remount"]) {
      requests = []; unexpected = [];
      await mount(); await hydrate();
      keepTransportBoundary(); keepSavedConversation(); saveEvidence(label);
      const turn = host.querySelector(TURN);
      if (turn) {
        // BASE must exhibit the exact defect, not merely any node with this run ID.
        expect(turn.querySelector(IDENTITY)?.textContent).toBe("Case 1 agent");
        expect(turn.querySelector(BODIES)).toBeNull();
        earlier(anchor(BEFORE), turn); earlier(turn, anchor(RECOVERY)); earlier(turn, anchor(AFTER));
        identityOnlyMounts.push(label);
      }
      await unmount();
    }
    // Deliberately asserted after BOTH mounts: RED evidence includes fresh-cache reload too.
    expect(identityOnlyMounts, "no agent name with nothing underneath it").toEqual([]);
  });

  // PLANTED HTTP controls, NOT claimed to be in 475641c1's captured empty conversation page.
  // These prove the no-body guard cannot erase a real activity/health payload. Neighbour
  // transcript bodies were withheld, so their actual visible activity is NOT qualified here.
  it.each(["activity", "health"] as const)("preserves a %s body through the same real HTTP/projection path (controlled payload)", async kind => {
    targetExtraEvents = kind === "activity"
      ? [event(1, "item.completed", { item: { id: "control-tool", type: "tool_use", name: "read_file",
          input: { path: "CONTROL.md" }, status: "completed" } })]
      : [event(1, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", noticeId: "control-notice",
          severity: "warning", category: "mcp_server_startup_failed", scope: "session", recoverable: true,
          userActionable: true, summary: "control MCP server failed to start", details: [{ name: "server", value: "control" }] })];
    await mount();
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
      const selector = kind === "activity" ? '[data-testid="task-chat-turn-timeline"]' : '[data-testid="task-chat-run-health-banner"]';
      expect(host.querySelector(TURN)?.querySelector(selector)).not.toBeNull();
    });
    const turn = host.querySelector(TURN)!;
    expect(turn.querySelector(IDENTITY)?.textContent).toBe("Case 1 agent");
    expect(turn.querySelector('[data-testid="task-chat-final-response"]')).toBeNull();
    if (kind === "health") {
      expect(turn.querySelector('[data-testid="task-chat-turn-timeline"]')).toBeNull();
      expect(turn.querySelector('[data-testid="task-chat-run-health-banner"]')?.textContent).toContain("control MCP server failed to start");
    } else {
      expect(turn.querySelector('[data-testid="task-chat-turn-timeline"]')?.textContent).toContain("Checked files");
    }
    keepSavedConversation(); saveEvidence(`control-${kind}`);
    expect(unexpected).toEqual([]);
  });
});
