import { isDeepStrictEqual } from "node:util";
import type { IssueChanges } from "@paperclipai/shared";

function canonicalIdArray(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return value;
  return [...new Set(value)].sort();
}

export function buildIssueChanges(
  existing: Record<string, unknown>,
  updated: Record<string, unknown>,
  relationChanges: {
    blockedByIssueIds?: { from: string[]; to: string[] };
    labelIds?: { from: string[]; to: string[] };
  } = {},
): IssueChanges {
  const changes: IssueChanges = {};
  const keys = new Set([...Object.keys(existing), ...Object.keys(updated)]);
  keys.delete("updatedAt");

  for (const key of keys) {
    const from = existing[key];
    const to = updated[key];
    if (isDeepStrictEqual(from, to)) continue;

    // `updated` is historical change metadata, not evidence of omitted bytes.
    // Retain complete values: board edits may have no producing run to reopen.
    changes[key] = key === "description" ? { from, to, updated: true } : { from, to };
  }

  for (const [key, change] of Object.entries(relationChanges)) {
    const from = canonicalIdArray(change.from);
    const to = canonicalIdArray(change.to);
    if (!isDeepStrictEqual(from, to)) changes[key] = { from, to };
  }

  return changes;
}
