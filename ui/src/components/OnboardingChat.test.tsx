// @vitest-environment jsdom

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";
import { OnboardingChat } from "./OnboardingChat";

const iso = "2026-11-20T13:04:00.000Z";
const token = `[${iso}](#paperclip-time=${iso})`;
const bodies = {
  unanswered: `Your message is saved: "Please keep my exact message." (${token}). Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.`,
  expired: `Your message is saved: "Please keep my exact message." (${token}). It was not answered. It is at least 24 hours old, so it will not run automatically. Send a new message to try again.`,
  setup: `Managed Pi is still being set up (since ${token}). Your message is saved and will be answered as soon as it's ready.`,
};

// Keep reason: AMMA6 checks review-fleet-5 findings 2/3 against real author
// provenance, not a system notice disguised as an agent reply. The recovery
// writer calls addComment(body, {}, { authorType: "system" }); both author IDs
// are null (unanswered-person-message.ts:576-580; issues.ts:14091-14092).
describe("AMMA6 saved-message notes in the real OnboardingChat", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let client: QueryClient | undefined;

  afterEach(() => {
    flushSync(() => root?.unmount());
    client?.clear();
    container?.remove();
  });

  it.each(Object.entries(bodies))("renders the system %s note in the reader's zone", (kind, body) => {
    const comment: IssueComment = {
      id: `system-${kind}`, companyId: "company-1", issueId: "task-1",
      authorType: "system", authorAgentId: null, authorUserId: null,
      body, presentation: { kind: "system_notice", title: "Your message is saved", tone: "warning" },
      metadata: null, createdAt: new Date(iso), updatedAt: new Date(iso),
    };
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    // The API/query boundary is seeded with the persisted comment shape; the
    // component, MarkdownBody, parser, and Intl formatter are all real.
    client.setQueryData(queryKeys.issues.comments("task-1"), [comment]);
    client.setQueryData(queryKeys.issues.activeRun("task-1"), null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <MemoryRouter>
        <QueryClientProvider client={client!}>
          <ThemeProvider>
            <OnboardingChat taskId="task-1" agentId="agent-1" agentName="Managed Pi"
              companyName="Smarty Pants" companyGoal="Answer Paul's saved message" />
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    ));
    const defaults = new Intl.DateTimeFormat().resolvedOptions();
    const expected = process.env.AMMA6_READER === "NY" ? "8:04 AM"
      : process.env.AMMA6_READER === "Berlin" ? "14:04"
      : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    const time = container.querySelector("time[datetime]");
    const evidence = {
      boundary: "real OnboardingChat + real MarkdownBody in jsdom", kind,
      phase: process.env.AMMA6_PHASE, defaults, input: comment,
      expected, actual: time?.textContent ?? null,
      title: time?.getAttribute("title"), visibleText: container.textContent,
      html: container.innerHTML,
    };
    if (process.env.AMMA6_EVIDENCE_DIR) writeFileSync(
      join(process.env.AMMA6_EVIDENCE_DIR, `${process.env.AMMA6_PHASE}-${process.env.AMMA6_READER}-${kind}.json`),
      JSON.stringify(evidence, null, 2),
    );
    expect(time?.getAttribute("datetime")).toBe(iso);
    expect(time?.textContent).toBe(expected);
    expect(time?.getAttribute("title")).toBeTruthy();
    expect(container.textContent).toContain(kind === "setup" ? "Managed Pi is still being set up" : 'Your message is saved: "Please keep my exact message."');
    expect(container.textContent).not.toContain(iso);
    expect(container.textContent).not.toContain("#paperclip-time");
    expect(container.querySelector('a[href^="#paperclip-time="]')).toBeNull();
  });
});
