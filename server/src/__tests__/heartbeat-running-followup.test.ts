import { describe, expect, it } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";

describe("shouldQueueFollowupForRunningIssueWake", () => {
  it("preserves a deferred fallback while the source turn is still running", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "issue_commented",
        interactionId: "00000000-0000-4000-8000-000000000001",
        interactionStatus: "accepted",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("queues a plugin-requested wake after the running turn instead of merging it", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "Child SMAA-972 moved to blocked",
        source: "paperclip-plugin-blocker-relay",
        pluginId: "03d4fcea-33ca-4ee3-ab77-9b32b9063ff5",
        pluginKey: "smarty-pants.paperclip-plugin-blocker-relay",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("still coalesces a generic issue wake without new input", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_commented" },
      wakeCommentId: null,
    })).toBe(false);
  });
});
