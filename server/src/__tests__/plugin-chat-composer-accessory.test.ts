import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { getPluginUiContributionMetadata } from "../services/plugin-loader.js";

// Keep this regression at the install/runtime boundary: accepting a manifest
// must not leave its composer contribution unregistrable at runtime (review F2).
const manifest: PaperclipPluginManifestV1 = {
  id: "example.chat-accessory",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Chat accessory",
  description: "An accessory above the chat composer",
  author: "Example",
  categories: ["ui"],
  capabilities: ["ui.action.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [{
      type: "chatComposerAccessory",
      id: "accessory",
      displayName: "Chat accessory",
      exportName: "ChatAccessory",
    }],
  },
};

const validator = pluginCapabilityValidator();

describe("chat composer accessory capability contract", () => {
  it("requires the same action capability as the adjacent toolbar slots", () => {
    expect(validator.getUiSlotCapability("chatComposerAccessory")).toBe("ui.action.register");
    expect(validator.getUiSlotCapability("chatComposerAccessory"))
      .toBe(validator.getUiSlotCapability("toolbarButton"));
  });

  it.each([
    ["action", ["ui.action.register"], true],
    ["unrelated issue read", ["issues.read"], false],
    ["unrelated sidebar", ["ui.sidebar.register"], false],
  ] as const)("agrees at install and runtime with %s capabilities", (_label, capabilities, allowed) => {
    const parsed = pluginManifestV1Schema.parse({ ...manifest, capabilities: [...capabilities] }) as PaperclipPluginManifestV1;
    const expected = { allowed, missing: allowed ? [] : ["ui.action.register"], pluginId: manifest.id };
    expect(validator.validateManifestCapabilities(parsed)).toMatchObject(expected);
    expect(validator.checkUiSlot(parsed, "chatComposerAccessory")).toEqual({
      ...expected,
      operation: "ui.chatComposerAccessory.register",
    });
  });

  it("rejects empty capabilities in the schema and in both capability checks", () => {
    const withoutCapabilities = { ...manifest, capabilities: [] };
    expect(pluginManifestV1Schema.safeParse(withoutCapabilities).success).toBe(false);
    expect(validator.validateManifestCapabilities(withoutCapabilities)).toMatchObject({
      allowed: false, missing: ["ui.action.register"],
    });
    expect(validator.checkUiSlot(withoutCapabilities, "chatComposerAccessory")).toMatchObject({
      allowed: false, missing: ["ui.action.register"],
    });
  });

  it("preserves the accepted slot through the contribution metadata used by the discovery route", () => {
    const parsed = pluginManifestV1Schema.parse(manifest) as PaperclipPluginManifestV1;
    expect(validator.validateManifestCapabilities(parsed).allowed).toBe(true);
    const contribution = getPluginUiContributionMetadata(parsed);
    expect(contribution).toEqual({ uiEntryFile: "index.js", slots: manifest.ui!.slots, launchers: [] });
    expect(validator.checkUiSlot(parsed, contribution!.slots[0]!.type).allowed).toBe(true);
    expect(getPluginUiContributionMetadata({ ...parsed, ui: undefined })).toBeNull();
  });
});
