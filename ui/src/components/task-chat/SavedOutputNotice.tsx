import { Link } from "@/lib/router";

/** Explain retained tool text, or a producer-side omission in a preview or patch. */
export function SavedOutputNotice({ kind = "output", runLogHref, fullTextKept = false }: { kind?: "output" | "file preview" | "patch" | "trace"; runLogHref?: string; fullTextKept?: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      {fullTextKept ? "The full output is kept on the agent's machine while it runs." : `The runner saved only part of this ${kind}.`}
      {runLogHref ? <> <Link className="underline underline-offset-4" to={runLogHref}>Open the run log</Link>{fullTextKept ? "." : " for the saved output."}</> : null}
    </p>
  );
}
