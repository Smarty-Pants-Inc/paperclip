import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findUIAdapter, registerUIAdapter } from "@/adapters/registry";
import { adapterReasoningDisplay, resolveReasoningDisplay } from "./reasoning-display";

function withAdapterDefault<T>(adapterType: string, view: "inline" | "fold" | undefined, body: () => T): T {
  const original = findUIAdapter(adapterType)!;
  registerUIAdapter({ ...original, transcriptPresentation: view ? { liveReasoningView: view } : undefined });
  try {
    return body();
  } finally {
    registerUIAdapter(original);
  }
}

describe("reasoning display resolution", () => {
  it("uses the adapter's declared default when the person has no preference for the agent", () => {
    withAdapterDefault("codex_local", "inline", () => {
      expect(adapterReasoningDisplay("codex_local")).toBe("inline");
      expect(resolveReasoningDisplay({}, "agent-1", "codex_local")).toBe("inline");
      expect(resolveReasoningDisplay(undefined, "agent-1", "codex_local")).toBe("inline");
    });
    withAdapterDefault("codex_local", undefined, () => {
      expect(resolveReasoningDisplay({}, "agent-1", "codex_local")).toBe("fold");
    });
    expect(resolveReasoningDisplay({}, null, null)).toBe("fold");
  });

  it("lets the person's agent preference win over the adapter default, in both directions", () => {
    withAdapterDefault("codex_local", "inline", () => {
      expect(resolveReasoningDisplay({ "agent-1": "fold" }, "agent-1", "codex_local")).toBe("fold");
    });
    withAdapterDefault("codex_local", "fold", () => {
      expect(resolveReasoningDisplay({ "agent-1": "inline" }, "agent-1", "codex_local")).toBe("inline");
    });
  });

  it("keys the preference by agent: another agent's choice does not apply", () => {
    withAdapterDefault("codex_local", undefined, () => {
      expect(resolveReasoningDisplay({ "agent-2": "inline" }, "agent-1", "codex_local")).toBe("fold");
      expect(resolveReasoningDisplay({ "agent-2": "inline" }, null, "codex_local")).toBe("fold");
    });
  });
});

describe("the old per-browser reasoning choice", () => {
  // Paul 11-15: one place only, the agent page. The per-chat switch and its
  // localStorage value (paperclip:task-chat:reasoning-display:v1) decide nothing.
  it("is not read or written by any UI source file", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) { walk(file); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(file, "utf8");
        if (text.includes("task-chat:reasoning-display") || text.includes("REASONING_DISPLAY_STORAGE_KEY")
          || text.includes("readReasoningDisplay")) {
          offenders.push(path.relative(root, file));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
