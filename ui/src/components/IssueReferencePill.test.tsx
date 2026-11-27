// @vitest-environment node
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IssueReferencePill } from "./IssueReferencePill";

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

describe("IssueReferencePill", () => {
  it("keeps removable task references on the task rule, not the lifecycle rule (C7)", () => {
    const base = { id: "task", identifier: "PAP-1", title: "Read traces", status: "blocked" };
    const cases = [
      { issue: { ...base, unblockDescriptor: null }, label: "Blocked · waiting", token: "--status-task-icon-in_queue" },
      { issue: base, label: "Blocked · waiting", token: "--status-task-icon-in_queue" },
      { issue: { ...base, unblockDescriptor: { owner: { userId: "paul" }, action: "Read" } }, label: "Person: Read", token: "--status-task-icon-blocked" },
    ];
    for (const { issue, label, token } of cases) {
      const html = renderToStaticMarkup(<IssueReferencePill issue={issue} onRemove={() => {}} />);
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`var(${token})`);
      expect(html).toContain('aria-label="Remove PAP-1 as blocker"');
    }
  });
});
