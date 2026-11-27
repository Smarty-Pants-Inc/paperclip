// @vitest-environment jsdom
// Exact 25 final server rows from C31V11-RESULT.md, supplied by STEER 4.
// Literal fixtures, not imports of server runtime or page copy constants.
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));
const rows = [
  {
    "name": "No readable cause",
    "cause": null,
    "title": "Task input could not be sent",
    "detail": "The task input could not be sent, but this run has no readable explanation. Give your instance admin this run and the task title to check the agent's runtime and Paperclip versions; if you are the instance admin, check those versions directly. After the cause is fixed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [],
    "byteLine": null
  },
  {
    "name": "task_description",
    "cause": {
      "kind": "task_description",
      "bytes": 750000,
      "remedies": [
        "edit_task_description",
        "new_followup_task"
      ]
    },
    "title": "Task description is too large",
    "detail": "The task description is 733 KB. Edit the description on the task page to shorten it to a brief request with links to the long text. Then send a message to continue. Or create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "newest_message",
    "cause": {
      "kind": "newest_message",
      "bytes": 750000,
      "remedies": [
        "edit_message",
        "delete_own_message",
        "new_followup_task"
      ]
    },
    "title": "Newest message is too large",
    "detail": "The newest message is 733 KB. If you wrote it and it is still editable, edit it in the task's message queue to a short request with a link to the long text. If it is no longer editable, you can save its text elsewhere and delete your own oversized message. After either change, send a short message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "edit_message",
      "delete_own_message",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "unread_message",
    "cause": {
      "kind": "unread_message",
      "bytes": 750000,
      "remedies": [
        "edit_message",
        "delete_own_message",
        "new_followup_task"
      ]
    },
    "title": "Unread message is too large",
    "detail": "An unread message is 733 KB. If you wrote it and it is still editable, edit it in the task's message queue to a short request with a link to the long text. If it is no longer editable, you can save its text elsewhere and delete your own oversized message. After either change, send a short message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "edit_message",
      "delete_own_message",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "unread_messages",
    "cause": {
      "kind": "unread_messages",
      "bytes": 750000,
      "count": 3,
      "remedies": [
        "edit_message",
        "delete_own_message",
        "new_followup_task"
      ]
    },
    "title": "Unread messages are too large",
    "detail": "3 unread messages total 733 KB. Their combined size is too large for this turn; sending the same text as several smaller messages does not reduce it. If you wrote the messages and they are still editable, shorten them in the task's message queue to brief requests with links to the long text, then send a short message to continue. You can instead save your own oversized messages elsewhere and delete them, then send a short message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "edit_message",
      "delete_own_message",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "queued_input",
    "cause": {
      "kind": "queued_input",
      "bytes": 750000,
      "remedies": [
        "edit_message",
        "new_followup_task"
      ]
    },
    "title": "Queued input is too large",
    "detail": "The queued input is 733 KB when encoded for this turn. If it is a message you wrote and it is still editable, edit it in the task's message queue to a short request with a link to the long text, then send a short message to continue. Sending the same text as several messages can exceed the same combined limit. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. This refusal does not claim or consume queued messages or answers.",
    "remedies": [
      "edit_message",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "human_response",
    "cause": {
      "kind": "human_response",
      "bytes": 750000,
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Answer is too large",
    "detail": "A person's answer is 733 KB and is too large to send. The whole answer remains saved; a submitted answer cannot be edited here. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "protected_input",
    "cause": {
      "kind": "protected_input",
      "bytes": 750000,
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Required task input is too large",
    "detail": "Required task input is 733 KB: task instructions other than the description, or a saved message that this turn must keep. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "protected_inputs",
    "cause": {
      "kind": "protected_inputs",
      "bytes": 750000,
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Required task inputs are too large",
    "detail": "The required inputs exceed this turn's budget; the saved byte count has no recognized measurement label. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "command",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The turn exceeds its byte budget; the saved byte count has no recognized measurement label. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": null
  },
  {
    "name": "unmeasured_composition",
    "cause": {
      "kind": "unmeasured_composition",
      "bytes": 0,
      "remedies": [
        "report_defect"
      ]
    },
    "title": "Queued input cannot be measured for this turn",
    "detail": "Paperclip could not check the complete turn's size before taking the queued input. No queued messages or answers were consumed; they remain saved. This is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "report_defect"
    ],
    "byteLine": null
  },
  {
    "name": "stale_copy",
    "cause": {
      "kind": "stale_copy",
      "bytes": 25,
      "remedies": [
        "report_defect"
      ]
    },
    "title": "Session input contains stale history",
    "detail": "The agent's input still includes an old copy of task history that Paperclip left out to make room. This is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "report_defect"
    ],
    "byteLine": null
  },
  {
    "name": "command / command",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "measure": "command",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The serialized command measured by the guard is 733 KB and exceeds the turn's byte budget. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": "Serialized command: 750,000 bytes."
  },
  {
    "name": "command / command_upper_bound",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "measure": "command_upper_bound",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The command upper bound, including reserved room, is 733 KB and exceeds the turn's byte budget. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": null
  },
  {
    "name": "command / prompt",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "measure": "prompt",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The encoded prompt is 733 KB and leaves no room for history within the turn's byte budget. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": "Encoded prompt: 750,000 bytes."
  },
  {
    "name": "command / envelope",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "measure": "envelope",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The encoded envelope is 733 KB and leaves no room for history within the turn's byte budget. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": "Encoded envelope: 750,000 bytes."
  },
  {
    "name": "command / handoff_note",
    "cause": {
      "kind": "command",
      "bytes": 750000,
      "measure": "handoff_note",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "Even the encoded history-omission note (733 KB) does not fit in the room left for history. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": "Encoded history-omission note: 750,000 bytes."
  },
  {
    "name": "protected_inputs / protected_parts",
    "cause": {
      "kind": "protected_inputs",
      "bytes": 750000,
      "measure": "protected_parts",
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Required task inputs are too large",
    "detail": "The located required inputs total 733 KB before command encoding. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": "Located required inputs before command encoding: 750,000 bytes."
  },
  {
    "name": "protected_inputs / envelope_with_reserve",
    "cause": {
      "kind": "protected_inputs",
      "bytes": 750000,
      "measure": "envelope_with_reserve",
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Required task inputs are too large",
    "detail": "The encoded task envelope, including reserved room, is 733 KB. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "protected_inputs / future_measure",
    "cause": {
      "kind": "protected_inputs",
      "bytes": 750000,
      "measure": "future_measure",
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Required task inputs are too large",
    "detail": "The required inputs exceed this turn's budget; the saved byte count has no recognized measurement label. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "unread_messages / count absent",
    "cause": {
      "kind": "unread_messages",
      "bytes": 750000,
      "remedies": [
        "edit_message",
        "delete_own_message",
        "new_followup_task"
      ]
    },
    "title": "Unread messages are too large",
    "detail": "Multiple unread messages total 733 KB. Their combined size is too large for this turn; sending the same text as several smaller messages does not reduce it. If you wrote the messages and they are still editable, shorten them in the task's message queue to brief requests with links to the long text, then send a short message to continue. You can instead save your own oversized messages elsewhere and delete them, then send a short message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "edit_message",
      "delete_own_message",
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "Unknown kind",
    "cause": {
      "kind": "future_input",
      "bytes": 25,
      "remedies": [
        "check_versions"
      ]
    },
    "title": "Task input could not be sent",
    "detail": "This Paperclip version does not recognize the saved input-refusal reason. The saved diagnostic byte count is 25 bytes; its meaning is not known here. Give your instance admin this run and the task title to check the agent's runtime and Paperclip versions; if you are the instance admin, check those versions directly. After the cause is fixed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "check_versions"
    ],
    "byteLine": null
  },
  {
    "name": "command / unknown measure",
    "cause": {
      "kind": "command",
      "bytes": 123,
      "measure": "future_measure",
      "remedies": [
        "edit_task_description",
        "new_followup_task",
        "report_defect"
      ]
    },
    "title": "Turn is too large",
    "detail": "The turn exceeds its byte budget; the saved byte count has no recognized measurement label. If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept. If the task inputs are already small, this is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "edit_task_description",
      "new_followup_task",
      "report_defect"
    ],
    "byteLine": null
  },
  {
    "name": "Known input / unknown measure",
    "cause": {
      "kind": "task_description",
      "bytes": 123,
      "measure": "future_measure",
      "remedies": [
        "new_followup_task"
      ]
    },
    "title": "Task description is too large",
    "detail": "The saved byte count (123 bytes) has no recognized measurement label for this input. Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.",
    "remedies": [
      "new_followup_task"
    ],
    "byteLine": null
  },
  {
    "name": "stale_copy / unknown measure",
    "cause": {
      "kind": "stale_copy",
      "bytes": 25,
      "measure": "future_measure",
      "remedies": [
        "report_defect"
      ]
    },
    "title": "Session input contains stale history",
    "detail": "The agent's input still includes an old copy of task history that Paperclip left out to make room. This is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.",
    "remedies": [
      "report_defect"
    ],
    "byteLine": null
  }
];
const controlNames = ["edit_task_description", "edit_message", "delete_own_message", "new_followup_task", "report_defect", "check_versions"];
describe("C31 v11 final contract", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  async function mount(row: typeof rows[number], source: string, controls: Record<string, () => void | Promise<void>>) {
    const failure = { code: "native_turn_prompt_exceeds_command_bound", title: row.title, detail: row.detail,
      ...(source === "projection" ? { cause: row.cause } : {}) };
    await act(async () => root.render(<ExecutionBlockerNotice presentation={{ intentId: null, responsibility: "system", state: "failed", canRetry: false,
      nextRetryAt: null, userAction: null, sourceRunIds: ["refused"], observedRunId: "refused", failure }}
      observedResultJson={source === "result" ? { nativeTurnPromptRefusalCause: row.cause } : null}
      canRetry onRetry={vi.fn()} remedyControls={controls} />));
  }
  describe.each(["result", "projection"])("from %s", source => {
    it.each(rows)("preserves final server text with all remedy buttons disabled: $name", async row => {
      const controls = Object.fromEntries(controlNames.map(key => [key, vi.fn()]));
      await mount(row, source, controls);
      const text = container.querySelector('[role="status"] > span')?.textContent;
      expect(text).toBe(`${row.title}${row.detail}${row.byteLine ? `\n\n${row.byteLine}` : ""}`);
      expect(container.querySelector("button")).toBeNull();
      for (const control of Object.values(controls)) expect(control).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
    });
  });
  it("never treats the removed owner-comment route as a supported remedy", async () => {
    const row = { ...rows[1], cause: { kind: "task_description", bytes: 1, remedies: ["ask_task_owner"] }, remedies: ["ask_task_owner"], byteLine: null };
    await mount(row as typeof rows[number], "result", { ask_task_owner: vi.fn() });
    expect(container.querySelector("button")).toBeNull();
  });
  it("does not render a saved remedy across an unknown kind or measure or add a false size", async () => {
    for (const cause of [{ kind: "future_input", bytes: 25, measure: "command" }, { kind: "command", bytes: 25, measure: "future_measure" }]) {
      const row = { ...rows[1], cause: { ...cause, remedies: ["new_followup_task", "future_remedy"] }, remedies: ["new_followup_task"], byteLine: null };
      await mount(row as typeof rows[number], "result", { new_followup_task: vi.fn() });
      expect(container.querySelector('[role="status"] > span')?.textContent).toBe(`${row.title}${row.detail}`);
      expect(container.querySelector("button")).toBeNull();
    }
  });
  it("Friday gate keeps all remedy buttons off when saved remedies have no message identity, even with callbacks", async () => {
    const controls = Object.fromEntries(controlNames.map(key => [key, vi.fn().mockResolvedValue(undefined)]));
    const row = { ...rows[1], cause: { kind: "newest_message", bytes: 1, remedies: controlNames }, remedies: controlNames, byteLine: null };
    await mount(row as typeof rows[number], "result", controls);
    expect(container.querySelector("button")).toBeNull();
    for (const control of Object.values(controls)) expect(control).not.toHaveBeenCalled();
    expect(container.textContent).toContain(row.detail);
  });
});
