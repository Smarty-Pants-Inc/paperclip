import { Link } from "@/lib/router";

/** Explain a producer-side omission without pretending the browser can restore it. */
export function SavedOutputNotice({ kind = "output", runLogHref }: { kind?: "output" | "file preview" | "patch"; runLogHref?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      The runner saved only part of this {kind}.
      {runLogHref ? <> <Link className="underline underline-offset-4" to={runLogHref}>Open the run log</Link> for the saved output.</> : " Open the run log for the saved output."}
    </p>
  );
}
