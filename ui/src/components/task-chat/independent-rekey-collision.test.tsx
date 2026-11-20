// @vitest-environment jsdom
// Independent realistic re-key boundary: stable native itemIds, shifted transcript indexes.
import { mkdirSync, writeFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatRequestHistoryContext } from "./TaskChatComposerTakeoverContext";
import { transcriptToTaskChatItems } from "./transcript-adapter";

const entries: TranscriptEntry[] = [
  { kind: "assistant", itemId: "native-final-201", ts: "2026-11-20T07:41:43.642Z", channel: "final", text: "201" },
  { kind: "assistant", itemId: "native-final-202", ts: "2026-11-20T07:41:45.157Z", channel: "final", text: "202" },
];
const prefix: TranscriptEntry = { kind: "thinking", ts: "2026-11-20T07:41:42.000Z", text: "Checking the earlier question." };

describe.each([390,1440])("RF7 occupied-position rekey boundary %ipx", width => {
  it("keeps ONE 201 and ONE 202 when an existing key belongs to the next answer", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const host = document.createElement("div"); host.style.width = `${width}px`; document.body.append(host);
    const root = createRoot(host); let stage = "init"; const records: unknown[]=[];
    const sample = (source: string) => {
      const bubbles=[...host.querySelectorAll('[data-testid="task-chat-earlier-response"], [data-testid="task-chat-final-response"]')];
      const answers=bubbles.map(node=>({ id:node.getAttribute("data-answer-id"), text:node.querySelector('[data-conversation-text]')?.textContent?.trim() }));
      const row={stage,source,answers,a201:answers.filter(a=>a.text==="201").length,a202:answers.filter(a=>a.text==="202").length,html:host.innerHTML}; records.push(row); return row;
    };
    const observer=new MutationObserver(()=>sample("mutation-observer")); observer.observe(host,{subtree:true,childList:true,characterData:true});
    const render=async (label:string, source:TranscriptEntry[])=>{
      stage=label;
      const items=transcriptToTaskChatItems(source,{runId:"run-rekey",agentName:"Runner",running:true});
      records.push({stage,source:"parsed-items",items});
      await act(async()=>root.render(<MemoryRouter><ThemeProvider><TaskChatRequestHistoryContext.Provider value="issue-rekey">
        <TaskChatRunnerTurn runId="run-rekey" agentName="Runner" items={items} runAnswerItems={items} status="running" startedAtMs={Date.parse("2026-11-20T07:41:00Z")} continuedAfterSteering />
      </TaskChatRequestHistoryContext.Provider></ThemeProvider></MemoryRouter>));
      return sample("post-act");
    };
    try {
      const first=await render("two-original-finals",entries);
      const shifted=await render("same-finals-prefix-inserted",[prefix,...entries]);
      // No new answer, provider text, timestamp, native itemId, run or status changed.
      // Only the transcript position changes through the real production parser.
      expect([first.a201,first.a202,shifted.a201,shifted.a202]).toEqual([1,1,1,1]);
    } finally {
      observer.disconnect(); const out=process.env.RF7_TRACE_DIR;
      if(out){mkdirSync(out,{recursive:true});writeFileSync(`${out}/rekey-collision-${width}.json`,JSON.stringify({width,records},null,2));}
      act(()=>root.unmount());host.remove();
    }
  });
});
