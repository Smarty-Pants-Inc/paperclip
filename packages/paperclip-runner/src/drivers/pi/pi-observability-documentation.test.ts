import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("A2.8: documents our image-N adapter and the existing Pi event-contract mismatch", () => {
  const doc = readFileSync(new URL("../../../../../doc/agent-observability.md", import.meta.url), "utf8");
  const section = doc.split("## Native Pi (fork)")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toContain("adapter is **our code**");
  expect(section).toContain("`turn.started`");
  expect(section).toContain("`usage.reported`");
  expect(section).toContain("not the exporter's submission/usage layout");
});
