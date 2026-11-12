import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeTranscript, RunTranscriptView } from "./RunTranscriptView";
import { ThemeProvider } from "../../context/ThemeContext";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const ts = "2026-11-12T06:18:00.000Z";
describe("canonical run-log rendering boundaries", () => {
  it("joins suffix deltas without inserting a newline, and replaces authoritative finals by ID", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts, text: "Hello ", delta: true, itemId: "a" },
      { kind: "assistant", ts, text: "🌍!", delta: true, itemId: "a" },
    ];
    expect(normalizeTranscript(entries, false)).toMatchObject([{ type: "message", text: "Hello 🌍!" }]);
    entries.push({ kind: "assistant", ts, text: "Corrected final", itemId: "a" });
    expect(normalizeTranscript(entries, false)).toMatchObject([{ type: "message", text: "Corrected final" }]);
  });
  it("labels absent usage unknown, never NaN or zero dollars", () => {
    const entries: TranscriptEntry[] = [{ kind: "result", ts, text: "Usage unknown", subtype: "paperclip.usage", inputTokens: NaN, outputTokens: NaN, cachedTokens: NaN, costUsd: NaN, isError: false, errors: [] }];
    for (const mode of ["nice", "raw"] as const) {
      const html = renderToStaticMarkup(<ThemeProvider><RunTranscriptView entries={entries} mode={mode} /></ThemeProvider>);
      expect(html).toContain("unknown");
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("$0.");
    }
  });
});
