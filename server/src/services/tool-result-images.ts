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
  if (record.type === "image" && typeof record.data === "string") {
    const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "data")
      .map(([key, item]) => [key, referenceToolImages(item)]));
    return { ...metadata, ...toolImageReference(record.data) };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, referenceToolImages(item)]));
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
  if (before.type === "image" && typeof before.data === "string") {
    const { reference: _reference, sha256: _sha256, sizeBytes: _sizeBytes, ...block } = governed as Record<string, unknown>;
    // Preserve legacy JSON field order too: data.content may be arbitrary
    // metadata whose old text envelope must remain byte-identical. Restore
    // only the opaque body; every other surviving field remains governed.
    const keys = [...new Set([...Object.keys(before), ...Object.keys(block)])];
    return Object.fromEntries(keys.filter(key => key === "data" || Object.prototype.hasOwnProperty.call(block, key))
      .map(key => [key, key === "data" ? before.data : block[key]]));
  }
  return Object.fromEntries(Object.entries(governed).map(([key, item]) => [key, restoreToolImages(item, before[key])]));
}
