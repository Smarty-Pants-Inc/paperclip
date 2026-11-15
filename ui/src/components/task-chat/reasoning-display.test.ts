import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findUIAdapter, registerUIAdapter } from "@/adapters/registry";
import { adapterReasoningDisplay } from "./reasoning-display";

function withAdapterDefault<T>(adapterType: string, view: "inline" | "fold" | undefined, body: () => T): T {
  const original = findUIAdapter(adapterType)!;
  registerUIAdapter({ ...original, transcriptPresentation: view ? { liveReasoningView: view } : undefined });
  try {
    return body();
  } finally {
    registerUIAdapter(original);
  }
}

describe("reasoning display resolution (look-only: the adapter default decides)", () => {
  it("uses the adapter's declared default, else fold", () => {
    withAdapterDefault("codex_local", "inline", () => {
      expect(adapterReasoningDisplay("codex_local")).toBe("inline");
    });
    withAdapterDefault("codex_local", "fold", () => {
      expect(adapterReasoningDisplay("codex_local")).toBe("fold");
    });
    withAdapterDefault("codex_local", undefined, () => {
      expect(adapterReasoningDisplay("codex_local")).toBe("fold");
    });
    expect(adapterReasoningDisplay(null)).toBe("fold");
    expect(adapterReasoningDisplay(undefined)).toBe("fold");
    expect(adapterReasoningDisplay("no_such_adapter")).toBe("fold");
  });

  it("shows a paperclip_runner (pi_rpc) run's reasoning inline with no click", () => {
    // The real registered adapter, no override: every one of Paul's agents is
    // paperclip_runner / pi_rpc, so this is what he sees by default.
    expect(findUIAdapter("paperclip_runner")?.transcriptPresentation?.liveReasoningView).toBe("inline");
    expect(adapterReasoningDisplay("paperclip_runner")).toBe("inline");
  });
});

describe("the old per-browser reasoning choice", () => {
  // Paul 11-15: no per-chat switch. Its localStorage value
  // (paperclip:task-chat:reasoning-display:v1) decides nothing.
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
