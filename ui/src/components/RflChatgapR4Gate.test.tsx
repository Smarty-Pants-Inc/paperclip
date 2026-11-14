// @vitest-environment jsdom
import { readFileSync, writeFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
// Coupled evidence from the actual registered recovery + issue GET, not a
// separately invented UI fixture. No provider or browser qualification claimed.
it("renders the stopped case's actual saved issue-GET presentation through the real notice component", async () => {
  const rows=readFileSync(process.env.RFL_GATE_RECEIPTS!,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const row=rows.find(row=>row.gate==="stopped");
  expect(row).toBeDefined();
  const presentation={intentId:null,nextRetryAt:null,...row.issue.interruption} as TaskInterruptionPresentation;
  const container=document.createElement("div");document.body.append(container);
  const root=createRoot(container);
  try {
    await act(async()=>root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={()=>{}} issueId={row.issue.id} />));
    writeFileSync(`${process.env.TASK_OUT}/stopped-render.html`,container.innerHTML);
    writeFileSync(`${process.env.TASK_OUT}/stopped-render.txt`,container.textContent??"");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
  } finally {await act(async()=>root.unmount());container.remove();}
});
