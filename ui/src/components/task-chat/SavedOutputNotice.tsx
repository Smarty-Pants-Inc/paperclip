import { Link } from "@/lib/router";

function formatOutputBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${Number(bytes.toFixed(unit > 0 && bytes < 10 ? 1 : 0))} ${units[unit]}`;
}

/** Explain retained tool text, or a producer-side omission in a preview or patch. */
export function SavedOutputNotice({ kind = "output", runLogHref, fullTextKept = false, output, fullOutputBytes }: { kind?: "output" | "file preview" | "patch" | "trace"; runLogHref?: string; fullTextKept?: boolean; output?: string; fullOutputBytes?: number }) {
  const sizes = fullTextKept && fullOutputBytes !== undefined
    ? ` (${formatOutputBytes(new TextEncoder().encode(output ?? "").byteLength)} of ${formatOutputBytes(fullOutputBytes)})`
    : "";
  return (
    <p className="text-xs text-muted-foreground">
      {fullTextKept ? `Showing part of this output${sizes}. The full output stays on the agent's machine only while it runs.` : `The runner saved only part of this ${kind}.`}
      {!fullTextKept && runLogHref ? <> <Link className="underline underline-offset-4" to={runLogHref}>Open the run log</Link> for the saved output.</> : null}
    </p>
  );
}
