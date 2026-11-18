import { describe, expect, it } from "vitest";
import { PiIdentityTombstones } from "./pi-identity-tombstones.js";

// Keep reason: trust boundary. A retired native identity must never acquire a
// later prompt's authority, even after the exact turn/projector is released.
describe("PiIdentityTombstones", () => {
  it("retains old identities without growing memory across 100000 retirements", () => {
    const tombstones = new PiIdentityTombstones();
    expect(tombstones.has("tool:first")).toBe(false);
    tombstones.add("tool:first");
    for (let i = 0; i < 100_000; i++) tombstones.add(`message:${i}`);
    expect(tombstones.byteLength).toBe(1024 * 1024);
    expect(tombstones.has("tool:first")).toBe(true);
    for (let i = 0; i < 100_000; i++) expect(tombstones.has(`message:${i}`)).toBe(true);
  });
});
