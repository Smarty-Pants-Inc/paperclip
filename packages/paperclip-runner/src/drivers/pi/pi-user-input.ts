import type { NativeUserMessage } from "../../contracts/types.js";

type Image = NonNullable<NativeUserMessage["images"]>[number];

function imageContent(value: unknown): Image {
  const image = value as Partial<Image> | null;
  if (!image || image.type !== "image" || typeof image.data !== "string" || !image.data
    || typeof image.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    || Buffer.from(image.data, "base64").toString("base64").replace(/=+$/, "") !== image.data.replace(/=+$/, "")) {
    throw new Error("Pi image input requires nonempty base64 data and an image MIME type");
  }
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

/** Map inline image content and typed provider-local staged paths without loss.
 * Remote URLs are refused; prompt text never authorizes local-file reads. */
export function parsePiUserInput(value: unknown): NativeUserMessage {
  if (!Array.isArray(value)) throw new Error("Pi input must be an array of text or image items");
  const texts: string[] = [], images: Image[] = [], localImagePaths: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Pi input item must be text or image");
    const entry = item as Record<string, unknown>;
    if ((entry.type === "text" || entry.type === undefined) && typeof entry.text === "string") texts.push(entry.text);
    else if (entry.type === "image") {
      if (entry.url !== undefined) {
        const match = typeof entry.url === "string" ? /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(entry.url) : null;
        if (!match) throw new Error("Pi image input URL must be a base64 image data URL; remote images are unsupported");
        images.push(imageContent({ type: "image", mimeType: match[1], data: match[2] }));
      } else images.push(imageContent(entry));
    } else if (entry.type === "localImage") {
      if (typeof entry.path !== "string" || !entry.path) throw new Error("Pi local image input requires a path");
      localImagePaths.push(entry.path);
    } else throw new Error(`Unsupported Pi input item type: ${String(entry.type)}`);
  }
  const message: NativeUserMessage = { role: "user", text: texts.join("\n"), ...(images.length ? { images } : {}), ...(localImagePaths.length ? { localImagePaths } : {}) };
  piRpcUserInput(message);
  return message;
}

/** Also validate direct driver callers before admission/turn authority changes. */
export function piRpcUserInput(message: NativeUserMessage): { message: string; images?: Image[] } {
  if (typeof message.text !== "string" || (message.images !== undefined && !Array.isArray(message.images))
    || (message.localImagePaths !== undefined && (!Array.isArray(message.localImagePaths)
      || message.localImagePaths.some(path => typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\x7f]/u.test(path))))) throw new Error("Invalid Pi input message");
  const images = message.images?.map(imageContent);
  if (!message.text.trim() && !images?.length && !message.localImagePaths?.length) throw new Error("Pi input must contain text or at least one image");
  return { message: message.text, ...(images?.length ? { images } : {}) };
}
