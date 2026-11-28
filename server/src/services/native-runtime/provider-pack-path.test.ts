import { describe, expect, it } from "vitest";
import { providerPackPathForEnvironment } from "./provider-pack-path.js";

const MAP = "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH_BY_ENVIRONMENT";
const GLOBAL = "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH";

describe("providerPackPathForEnvironment (Smarty seam: a provider pack per environment)", () => {
  it("keeps the server's pack when no map is set or the environment is not in it", () => {
    expect(providerPackPathForEnvironment("env-a", { [GLOBAL]: "/srv/provider-pack/p98" })).toBe("/srv/provider-pack/p98");
    expect(providerPackPathForEnvironment("env-b", { [GLOBAL]: "/srv/provider-pack/p98", [MAP]: JSON.stringify({ "env-a": "/srv/provider-pack/p124" }) }))
      .toBe("/srv/provider-pack/p98");
    expect(providerPackPathForEnvironment(null, { [GLOBAL]: "/srv/provider-pack/p98", [MAP]: JSON.stringify({ "env-a": "/srv/provider-pack/p124" }) }))
      .toBe("/srv/provider-pack/p98");
    expect(providerPackPathForEnvironment("env-a", {})).toBeUndefined();
  });

  it("gives a mapped environment its own pack", () => {
    expect(providerPackPathForEnvironment("env-a", { [GLOBAL]: "/srv/provider-pack/p98", [MAP]: JSON.stringify({ "env-a": " /srv/provider-pack/p124 " }) }))
      .toBe("/srv/provider-pack/p124");
  });

  it("matches own keys only, never inherited ones", () => {
    const env = { [GLOBAL]: "/srv/provider-pack/p98", [MAP]: JSON.stringify({ "env-a": "/srv/provider-pack/p124" }) };
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(providerPackPathForEnvironment(id, env)).toBe("/srv/provider-pack/p98");
  });

  it("fails closed on a broken map, for every environment, never falling back to the server's pack", () => {
    for (const raw of ["not json", "[]", "null", "\"/srv/p\"", JSON.stringify({ "env-a": "" }), JSON.stringify({ "env-a": "relative/pack" }),
      JSON.stringify({ "env-a": 7 }), JSON.stringify({ "env-a": "/ok", "env-b": "relative" })]) {
      for (const id of ["env-a", "env-z", null]) {
        expect(() => providerPackPathForEnvironment(id, { [GLOBAL]: "/srv/provider-pack/p98", [MAP]: raw }), `${raw} / ${id}`)
          .toThrow("must map environment ids to absolute pack paths");
      }
    }
  });
});
