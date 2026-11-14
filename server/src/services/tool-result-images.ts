import { createHash } from "node:crypto";

/** A log-safe content address, never an image body or a public download URL. */
export function toolImageReference(data: string) {
  const bytes = Buffer.from(data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { reference: `sha256:${sha256}`, sha256, sizeBytes: bytes.length };
}

/** Images are opaque to text guards/classifiers and must not enter audit previews. */
export function referenceToolImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceToolImages);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const record = value as Record<string, unknown>;
  // Replace only the opaque body, in its own slot. Sibling reference/sha256/
  // sizeBytes fields may be ordinary legacy metadata: keep them available to
  // governance rather than overwriting them with host-generated values.
  const image = record.type === "image" && typeof record.data === "string";
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
    image && key === "data" ? toolImageReference(item as string) : referenceToolImages(item),
  ]));
}

/** Restore only the opaque image bodies; all accompanying text stays governed. */
export function restoreToolImages(governed: unknown, original: unknown): unknown {
  if (Array.isArray(governed) && Array.isArray(original)) {
    return governed.map((item, index) => restoreToolImages(item, original[index]));
  }
  if (governed === null || typeof governed !== "object" || original === null || typeof original !== "object") return governed;
  const prototype = Object.getPrototypeOf(governed);
  if (prototype !== Object.prototype && prototype !== null) return governed;
  const before = original as Record<string, unknown>;
  const image = before.type === "image" && typeof before.data === "string";
  return Object.fromEntries(Object.entries(governed).map(([key, item]) => {
    if (image && key === "data") {
      // Restore only an unchanged host reference. A removed/redacted body or
      // parent must stay removed/redacted; never copy original metadata back.
      const reference = toolImageReference(before.data as string);
      const body = item !== null && typeof item === "object" ? item as Record<string, unknown> : null;
      return [key, body && Object.keys(body).length === 3
        && body.reference === reference.reference && body.sha256 === reference.sha256 && body.sizeBytes === reference.sizeBytes
        ? before.data : item];
    }
    // Walk surviving metadata too, including nested image-looking objects and
    // legacy reference fields. Iterating governed keys preserves their order.
    return [key, restoreToolImages(item, before[key])];
  }));
}
