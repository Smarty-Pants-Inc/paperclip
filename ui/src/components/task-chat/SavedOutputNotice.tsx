import { Link } from "@/lib/router";

/** Explain retained tool text, or a producer-side omission in a preview or patch. */
export function SavedOutputNotice({ kind = "output", runLogHref, fullTextKept = false }: { kind?: "output" | "file preview" | "patch" | "trace"; runLogHref?: string; fullTextKept?: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      {fullTextKept ? "The full text is kept; ask me to show any part." : `The runner saved only part of this ${kind}.`}
      {runLogHref ? <> <Link className="underline underline-offset-4" to={runLogHref}>Open the run log</Link> for the saved output.</> : null}
    </p>
  );
}
