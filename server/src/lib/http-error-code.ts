import { HttpError } from "../errors.js";

/** Normalize owned HTTP error evidence without coupling application policy to HTTP. */
export function readHttpErrorCode(error: unknown): string | undefined {
  const details = error instanceof HttpError ? error.details as { code?: unknown } | null : null;
  return typeof details?.code === "string" ? details.code : undefined;
}
