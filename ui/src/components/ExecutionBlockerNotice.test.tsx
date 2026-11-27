// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import type { AnchorHTMLAttributes, ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { ExecutionBlockerNotice, isExecutionRetryRefused } from "./ExecutionBlockerNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("C31 standalone refusal", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const retry = vi.fn(), newSession = vi.fn<() => Promise<void>>();
  const refusal = { ...failed, canRetry: false, failure: {
    code: "native_turn_prompt_exceeds_command_bound", title: "Message too large",
    detail: "The newest message is too large for this turn. Shorten it before sending again.",
  } } satisfies TaskInterruptionPresentation;
  beforeEach(() => {
    retry.mockReset(); newSession.mockReset().mockResolvedValue(undefined);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); vi.restoreAllMocks(); });
  async function mount(options: Partial<ComponentProps<typeof ExecutionBlockerNotice>> = {}) {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExecutionBlockerNotice presentation={refusal} canRetry onRetry={retry} conversationMode onNewSession={newSession} {...options} />
    </QueryClientProvider>));
  }
  it("keeps a runless C31 projection text-only even when it contains a measured cause", async () => {
    await mount({ presentation: { ...refusal, observedRunId: null, sourceRunIds: [], failure: { ...refusal.failure,
      ...{ cause: { kind: "command", bytes: 600000, measure: "prompt" } } } } });
    expect(container.querySelector('[role="status"] > span')?.textContent).toBe(`${refusal.failure.title}${refusal.failure.detail}`);
  });
  // Legacy v10 server text fixtures, bytes=123456, count=3. Preserve saved copy
  // verbatim, too. Exact final v11's 25 texts live in the sibling v11 test file.
  // Keep the closed kind inventory independent of the page's label map.
  const serverCopy = [
    ["task_description", "Task description is too large", "The task description is 121 KB. Edit the description on the task page to shorten it, or ask the task's owner in the task's comments to split the work into smaller tasks. Saved task history remains available."],
    ["newest_message", "Newest message is too large", "The newest message is 121 KB. If it is still queued, edit it in the task's message queue and send the remaining request as smaller messages. Otherwise ask the task's owner in the task's comments to split the request into smaller follow-up tasks. Saved task history remains available."],
    ["unread_message", "Unread message is too large", "An unread message is 121 KB. If it is still queued, edit it in the task's message queue and send the remaining request as smaller messages. Otherwise ask the task's owner in the task's comments to split the request into smaller follow-up tasks. Saved task history remains available."],
    ["unread_messages", "Unread messages are too large", "3 unread messages total 121 KB. Their combined size is too large for this turn. Ask the task's owner in the task's comments to split the requests into smaller follow-up tasks, or edit the messages in the task's message queue if they are still editable. Saved task history remains available."],
    ["queued_input", "Queued input is too large", "The queued input is 121 KB when encoded for this turn. If you can edit it in the task's message queue, shorten it there and send the rest as smaller messages; otherwise ask the task's owner in the task's comments to split the request into smaller follow-up tasks. This refusal does not claim or consume queued messages or answers; the input remains saved."],
    ["human_response", "Answer is too large", "A person's answer is 121 KB and is too large to send. The whole answer remains saved; a submitted answer cannot be edited here. Ask the task's owner in the task's comments to continue the work in a smaller follow-up task with a short description, linking back to this task for the saved answer."],
    ["protected_input", "Required task input is too large", "Required task input is 121 KB. Ask the task's owner in the task's comments to shorten the task description on the task page, or split the work into smaller tasks with links to the saved context. Saved task history remains available."],
    ["protected_inputs", "Required task inputs are too large", "Required task inputs total 121 KB. Their combined size is too large for this turn. Ask the task's owner in the task's comments to split the work into smaller tasks with shorter descriptions and links to the saved context. Saved task history remains available."],
    ["command", "Turn is too large", "The turn exceeds its byte budget; the saved byte count has no measurement label. Edit the description on the task page to shorten it, or ask the task's owner in the task's comments to split the work into smaller tasks. If those inputs are already small, ask the owner to report this run to the Paperclip operator for input-delivery repair. Saved task history remains available."],
    ["unmeasured_composition", "Queued input cannot be measured for this turn", "This session's command composition cannot be measured before claiming this queued input. No queued messages or answers were consumed; they remain saved. Ask the task's owner in the task's comments to report this run to the Paperclip operator to repair this session's input delivery."],
    ["stale_copy", "Session input contains stale history", "This session's input still contains a stale copy of history that was cut for room. Ask the task's owner in the task's comments to report this run to the Paperclip operator to repair fresh-session input delivery. Saved task history remains available to the agent through get_task_history."],
  ] as const;
  const measures = [
    ["command", "Serialized command"], ["prompt", "Encoded prompt"], ["envelope", "Encoded envelope"],
    ["handoff_note", "Encoded history-omission note"], ["command_upper_bound", null],
    ["protected_parts", "Located required inputs before command encoding"], ["envelope_with_reserve", null],
    [undefined, null], ["future_measure", null],
  ] as const;
  describe.each(["result", "projection"])("final kind x measure from %s", source => {
    it.each(serverCopy.flatMap(([kind, title, detail]) => measures.map(([measure, label]) => ({ kind, title, detail, measure, label }))))(
      "preserves server text and labels only the measured thing: $kind / $measure", async ({ kind, title, detail, measure, label }) => {
        const bytes = kind === "stale_copy" ? 25 : kind === "unmeasured_composition" ? 0 : 123456;
        const cause = { kind, bytes, count: 3, ...(measure === undefined ? {} : { measure }) };
        const failure = { ...refusal.failure, title, detail, ...(source === "projection" ? { cause } : {}) };
        await mount({ presentation: { ...refusal, failure },
          observedResultJson: source === "result" ? { nativeTurnPromptRefusalCause: cause, error: "PRIVATE RESULT TEXT" } : null,
          savedMessageBlocked: true, blocker: { canRetry: true, nextAction: "Generic recovery" } as never });
        const recognized = kind === "command" && ["command", "prompt", "envelope", "handoff_note"].includes(measure ?? "") ||
          kind === "protected_inputs" && measure === "protected_parts";
        const expected = label && recognized ? `${title}${detail}\n\n${label}: ${bytes.toLocaleString()} bytes.` : `${title}${detail}`;
        expect(container.textContent).toBe(expected);
        expect(container.textContent).not.toMatch(/Generic recovery|PRIVATE RESULT TEXT|\/new/);
        expect(container.querySelector("button")).toBeNull();
      });
  });
  it.each([
    ["command", "The serialized command measured by the guard is 121 KB and exceeds the turn's byte budget.", "Serialized command"],
    ["command_upper_bound", "The command upper bound, including reserved room, is 121 KB and exceeds the turn's byte budget.", null],
    ["prompt", "The encoded prompt is 121 KB and leaves no room for history within the turn's byte budget.", "Encoded prompt"],
    ["envelope", "The encoded envelope is 121 KB and leaves no room for history within the turn's byte budget.", "Encoded envelope"],
    ["handoff_note", "Even the encoded history-omission note (121 KB) does not fit in the room left for history.", "Encoded history-omission note"],
  ])("preserves the final server command / %s text including its supported way out", async (measure, firstSentence, label) => {
    const title = "Turn is too large";
    const detail = `${firstSentence} Edit the description on the task page to shorten it, or ask the task's owner in the task's comments to split the work into smaller tasks. If those inputs are already small, ask the owner to report this run to the Paperclip operator for input-delivery repair. Saved task history remains available.`;
    await mount({ presentation: { ...refusal, failure: { ...refusal.failure, title, detail } },
      observedResultJson: { nativeTurnPromptRefusalCause: { kind: "command", bytes: 123456, measure } } });
    expect(container.textContent).toBe(`${title}${detail}${label ? `\n\n${label}: ${(123456).toLocaleString()} bytes.` : ""}`);
    expect(container.querySelector("button")).toBeNull();
  });
  it.each([
    null, [], "raw input", {}, { kind: "unknown", bytes: 100 }, { kind: "__proto__", bytes: 100 },
    { kind: "constructor", bytes: 100 }, { kind: "newest_message", bytes: "100" },
    { kind: "newest_message", bytes: -1 }, { kind: "newest_message", bytes: 1.5 },
    { kind: "newest_message", bytes: Number.MAX_SAFE_INTEGER + 1 }, { kind: "newest_message", bytes: NaN },
    { kind: "newest_message", bytes: Infinity },
    { kind: "command", bytes: 100, measure: null }, { kind: "command", bytes: 100, measure: {} },
    { kind: "command", bytes: 100, measure: "__proto__" }, { kind: "command", bytes: 100, measure: "constructor" },
    { kind: "command", bytes: 100, measure: "prompt", count: 0 },
    { kind: "command", bytes: 100, measure: "prompt", count: 1.5 },
    { kind: "command", bytes: 100, measure: "prompt", count: "1" },
    { kind: "command", bytes: 100, measure: "prompt", futureField: true },
    { kind: "command", bytes: 100, measure: "prompt", remedies: null },
    { kind: "command", bytes: 100, measure: "prompt", remedies: "compact" },
  ])("falls back to plain server detail for a malformed cause (%j)", async cause => {
    await mount({ observedResultJson: { nativeTurnPromptRefusalCause: cause } });
    expect(container.textContent).toBe(`${refusal.failure.title}${refusal.failure.detail}`);
    expect(container.querySelector("button")).toBeNull();
  });
  it.each([0, Number.MAX_SAFE_INTEGER])("accepts a nonnegative safe integer at its boundary (%s)", async bytes => {
    await mount({ observedResultJson: { nativeTurnPromptRefusalCause: { kind: "command", bytes, measure: "prompt" } } });
    expect(container.textContent).toContain(`Encoded prompt: ${bytes.toLocaleString()} bytes.`);
  });
  it.each([
    { kind: "stale_copy", bytes: 25 }, { kind: "future_v10_kind", bytes: 100, measure: "command" },
    { kind: "newest_message", bytes: 100, measure: "future_measure" },
  ])("uses the server's exact words for a future cause/measure (%j), without inventing size or too-large copy", async cause => {
    await mount({ presentation: { ...refusal, failure: { ...refusal.failure,
      title: "Input delivery needs repair", detail: "Ask the task owner to repair input delivery before continuing." } },
      observedResultJson: { nativeTurnPromptRefusalCause: cause, error: "PRIVATE RESULT TEXT" } });
    expect(container.textContent).toBe("Input delivery needs repairAsk the task owner to repair input delivery before continuing.");
    expect(container.textContent).not.toMatch(/too large|bytes|PRIVATE RESULT TEXT/);
    expect(container.querySelector("button")).toBeNull();
  });
  it.each(["run_failed", "agent_machine_unreachable"])("keeps ordinary %s copy, Retry and the chat's /new exit exactly as base", async code => {
    for (const canRetry of [false, true]) for (const savedMessageBlocked of [false, true]) {
      const options = { presentation: { ...failed, canRetry }, canRetry, savedMessageBlocked };
      await mount(options);
      const base = container.innerHTML;
      await mount({ ...options, presentation: { ...options.presentation,
        failure: { code, title: "Server ordinary failure", detail: "An ordinary server explanation." } } });
      expect(container.innerHTML).toBe(base);
      if (!canRetry) expect(container.textContent).toContain("/new");
    }
  });
  it("does not let a legacy blocker retry flag remove the page-authorized recovery Retry", async () => {
    await mount({ presentation: null, conversationMode: false,
      blocker: { cause: "native_workspace_sync_out_retry_exhausted", canRetry: false, workspaceRepairRequired: true,
        nextAction: "Saving files failed. Retry to try again." } as never });
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Retry");
    await act(async () => button!.click()); expect(retry).toHaveBeenCalledOnce();
  });
  it("keeps a refused explanation visible during optimistic recovery and treats markup as text", async () => {
    await mount({ optimistic: true, presentation: { ...refusal, failure: { ...refusal.failure,
      detail: "Shorten <img src=x onerror=alert(1)> before sending again." } } });
    expect(container.textContent).toContain("Shorten <img src=x onerror=alert(1)>");
    expect(container.querySelector("img, button")).toBeNull();
  });
  it.each(["run", "projection"])("suppresses Retry when refusal arrives through %s alone", async source => {
    await mount({ presentation: source === "projection" ? { ...failed, failure: refusal.failure } : null,
      observedErrorCode: source === "run" ? refusal.failure.code : undefined, savedMessageBlocked: true });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("/new");
  });
  it("does not classify ordinary task retry permission as C31", () => {
    expect(isExecutionRetryRefused({ ...failed, canRetry: false })).toBe(false);
    expect(isExecutionRetryRefused(null, null, { nativeTurnPromptRefusalCause: { kind: "newest_message", bytes: 123 } })).toBe(true);
  });
  it("preserves an ordinary retryable classified failure", async () => {
    await mount({ presentation: { ...failed, failure: { code: "temporary", title: "Temporary error", detail: "Try again." } } });
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Retry");
    await act(async () => button!.click()); expect(retry).toHaveBeenCalledOnce();
  });
  describe.each(["result", "projection"])("structured remedy controls from %s", source => {
    const available = () => ({ edit_task_description: vi.fn(), edit_message: vi.fn(), delete_own_message: vi.fn(), new_followup_task: vi.fn() });
    it.each(serverCopy.map(([kind]) => kind))("Friday gate renders no remedy button for %s, even with every existing control", async kind => {
      const remedyControls = available();
      const cause = { kind, bytes: kind === "stale_copy" ? 25 : 123456,
        remedies: ["new_followup_task", "future_remedy", "edit_message", "new_followup_task", "delete_own_message", "edit_task_description"] };
      await mount({ remedyControls, observedResultJson: source === "result" ? { nativeTurnPromptRefusalCause: cause } : null,
        presentation: { ...refusal, failure: { ...refusal.failure, ...(source === "projection" ? { cause } : {}) } } });
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons).toHaveLength(0);
      for (const control of Object.values(remedyControls)) expect(control).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled(); expect(newSession).not.toHaveBeenCalled();
    });
    it.each([undefined, [], ["future_remedy"], ["compact", "new_session"], [null, {}, 1]])(
      "mounts no structured remedy without a known value (%j), even with every control", async remedies => {
        const cause = { kind: "command", bytes: 123456, measure: "command", ...(remedies === undefined ? {} : { remedies }) };
        await mount({ remedyControls: available(),
          observedResultJson: source === "result" ? { nativeTurnPromptRefusalCause: cause } : null,
          presentation: { ...refusal, failure: { ...refusal.failure, ...(source === "projection" ? { cause } : {}) } } });
        expect(container.querySelector("button")).toBeNull();
        if (remedies?.some(value => typeof value !== "string")) expect(container.textContent).toBe(`${refusal.failure.title}${refusal.failure.detail}`);
        else expect(container.textContent).toContain(`Serialized command: ${(123456).toLocaleString()} bytes.`);
      });
    it("keeps a partial existing-control map disabled too", async () => {
      const followUp = vi.fn();
      const cause = { kind: "command", bytes: 1, remedies: ["edit_task_description", "edit_message", "new_followup_task"] };
      await mount({ remedyControls: { new_followup_task: followUp },
        observedResultJson: source === "result" ? { nativeTurnPromptRefusalCause: cause } : null,
        presentation: { ...refusal, failure: { ...refusal.failure, ...(source === "projection" ? { cause } : {}) } } });
      expect(container.querySelector("button")).toBeNull();
      expect(followUp).not.toHaveBeenCalled();
    });
  });
  it.each([undefined, [], ["future_remedy"]])("never mounts actions from prose without supported structured remedies (%j)", async remedies => {
    const usage = vi.spyOn(issuesApi, "getContextUsage").mockResolvedValue({ compaction: { status: "available" } } as never);
    await mount({ issueId: "issue", presentation: { ...refusal, failure: { ...refusal.failure,
      detail: "Do not compact or start a new session. Ask the task's owner in the task's comments for help." } },
      observedResultJson: { nativeTurnPromptRefusalCause: { kind: "command", bytes: 123456, measure: "command",
        ...(remedies === undefined ? {} : { remedies }) } } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector("button")).toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Do not compact or start a new session.");
    expect(container.textContent).toContain(`Serialized command: ${(123456).toLocaleString()} bytes.`);
  });
  it.each([
    "Compact the context or start a new session before sending again.",
    "Start a new session before sending again.", "Send /new to start a new session.",
  ])("keeps prose as text, never a control declaration: %s", async detail => {
    const compact = vi.spyOn(issuesApi, "compactContext").mockResolvedValue({} as never);
    const usage = vi.spyOn(issuesApi, "getContextUsage").mockResolvedValue({ compaction: { status: "available" } } as never);
    await mount({ issueId: "issue", presentation: { ...refusal, failure: { ...refusal.failure, detail } } });
    expect(container.textContent).toBe(`${refusal.failure.title}${detail}`);
    expect(container.querySelector("button")).toBeNull();
    expect(compact).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });
  it.each([false, true])("never invents New session for a task, or without its authorized callback (task=%s)", async task => {
    await mount({ conversationMode: !task, onNewSession: task ? newSession : undefined,
      presentation: { ...refusal, failure: { ...refusal.failure, detail: "Start a new session." } } });
    expect(container.querySelector("button")).toBeNull();
  });

});

describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async (presentation = failed, options: { canRetry?: boolean; optimistic?: boolean; takingLonger?: boolean; error?: Error } = {}) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...options} />));
  };
  const personStops = [
    { personStop: { requestedAt: "2026-11-24T20:00:00Z" } },
    { cancellation: { source: "operator", initiator: { type: "user" } } },
    { executionCancellation: { state: "acknowledged" } },
  ];
  const repairMessage = "Paperclip is recovering saved work before continuing. Your message is saved.";
  const repairRetrySentence = " Press Retry to continue from your saved work.";
  const pausedConversation = "This conversation paused after a problem on our side.";
  const recoveredBlocker = {
    recoveryActionId: "hold", runId: "source", agentId: "agent", cause: "native_continuation_requires_reconciliation",
    runStatus: "failed", runError: "provider-pack.json is unreadable (permission_denied)", canContinue: false, canRetry: false,
    savedMessageCount: 0, nextAction: "Saved work recovered.",
  };
  // A recovered file receipt alone is not permission for a new person turn.
  it("keeps a failed pack/recovered false-false projection on hold, without guessing from the error", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
      observedStatus="failed" observedErrorCode="runner_remote_provider_artifact_incompatible"
      blocker={recoveredBlocker} canRetry onRetry={retry} conversationMode />));
    expect(container.textContent).toBe(recoveredBlocker.nextAction);
    expect(container.textContent).not.toMatch(/Send a message|\/new|Press Retry/);
    expect(container.querySelector("button")).toBeNull();
  });
  it.each(["runner_remote_provider_artifact_incompatible", "native_session_interrupted", "future_provider_fault"])(
    "names the person's next message when the server allows continuation after %s", async observedErrorCode => {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
        observedStatus="failed" observedErrorCode={observedErrorCode}
        blocker={{ ...recoveredBlocker, canContinue: true, nextAction: "" }} canRetry onRetry={retry} conversationMode />));
      expect(container.textContent).toBe(`${pausedConversation} Send a message to continue.`);
      expect(container.textContent).not.toMatch(/Couldn't resume|\/new|agent.*message/i);
      expect(container.querySelector("button")).toBeNull();
    });
  it.each([
    "Send a message to continue.", "Send a new message to continue.",
    "Send a new chat message to continue this conversation.", "Saved work recovered. Send a message to continue.",
  ])("preserves server words without inferring continuation permission: %s", async nextAction => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
      observedStatus="failed" blocker={{ ...recoveredBlocker, nextAction }} canRetry onRetry={retry} conversationMode />));
    expect(container.textContent).toBe(nextAction);
    expect(container.querySelector("button")).toBeNull();
  });
  it.each([
    ["Send a message or press Retry to continue.", true],
    ["Send a message to continue.", false],
    ["Saved work recovered. Send a message or press Retry to continue.", true],
  ] as const)("preserves the server's native person-continuation action: %s", async (nextAction, canRetry) => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry }} observedStatus="failed"
      blocker={{ ...recoveredBlocker, canContinue: true, canRetry, nextAction }} canRetry onRetry={retry} conversationMode />));
    expect(container.querySelector('[role="status"] > span')?.textContent).toBe(nextAction);
    expect(container.textContent).not.toMatch(/Couldn't resume|Your message is saved|\/new/);
    expect(container.querySelectorAll("button")).toHaveLength(Number(canRetry));
    if (canRetry) {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it.each([
    "Inspect the run before sending a new message to request continuation.",
    "Verify the connection, then send a new message to continue.",
    "Do not send a message to continue.", "An agent can send a message to continue.",
  ])("does not turn conditional or unrelated next-action prose into permission: %s", async nextAction => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
      observedStatus="failed" blocker={{ ...recoveredBlocker, nextAction }} canRetry onRetry={retry} />));
    expect(container.textContent).toBe(nextAction);
    expect(container.querySelector("button")).toBeNull();
  });
  // Exact failed/recovered projection: Retry is available, but no unanswered
  // person messages are held. File custody is not message-delivery custody.
  it.each([false, true])("shows the recovered-work Retry action, not a failed resume (message continuation=%s)", async canContinue => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, intentId: null }} observedStatus="failed"
      blocker={{ ...recoveredBlocker, canContinue, canRetry: true, nextAction: "Saved work recovered. Retry continues from it." }}
      canRetry onRetry={retry} conversationMode />));
    expect(container.querySelector('[role="status"] > span')?.textContent).toBe("Saved work recovered. Retry continues from it.");
    expect(container.textContent).not.toMatch(/Couldn't resume|Send a message|\/new|Your message is saved/);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    const notice = container.querySelector('[role="status"][aria-label="Task status"]')!;
    expect(notice.className).toBe("flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground");
    expect(notice.querySelector("svg")?.classList.contains("lucide-circle-alert")).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it.each([[false, true, true], [true, false, true], [true, true, false]])(
    "does not invite an unavailable Retry (page=%s, interruption=%s, blocker=%s)", async (pageRetry, interruptionRetry, blockerRetry) => {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: interruptionRetry }}
        observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: true, canRetry: blockerRetry, nextAction: "" }}
        canRetry={pageRetry} onRetry={retry} />));
      expect(container.textContent).toBe(`${pausedConversation} Send a message to continue.`);
      expect(container.querySelector("button")).toBeNull();
    });
  it.each([0, 1, 2])("claims saved person input only when the server reports it (saved count=%s)", async savedMessageCount => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
      observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: true, savedMessageCount, nextAction: "" }} canRetry onRetry={retry} />));
    const saved = savedMessageCount === 1 ? " Your message is saved." : savedMessageCount > 1 ? ` Your ${savedMessageCount} messages are saved.` : "";
    expect(container.textContent).toBe(`${pausedConversation}${saved} Send a message to continue.`);
    expect(container.querySelector("button")).toBeNull();
  });
  it("does not assert a conversation cannot resume when its continuation capability is unknown", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: false }}
      observedStatus="failed" canRetry onRetry={retry} />));
    expect(container.textContent).toBe(pausedConversation);
    expect(container.querySelector("button")).toBeNull();
  });
  // Tone follows who owns the next step, independently of the server's words.
  // Eleven lifecycle/authority states crossed with five server next actions.
  const toneStates = [
    { name: "Retry required", red: true, retry: true, moving: false, canContinue: false },
    { name: "page cannot Retry", red: false, retry: false, moving: false, canContinue: false, pageRetry: false },
    { name: "presentation cannot Retry", red: false, retry: false, moving: false, canContinue: false, presentation: { canRetry: false } },
    { name: "blocker cannot Retry", red: false, retry: false, moving: false, canContinue: false, blockerRetry: false },
    { name: "active recovery", red: false, retry: false, moving: true, canContinue: false, presentation: { state: "working" as const, recoveryStep: "saving_previous_files" as const } },
    { name: "scheduled recovery", red: false, retry: false, moving: true, canContinue: false, presentation: { state: "retry_scheduled" as const, nextRetryAt: "2026-11-27T14:00:00Z" } },
    { name: "failed projection with next retry", red: false, retry: false, moving: true, canContinue: false, presentation: { nextRetryAt: "2026-11-27T14:00:00Z" } },
    { name: "queued workspace recovery", red: false, retry: false, moving: true, canContinue: false, workspaceRecovery: { status: "queued" as const, stage: "restoring_files" as const, canRetry: true, message: "Recovery queued." } },
    { name: "running workspace recovery", red: false, retry: false, moving: true, canContinue: false, workspaceRecovery: { status: "recovering" as const, stage: "restoring_files" as const, canRetry: true, message: "Recovery running." } },
    { name: "accepted Retry", red: false, retry: false, moving: true, canContinue: false, optimistic: true },
    { name: "no-action hold", red: false, retry: false, moving: false, canContinue: false, presentation: { canRetry: false }, blockerRetry: false },
  ];
  const toneActions = ["", "Saved work recovered. Retry continues from it.", "Saved work is ready. Choose Retry when you are ready.",
    "Inspect the run before sending a new message to request continuation.", "Saved <work> stays available."];
  it.each(toneStates.flatMap(state => toneActions.map(nextAction => ({ ...state, nextAction }))))(
    "recovery tone: $name / $nextAction", async row => {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, ...row.presentation }}
        observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: row.canContinue, canRetry: row.blockerRetry ?? true,
          nextAction: row.nextAction, workspaceRecovery: row.workspaceRecovery }}
        canRetry={row.pageRetry ?? true} optimistic={row.optimistic} onRetry={retry} conversationMode />));
      const notice = container.querySelector('[role="status"][aria-label="Task status"]')!;
      expect(notice.className).toBe(row.red
        ? "flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground"
        : "flex items-center gap-3 text-sm text-muted-foreground");
      const icon = notice.querySelector("svg")!;
      expect(icon.classList.contains(row.red ? "lucide-circle-alert" : row.moving ? "lucide-loader-circle" : "lucide-circle-pause")).toBe(true);
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.classList.contains("motion-safe:animate-spin")).toBe(row.moving);
      expect(Boolean(notice.querySelector("button"))).toBe(row.retry);
      const expectedCopy = !row.optimistic && row.presentation?.nextRetryAt
        ? `Trying again at ${new Date(row.presentation.nextRetryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : row.moving ? "Preparing your reply…"
        : row.nextAction || (row.retry ? `${pausedConversation} Press Retry to continue.`
          : row.blockerRetry === false
            ? "Couldn't resume this conversation. This task is on hold and can't continue from here yet."
            : `${pausedConversation} Send /new to start a fresh session, then send your message again.`);
      expect(notice.querySelector(":scope > span")?.textContent).toBe(expectedCopy);
      if (row.retry) {
        await act(async () => notice.querySelector<HTMLButtonElement>("button")!.click());
        expect(retry).toHaveBeenCalledOnce();
      } else expect(retry).not.toHaveBeenCalled();
    });
  it.each([null, "2026-11-27T14:00:00Z"])("names a scheduled recovery's local retry time only when supplied (%s)", async nextRetryAt => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "retry_scheduled", nextRetryAt }}
      observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: true, canRetry: true }} canRetry onRetry={retry} />));
    const notice = container.querySelector('[role="status"][aria-label="Task status"]')!;
    expect(notice.querySelector(":scope > span")?.textContent).toBe(nextRetryAt
      ? `Trying again at ${new Date(nextRetryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Preparing your reply…");
    expect(notice.className).toBe("flex items-center gap-3 text-sm text-muted-foreground");
    expect(notice.querySelector("svg")?.classList.contains("lucide-loader-circle")).toBe(true);
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.textContent).not.toMatch(/Press Retry|Send a message/);
    expect(retry).not.toHaveBeenCalled();
  });
  it.each([[false, true, true], [true, false, true], [true, true, false]])(
    "marks message-required continuation actionable without Retry (page=%s, presentation=%s, blocker=%s)", async (pageRetry, presentationRetry, blockerRetry) => {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: presentationRetry }}
        observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: true, canRetry: blockerRetry }}
        canRetry={pageRetry} onRetry={retry} />));
      const notice = container.querySelector('[role="status"][aria-label="Task status"]')!;
      expect(notice.className).toBe("flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground");
      expect(notice.querySelector("svg")?.classList.contains("lucide-circle-alert")).toBe(true);
      expect(notice.querySelector("svg")?.classList.contains("motion-safe:animate-spin")).toBe(false);
      expect(notice.textContent).toBe(recoveredBlocker.nextAction);
      expect(notice.querySelector("button")).toBeNull();
      // The same capability without server copy names the required person action.
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: presentationRetry }}
        observedStatus="failed" blocker={{ ...recoveredBlocker, canContinue: true, canRetry: blockerRetry, nextAction: "" }}
        canRetry={pageRetry} onRetry={retry} />));
      expect(container.querySelector('[role="status"]')?.className).toBe("flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground");
      expect(container.textContent).toBe(`${pausedConversation} Send a message to continue.`);
      expect(container.querySelector("button")).toBeNull();
      expect(retry).not.toHaveBeenCalled();
    });
  it.each(personStops)("keeps workspace repair words and the task Retry after a person's Stop (%j)", async observedResultJson => {
    for (const presentation of [null, failed, { ...failed, state: "resolved" as const }]) {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} observedStatus="cancelled"
        observedErrorCode="cancelled" observedResultJson={observedResultJson} canRetry onRetry={retry}
        blocker={{ runId: "source", workspaceRepairRequired: true, canRetry: false, nextAction: repairMessage } as never} />));
      expect(container.querySelector('[role="status"]')?.textContent).toBe(`${repairMessage}${repairRetrySentence}Retry`);
      expect(container.querySelector('[role="status"]')?.className).toContain("bg-destructive/10");
      expect(container.textContent).not.toMatch(/failed|Couldn't resume/);
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-execution-retry"]')!.click());
    }
    expect(retry).toHaveBeenCalledTimes(3);
  });
  it.each(personStops)("shows saved messages held by any execution blocker after Stop (%j)", async observedResultJson => {
    for (const cause of ["legacy_execution_requires_reconciliation", "native_continuation_requires_reconciliation", "future_recovery_hold"]) {
      for (const allowed of [false, true]) {
        await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: allowed }}
          observedStatus="cancelled" observedErrorCode="cancelled" observedResultJson={observedResultJson} canRetry onRetry={retry}
          blocker={{ recoveryActionId: "hold", runId: "source", agentId: "agent", cause,
            runStatus: "cancelled", runError: "Execution stopped", canContinue: false, canRetry: allowed, savedMessageCount: 2,
            nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated. Inspect the run before sending a new message to request continuation." }} />));
        const notice = container.querySelector('[aria-label="Task status"]');
        expect(notice?.textContent).toBe(allowed
          ? "Your 2 messages are saved. Press Retry to continue from your saved work.Retry"
          : "Your 2 messages are saved. This task is on hold after the Stop and can't continue from here yet.");
        expect(notice?.textContent).not.toMatch(/send.*new message|Preparing your reply/);
        expect(notice?.getAttribute("role")).toBe("status");
        expect(notice?.className).toBe(allowed
          ? "flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground"
          : "flex items-center gap-3 text-sm text-muted-foreground");
        expect(notice?.querySelector("svg")?.classList.contains(allowed ? "lucide-circle-alert" : "lucide-circle-pause")).toBe(true);
        expect(notice?.querySelector("svg")?.getAttribute("class")).not.toMatch(/animate|spin/);
        expect(Boolean(notice?.querySelector("button"))).toBe(allowed);
      }
    }
    expect(retry).not.toHaveBeenCalled();
  });
  it("does not promise Retry to a read-only viewer or when either server projection refuses it", async () => {
    for (const [pageCanRetry, presentationCanRetry, blockerCanRetry] of [[false, true, true], [true, false, true], [true, true, false]]) {
      await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, canRetry: presentationCanRetry }}
        observedResultJson={personStops[0]} canRetry={pageCanRetry} onRetry={retry}
        blocker={{ recoveryActionId: "hold", runId: "source", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
          nextAction: "Send a new message.", savedMessageCount: 1, canRetry: blockerCanRetry, canContinue: false }} />));
      expect(container.textContent).toBe("Your 1 message is saved. This task is on hold after the Stop and can't continue from here yet.");
      expect(container.querySelector('[role="status"]')?.className).toBe("flex items-center gap-3 text-sm text-muted-foreground");
      expect(container.querySelector('[class*="destructive"], button')).toBeNull();
    }
  });
  it.each(["working", "failed"] as const)("uses the existing neutral waiting style with a still icon for a no-action Stop hold (%s projection)", async state => {
    // Keep the neutral surface, but only active recovery promises movement.
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} canRetry onRetry={retry}
      blocker={{ workspaceRepairRequired: true, nextAction: "Recovering saved work…",
        workspaceRecovery: { status: "recovering", canRetry: false } } as never} />));
    const waiting = container.querySelector('[role="status"]')!;
    const waitingClass = waiting.className;
    expect(waiting.querySelector("svg")?.classList.contains("lucide-loader-circle")).toBe(true);
    expect(waiting.querySelector("svg")?.classList.contains("motion-safe:animate-spin")).toBe(true);
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state, canRetry: false }}
      observedResultJson={personStops[0]} canRetry onRetry={retry}
      blocker={{ recoveryActionId: "hold", runId: "source", agentId: "agent", cause: "native_continuation_requires_reconciliation",
        nextAction: "Continue from saved work.", savedMessageCount: 2, canRetry: false, canContinue: false }} />));
    const notice = container.querySelector('[role="status"][aria-label="Task status"]')!;
    expect(notice.className).toBe(waitingClass);
    expect(notice.querySelector("svg")?.classList.contains("lucide-circle-pause")).toBe(true);
    expect(notice.querySelector("svg")?.getAttribute("class")).not.toMatch(/animate|spin/);
    expect(notice.querySelector("svg")?.style.animation).toBe("");
    expect(notice.querySelector("animate, animateTransform, animateMotion")).toBeNull();
    expect(notice.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[class*="destructive"], button')).toBeNull();
    expect(notice.textContent).toBe("Your 2 messages are saved. This task is on hold after the Stop and can't continue from here yet.");
    expect(retry).not.toHaveBeenCalled();
  });
  it("uses the authorized Retry once for saved messages held after Stop", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working" }}
      observedResultJson={personStops[0]} canRetry onRetry={retry}
      blocker={{ recoveryActionId: "hold", runId: "source", agentId: "agent", cause: "native_continuation_requires_reconciliation",
        nextAction: "Continue from saved work.", savedMessageCount: 2, canRetry: true }} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-execution-retry"]')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("keeps an accepted held-message Retry disabled and reports a rejected Retry inline", async () => {
    const props = { presentation: { ...failed, state: "working" as const }, observedResultJson: personStops[0], canRetry: true, onRetry: retry,
      blocker: { recoveryActionId: "hold", runId: "source", agentId: "agent", cause: "legacy_execution_requires_reconciliation",
        nextAction: "Continue from saved work.", savedMessageCount: 2, canRetry: true } };
    await act(async () => root.render(<ExecutionBlockerNotice {...props} optimistic />));
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(container.querySelector('button')?.textContent).toBe("Retrying…");
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).not.toHaveBeenCalled();
    await act(async () => root.render(<ExecutionBlockerNotice {...props} error={new Error("Retry was not accepted.")} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Retry was not accepted.");
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });
  it.each(personStops)("keeps a plain person's Stop silent with nothing held (%j)", async observedResultJson => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="cancelled"
      observedErrorCode="cancelled" observedResultJson={observedResultJson} canRetry onRetry={retry} />));
    expect(container.innerHTML).toBe("");
    expect(retry).not.toHaveBeenCalled();
  });
  it("shows a held queued message's repair wait even without a blocker projection", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={null} observedStatus="cancelled"
      observedResultJson={personStops[0]} queuedMessageWait={{ reason: "workspace_repair_required", message: repairMessage }}
      canRetry onRetry={retry} />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${repairMessage}${repairRetrySentence}Retry`);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("keeps the server's projected repair wait above generic conversation recovery after Stop", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed,
      retryWait: { reason: "workspace_repair_required", message: repairMessage } }} observedStatus="cancelled"
      observedResultJson={personStops[0]} canRetry onRetry={retry} />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`${repairMessage}${repairRetrySentence}Retry`);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps a scheduled repair check neutral and follows the server's Retry permission (%s)", async serverCanRetry => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "retry_scheduled",
      nextRetryAt: "2026-11-27T12:00:00Z", canRetry: serverCanRetry, recoveryStep: "saving_previous_files",
      retryWait: { reason: "workspace_repair_required", message: repairMessage } }} observedStatus="cancelled"
      observedResultJson={personStops[0]} canRetry onRetry={retry}
      blocker={{ workspaceRepairRequired: true, nextAction: repairMessage } as never} />));
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toBe(`${repairMessage}${serverCanRetry ? "Retry" : ""}`);
    expect(notice.className).toContain("text-muted-foreground");
    expect(notice.className).not.toContain("destructive");
    expect(notice.querySelector('svg')?.getAttribute("class")).not.toContain("destructive");
    expect(Boolean(container.querySelector('button'))).toBe(serverCanRetry);
    if (serverCanRetry) {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it.each(["queued", "recovering"] as const)("keeps an explicitly %s workspace recovery neutral without inviting interruption", async status => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="cancelled"
      observedResultJson={personStops[0]} canRetry onRetry={retry}
      blocker={{ workspaceRepairRequired: true, nextAction: "Recovering saved work…",
        workspaceRecovery: { status, stage: "restoring_files", canRetry: false, message: "Recovering saved work…" } } as never} />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Recovering saved work…");
    const icon = container.querySelector('[role="status"] svg');
    expect(icon?.classList.contains("lucide-loader-circle")).toBe(true);
    expect(icon?.classList.contains("motion-safe:animate-spin")).toBe(true);
    expect(container.querySelector('[class*="destructive"], button')).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
  it("keeps an in-progress repair step neutral and respects read-only task access", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: true,
      recoveryStep: "saving_previous_files", retryWait: { reason: "workspace_repair_required", message: repairMessage } }}
      observedResultJson={personStops[0]} canRetry={false} onRetry={retry} />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(repairMessage);
    expect(container.querySelector('[class*="destructive"], button')).toBeNull();
  });
  it("does not turn a failed repair hold into a wait because it has an old check time", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, nextRetryAt: "2026-11-26T12:00:00Z",
      retryWait: { reason: "workspace_repair_required", message: repairMessage } }} observedResultJson={personStops[0]}
      canRetry onRetry={retry} />));
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toBe(`${repairMessage}${repairRetrySentence}Retry`);
    expect(notice.className).toContain("bg-destructive/10");
  });
  it("does not offer a workspace-repair mutation to a read-only viewer after Stop", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="cancelled"
      observedResultJson={personStops[0]} canRetry={false} onRetry={retry}
      blocker={{ workspaceRepairRequired: true, nextAction: repairMessage } as never} />));
    expect(container.textContent).toBe(repairMessage);
    expect(container.querySelector('button')).toBeNull();
  });
  it.each(["personStop"])("does not call a person's %s a failed conversation resume", async key => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="failed"
      observedResultJson={{ [key]: { requestedAt: "2026-11-24T20:00:00Z" } }} canRetry onRetry={retry} />));
    expect(container.textContent).not.toContain("Couldn't resume this conversation");
  });
  it("names Retry instead of a failed conversation resume when no person stopped the retryable run (a budget cancel's startup fence included)", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="failed" observedResultJson={{ startupCancellation: { requestedAt: "2026-11-24T20:00:00Z" } }} canRetry onRetry={retry} />));
    expect(container.querySelector('[role="status"] > span')?.textContent).toBe(`${pausedConversation} Press Retry to continue.`);
    expect(container.textContent).not.toContain("Couldn't resume this conversation");
  });
  it("offers one Retry without delegating infrastructure chores", async () => {
    await render();
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    // A stable handle for the task's own Retry, the supported path after
    // automatic recovery stops.
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector("a, details, input, textarea")).toBeNull();
    expect(container.textContent).not.toMatch(/service attention|process|receipt|workspace/i);
  });
  it("asks the person to help a blocked agent and offers Retry", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "unblock" });
    expect(container.textContent).toContain("needs your help to continue");
    expect(container.textContent).not.toMatch(/blocker_|native|owner kind/i);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-execution-retry"]')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([false, true])("names the question without repeating a historical failure (manual Retry=%s)", async canRetry => {
    const presentation = { ...failed, responsibility: "user" as const, state: "waiting_for_user" as const, userAction: "question" as const, canRetry,
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
        category: "rate_limit", httpStatus: 429, retryability: "unknown", message: "API error: 429" } } satisfies TaskInterruptionPresentation;
    await render(presentation);
    expect(container.textContent).toContain("Respond to the pending question to continue.");
    expect(container.textContent).not.toMatch(/429|rate limit|failed/i);
    expect(Boolean(container.querySelector("button"))).toBe(canRetry);
    if (canRetry) {
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(retry).toHaveBeenCalledOnce();
    }
    await render(presentation, { canRetry: false });
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps the failure visible and names the gate while a saved Retry waits on the budget", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false });
    const notice = container.querySelector('[data-testid="task-execution-waiting"]');
    expect(notice?.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(notice?.textContent).toContain("waiting for the budget to allow new work");
    // The saved Retry starts by itself; a second Retry would only duplicate it.
    expect(container.querySelector("button")).toBeNull();
  });

  it("does not report a failed attempt for a task the budget held before its first run", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false,
      sourceRunIds: [], observedRunId: null });
    const notice = container.querySelector('[data-testid="task-execution-waiting"]');
    expect(notice?.textContent).toContain("This task has not started.");
    expect(notice?.textContent).not.toContain("Couldn’t finish this attempt");
  });

  it("shows persisted backoff with a usable Retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z" });
    expect(container.textContent).toContain("Trying again in 30s");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(container.textContent).toContain("Trying again in 25s");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it.each(["working", "resolved"] as const)("does not duplicate the thread indicator for %s", async state => {
    await render({ ...failed, state }); expect(container.textContent).toBe("");
  });
  it("offers to move a waiting continuation forward in plain words, without reporting a failure", async () => {
    await render({ ...failed, state: "working", retryAction: "move_forward" });
    expect(container.textContent).toContain("Paperclip continues this task by itself.");
    expect(container.textContent).not.toMatch(/Couldn’t finish|failed|continuation|queue|run\b/i);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="task-execution-move-forward"]');
    expect(button?.textContent).toBe("Move it forward now");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => button!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows a waiting continuation without the button to a read-only user, or once the move was requested", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", retryAction: "move_forward" }}
      canRetry={false} onRetry={retry} />));
    expect(container.textContent).toContain("Paperclip continues this task by itself.");
    expect(container.querySelector("button")).toBeNull();
    await render({ ...failed, state: "working", canRetry: false });
    expect(container.textContent).toBe("");
  });

  it("names the admission hold a task that has not started waits for", async () => {
    await render({ ...failed, state: "working", canRetry: false, sourceRunIds: [], observedRunId: null,
      retryWait: { reason: "budget.blocked", message: "Waiting for the budget to allow new work. The task starts automatically when it does." } });
    expect(container.textContent).toBe("Waiting for the budget to allow new work. The task starts automatically when it does.");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names and links the readable blockers a saved Retry waits on, with no second Retry (restart chaos t05)", async () => {
    const message = "Retry is waiting on a blocked task this one depends on. Retry or unblock it; this task continues when it is done. Your Retry is saved.";
    const summary = (id: string, identifier: string, title: string, status: string) =>
      ({ id, identifier, title, status, priority: "medium", assigneeAgentId: null, assigneeUserId: null }) as never;
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[summary("child", "CHA-10", "Part 2", "blocked"), summary("gone", "CHA-11", "Part 3", "cancelled"),
        summary("done", "CHA-9", "Part 1", "done")]} />));
    expect(container.textContent).toContain(message);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("[data-testid='retry-waiting-on'] a")].map(link => link.getAttribute("href"));
    expect(links).toHaveLength(2);
    expect(links[0]).toContain("CHA-10");
    expect(container.textContent).toContain("Blocked: open it to Retry");
    expect(container.textContent).toContain("Cancelled: remove or replace it");
    expect(container.textContent).not.toContain("Part 1");
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows a locked blocker without reading its status, and a finished blocker still saving files", async () => {
    const message = "Retry is waiting for a finished task this one depends on to save its files. Your Retry is saved.";
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[{ id: "secret", identifier: "CHA-12", locked: true } as never]} />));
    expect(container.querySelector("[data-testid='locked-issue-chip']")?.textContent).toContain("CHA-12");
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ ...failed, state: "working", canRetry: false,
      retryWait: { reason: "dependency_blocked", message } }} canRetry onRetry={retry}
      blockers={[{ id: "done", identifier: "CHA-9", title: "Part 1", status: "done", priority: "medium",
        assigneeAgentId: null, assigneeUserId: null } as never]} />));
    expect(container.querySelector("[data-testid='retry-waiting-on'] a")?.getAttribute("href")).toContain("CHA-9");
    expect(container.textContent).toContain("Saving its files");
  });
  it("names the saved-work recovery step instead of a bare queue", async () => {
    await render({ ...failed, state: "working", canRetry: false, recoveryStep: "saving_previous_files" });
    expect(container.textContent).toBe("Saving files from the previous attempt…");
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the step a scheduled recovery will retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run" });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
  });
  it("names the recovery step inside a provider failure notice", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await render({ ...failed, state: "retry_scheduled", nextRetryAt: "2026-10-20T00:00:30Z", recoveryStep: "checking_previous_run",
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "startup", category: "overloaded",
        retryability: "unknown", message: "Try later." } });
    expect(container.textContent).toContain("Checking that the previous attempt stopped. Trying again in 30s…");
    expect(container.textContent).not.toContain("Paperclip will retry automatically.");
  });
  it("leaves genuine user decisions to their specific action surface", async () => {
    await render({ ...failed, responsibility: "user", state: "waiting_for_user", userAction: "approval", canRetry: false });
    expect(container.textContent).toBe("");
  });
  it("does not give read-only users a mutation", async () => {
    await render(failed, { canRetry: false }); expect(container.querySelector("button")).toBeNull();
  });
  it("removes the stale failure immediately while admission is pending", async () => {
    await render(failed, { optimistic: true }); expect(container.textContent).toBe("");
    await render(failed, { optimistic: true, takingLonger: true });
    expect(container.textContent).toContain("Taking longer than usual…");
  });
  it("shows a definitive admission rejection instead of silently dropping Retry", async () => {
    await render(failed, { error: new Error("Your task access changed. Refresh the task.") });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your task access changed.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
  it("shows workspace preparation failures as plain text while keeping retry permissions", async () => {
    const workspaceFailure = { message: 'Could not prepare the project folder <img src=x onerror=alert(1)>.' };
    await render({ ...failed, workspaceFailure }, { canRetry: false });
    expect(container.textContent).toContain("Couldn’t prepare the task folders.");
    expect(container.textContent).toContain(workspaceFailure.message);
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, workspaceFailure });
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, workspaceFailure, state: "working" });
    expect(container.textContent).toBe("");
  });
  it("names a failed workspace setup command and what to change, keeping Retry", async () => {
    const setupFailure = { step: "workspace_provision" as const, command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
      output: "bash: ./scripts/provision-worktree.sh: No such file or directory",
      message: "The project's workspace provision command \"bash ./scripts/provision-worktree.sh\" failed with exit code 127: bash: ./scripts/provision-worktree.sh: No such file or directory" };
    await render({ ...failed, setupFailure });
    expect(container.textContent).toContain("Couldn’t set up the task workspace.");
    expect(container.textContent).toContain(setupFailure.message);
    expect(container.textContent).toContain("Fix the command in the project’s workspace settings");
    expect(container.textContent).not.toContain("Couldn’t finish this attempt.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("shows why an accepted Retry is waiting and keeps another attempt available", async () => {
    const retryWait = { reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved." };
    await render({ ...failed, retryWait });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt.");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ ...failed, retryWait }, { canRetry: false });
    expect(container.textContent).toContain(retryWait.message);
    expect(container.querySelector("button")).toBeNull();
  });
  it("names the budget wait alongside a provider failure while a saved Retry is held", async () => {
    const providerFailure = { schema: "paperclip.provider-failure.v1" as const, provider: "openai", phase: "startup" as const,
      category: "overloaded" as const, retryability: "transient" as const, message: "Provider overloaded" };
    await render({ ...failed, providerFailure, responsibility: "user", state: "waiting_for_user", userAction: "budget", canRetry: false });
    expect(container.textContent).toContain("Provider overloaded");
    expect(container.querySelector('[data-testid="task-execution-waiting"]')?.textContent).toContain("waiting for the budget to allow new work");
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows an unknown provider's original explanation as text and preserves read-only access", async () => {
    const providerFailure = { schema: "paperclip.provider-failure.v1" as const, provider: "new-provider", phase: "startup" as const,
      category: "unknown" as const, retryability: "unknown" as const, httpStatus: 429,
      message: "Upstream failure <img src=x onerror=alert(1)>" };
    await render({ ...failed, providerFailure }, { canRetry: false });
    expect(container.textContent).toContain(providerFailure.message);
    expect(container.textContent).toContain("Failed before work started");
    expect(container.textContent).toContain("HTTP 429");
    expect(container.querySelector("img, button")).toBeNull();
    await render({ ...failed, providerFailure, state: "resolved" });
    expect(container.textContent).toBe("");
  });
});
