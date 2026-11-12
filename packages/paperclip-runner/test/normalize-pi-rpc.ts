import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { projectPiRecording } from "../test-support/pi-rpc-golden.js";

const directory = resolve(process.argv[2] ?? new URL("../test-fixtures/pi-rpc", import.meta.url).pathname);
for (const filename of readdirSync(directory).filter(name => name.endsWith(".jsonl") && !name.endsWith(".commands.jsonl"))) {
  const wire = readFileSync(resolve(directory, filename), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const normalized = projectPiRecording(wire, filename.startsWith("extension-"));
  const stem = filename.slice(0, -6);
  writeFileSync(resolve(directory, `${stem}.normalized.json`), JSON.stringify(normalized, null, 2) + "\n");
  if (stem === "real-1.5.2") writeFileSync(resolve(directory, "real-1.5.2.golden.json"), JSON.stringify(normalized, null, 2) + "\n");
  console.log(`${filename}: ${wire.length} raw => ${normalized.length} normalized`);
}
