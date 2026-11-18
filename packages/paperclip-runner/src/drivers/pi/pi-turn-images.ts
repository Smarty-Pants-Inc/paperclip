import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { NativeUserMessage } from "../../contracts/types.js";
import { piRpcUserInput } from "./pi-user-input.js";

// Match the native Runner attachment contract, not the untrusted filename.
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function mimeType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("pi_attachment_image_type_unsupported");
}

/** Resolve only typed, run-authorized paths. Prompt text is never a file grant.
 * Both workspace-relative staging and Runner's absolute download paths are
 * provider-local; the controller must not read or base64-encode remote files.
 */
export async function piTurnImageInput(message: NativeUserMessage, cwd: string) {
  const input = piRpcUserInput(message);
  try {
    return await prepareTurnImages(message, cwd, input);
  } catch (error) {
    throw new Error(`Pi image input could not be prepared: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function prepareTurnImages(message: NativeUserMessage, cwd: string, input: ReturnType<typeof piRpcUserInput>) {
  const paths = message.localImagePaths ?? [];
  if (paths.length > MAX_IMAGES) throw new Error("pi_attachment_image_count_denied");
  const images = [...(input.images ?? [])];
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || /[\x00-\x1f\x7f]/u.test(path)) throw new Error("pi_attachment_image_path_denied");
    const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size <= 0 || before.size > MAX_IMAGE_BYTES) throw new Error("pi_attachment_image_size_denied");
      // Bound reads even if a workspace process grows the file concurrently.
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("pi_attachment_image_changed");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("pi_attachment_image_changed");
      images.push({ type: "image" as const, data: bytes.toString("base64"), mimeType: mimeType(bytes) });
    } finally {
      await file.close();
    }
  }
  return { message: input.message, ...(images.length ? { images } : {}) };
}
