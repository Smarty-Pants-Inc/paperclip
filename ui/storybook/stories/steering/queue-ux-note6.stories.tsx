import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatQueuedMessages } from "@/components/task-chat/TaskChatQueuedMessages";

/** Paul NOTE 6 (smarty-dev#20992), design revision 2: Send ▾ modes and the two-section waiting list. */
function entry(id: string, body: string, extra: Partial<IssueQueuedCommentEntry> = {}): IssueQueuedCommentEntry {
  return {
    comment: {
      id, companyId: "storybook", issueId: "note6", authorType: "user", authorAgentId: null,
      authorUserId: "storybook-user", body, presentation: null, metadata: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    position: 0, canEdit: true, canDiscard: true, ...extra,
  };
}

const FIVE = [
  entry("m1", "Use the staging database for this, not prod", { deliveryIntent: "steer" }),
  entry("m2", "Also keep the old export button for now", { deliveryIntent: "steer" }),
  entry("m3", "When that's done, write the release note", { deliveryIntent: "queue" }),
  entry("m4", "Then fix the phone layout", { deliveryIntent: "queue" }),
  entry("m5", "Check the keyboard shortcuts before finishing", { deliveryIntent: "queue" }),
];
// Second server shape: a /new keeps its own wake, and so do the messages behind it.
const BEHIND_NEW = [
  ...FIVE.slice(0, 3),
  entry("reset", "/new", { deliveryIntent: "queue", behindReset: true, queueId: "wake-2", queueRevision: "rev-2" }),
  entry("b1", "Then fix the phone layout", { deliveryIntent: "queue", behindReset: true, queueId: "wake-3", queueRevision: "rev-3" }),
];

const SAVED_ANSWER = [entry("answer", `Answered: Deployment choices\n\n${JSON.stringify({
  kind: "ask_user_questions", status: "answered", payload: {
    questionSet: { questions: [{ id: "environment", prompt: "Which environment should I use?" }] },
  }, result: { answers: { environment: "Staging" } },
})}`, { deliveryIntent: "queue", canEdit: false, canDiscard: false,
  source: { kind: "interaction", interactionId: "answer", interactionKind: "ask_user_questions", summary: "Answered: Deployment choices" },
})];

type Args = {
  composer: "idle" | "working" | "unavailable" | "reset-draft";
  list: "none" | "five" | "behind-new" | "paused" | "unsteerable" | "saved-answer" | "read-only";
  mobile: boolean;
};

function Note6Queue({ composer, list, mobile }: Args) {
  const [entries, setEntries] = useState(list === "behind-new" ? BEHIND_NEW : list === "none" ? []
    : list === "saved-answer" ? SAVED_ANSWER
      : list === "unsteerable" ? FIVE.map((candidate) => ({ ...candidate, deliveryIntent: "queue" as const })) : FIVE);
  const working = composer !== "idle";
  const queue: IssueQueuedCommentQueue = {
    issueId: "note6", queueId: "wake-1", state: "deferred", targetRunId: working ? "run-1" : null,
    revision: "rev-1", protocol: "paperclip_runner_v1",
    steeringDisposition: composer === "unavailable" || list === "paused" ? "unsupported" : "available",
    entries: entries.map((candidate, position) => ({ ...candidate, position })),
  };
  return (
    <main className={`flex min-h-screen flex-col bg-background text-foreground ${mobile ? "p-3" : "p-6"}`}>
      <div className={`mx-auto flex w-full flex-1 flex-col ${mobile ? "max-w-full" : "max-w-3xl"}`}>
        <div className="flex-1 space-y-3 py-6 text-sm">
          <p className="rounded-lg bg-card px-4 py-3">I’m updating the composer and checking the responsive layout.</p>
        </div>
        <div className="relative isolate flex flex-col">
          {list !== "none" ? <TaskChatQueuedMessages
            queue={queue}
            readOnly={list === "read-only"}
            onEdit={() => {}}
            onReorder={async (ids) => setEntries((current) => [
              ...ids.map((id) => current.find((candidate) => candidate.comment.id === id)!),
              ...current.filter((candidate) => candidate.queueId),
            ])}
            onSetIntent={async (id, intent) => setEntries((current) => current.map((candidate) =>
              candidate.comment.id === id ? { ...candidate, deliveryIntent: intent } : candidate))}
            onSteer={async () => {}}
            onInterrupt={async () => {}}
            onDiscard={async (id) => setEntries((current) => current.filter((candidate) => candidate.comment.id !== id))}
            autoSteerDelayMs={null}
            steerHeadOnly
          /> : null}
          <div className="relative z-10">
            <TaskChatComposer
              onAdd={async () => {}}
              workMode="standard"
              conversationMode
              steeringDisposition={composer === "unavailable" ? "unsupported" : working ? "available" : null}
              onStop={working ? async () => {} : undefined}
              mobile={mobile}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

const meta = {
  id: "composer-note6-send-modes-and-waiting-list",
  title: "Tasks and conversations/Steering and queued messages/Composer/Send modes and waiting list (NOTE 6)",
  component: Note6Queue,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Paul NOTE 6, design revision 2: Send ▾ (Steer, Queue, Interrupt with keys) and the Steering/Queued waiting list with per-row controls." } },
    paperclip: {
      "capabilities": ["steering/queue", "steering/steer", "steering/interrupt", "steering/edit-order-discard"],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production composer and queue with fixture queues: one merged wake (five messages) and a /new boundary with later wakes. No backend or provider runs.",
    },
  },
  args: { composer: "working", list: "five", mobile: false },
} satisfies Meta<typeof Note6Queue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkingFiveWaiting: Story = {};
export const IdleSend: Story = { args: { composer: "idle", list: "none" } };
export const SteeringUnavailable: Story = { args: { composer: "unavailable", list: "unsteerable" } };
export const SteeringPaused: Story = { args: { composer: "unavailable", list: "paused" } };
export const SavedCardAnswer: Story = { args: { list: "saved-answer" } };
export const NewDraftQueues: Story = { args: { composer: "reset-draft", list: "behind-new" } };
export const BehindNewBoundary: Story = { args: { list: "behind-new" } };
export const ReadOnlyViewer: Story = { args: { list: "read-only" } };
export const PhoneWorkingFiveWaiting: Story = {
  args: { mobile: true }, globals: { viewport: { value: "mobile", isRotated: false } },
};
export const PhoneBehindNewBoundary: Story = {
  args: { mobile: true, list: "behind-new" }, globals: { viewport: { value: "mobile", isRotated: false } },
};
