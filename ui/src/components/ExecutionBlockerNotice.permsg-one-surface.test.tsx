// @vitest-environment jsdom
// adopt-permsg-gaps (4) ONE true surface for one failure: when the failed run's owed messages each have their own card
// (server unanswered-person-message.ts, key unanswered_message:<id>, metadata.sourceRunId), the generic red
// "Couldn’t finish this attempt. Your message is saved." [Retry] does not ALSO stand above them for the same run.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueComment, TaskInterruptionPresentation } from "@paperclipai/shared";
import type { AnchorHTMLAttributes } from "react";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { perMessageCardRunIds } from "../lib/per-message-cards";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["failed-successor"], observedRunId: "failed-successor",
};
const card = (messageId: string, sourceRunId: string, extra: Partial<IssueComment> = {}) => ({
  id: `card-${messageId}`, authorType: "system", deletedAt: null, body: "Your message wasn't answered.",
  metadata: { version: 1, sourceRunId, authorizationReason: `unanswered_message:${messageId}`, sections: [] }, ...extra,
}) as unknown as IssueComment;

describe("one surface for one failure (permsg gap 4)", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (comments: IssueComment[]) => act(async () => root.render(<ExecutionBlockerNotice presentation={failed}
    canRetry onRetry={retry} messageCardRunIds={perMessageCardRunIds(comments)} />));

  it("the failed run's per-message cards stand: no generic red line and no second Retry above them", async () => {
    await render([card("work", "failed-successor"), card("q1", "failed-successor"), card("q2", "failed-successor")]);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt");
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
  });

  it("cards for ANOTHER run, or retired (deleted) cards, do not hide this run's failure", async () => {
    await render([card("old", "an-earlier-run"), card("work", "failed-successor", { deletedAt: new Date() } as Partial<IssueComment>)]);
    expect(container.textContent).toContain("Couldn’t finish this attempt");
    expect(container.querySelector('[data-testid="task-execution-retry"]')).not.toBeNull();
  });

  it("with no cards the generic failure and its Retry still show", async () => {
    await render([]);
    expect(container.textContent).toContain("Couldn’t finish this attempt");
    expect(container.querySelector('[data-testid="task-execution-retry"]')).not.toBeNull();
  });
});
