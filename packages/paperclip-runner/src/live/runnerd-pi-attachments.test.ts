import { describe, expect, it } from "vitest";
import { runnerdPiLocalImagePaths } from "./runnerd-codex-transport.js";

describe("durable Pi attachment input", () => {
  it("keeps Runner-local PNG paths while leaving document references in text", () => {
    const input = [
      { type: "text", text: "Read PDF /runner/attachment-downloads/brief.pdf" },
      { type: "localImage", path: "/runner/attachment-downloads/screenshot.png" },
    ];
    expect(runnerdPiLocalImagePaths(input, "pi_rpc")).toEqual(["/runner/attachment-downloads/screenshot.png"]);
    expect(input[0].text).toContain("/runner/attachment-downloads/brief.pdf");
  });

  it("leaves ordinary native turns unchanged", () => {
    expect(runnerdPiLocalImagePaths([{ type: "text", text: "work" }], "codex")).toEqual([]);
  });

  it("preserves workspace-relative fallback staging paths for provider-local resolution", () => {
    expect(runnerdPiLocalImagePaths([{ type: "localImage", path: ".paperclip/attachments/staged.png" }], "pi_rpc"))
      .toEqual([".paperclip/attachments/staged.png"]);
  });

  it.each(["", "/runner/a\n.png", "/runner/a\0.png", `/${"a".repeat(4096)}`])("rejects invalid Runner path %j", path => {
    expect(() => runnerdPiLocalImagePaths([{ type: "localImage", path }], "pi_rpc")).toThrow("valid Runner path");
  });

  it("rejects more than 128 images and non-Pi typed image inputs", () => {
    const image = { type: "localImage", path: "/runner/screenshot.png" };
    expect(() => runnerdPiLocalImagePaths(Array(129).fill(image), "pi_rpc")).toThrow("at most 128");
    expect(() => runnerdPiLocalImagePaths([image], "codex")).toThrow("require Pi");
  });
});
