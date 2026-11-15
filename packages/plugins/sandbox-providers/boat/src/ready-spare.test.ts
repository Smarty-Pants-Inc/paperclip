import { describe, expect, it } from "vitest";
import manifest from "./manifest.js";

describe("Boat ready spare", () => {
  it("exposes a company-scoped bounded spare count, disabled by default", () => {
    expect(manifest.instanceConfigSchema).toMatchObject({
      type: "object",
      properties: {
        spares: { type: "integer", minimum: 0, maximum: 3, default: 0 },
      },
    });
  });
});
