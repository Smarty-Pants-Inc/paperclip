import { Link } from "@/lib/router";

/** Explain retained tool text, or a producer-side omission in a preview or patch. */
export function SavedOutputNotice({ kind = "output", runLogHref }: { kind?: "output" | "file preview" | "patch"; runLogHref?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {kind === "output" ? "The full text is kept; ask me to show any part." : `The runner saved only part of this ${kind}.`}
      {runLogHref ? <> <Link className="underline underline-offset-4" to={runLogHref}>Open the run log</Link> for the saved output.</> : kind !== "output" ? " Open the run log for the saved output." : null}
    </p>
  );
}
