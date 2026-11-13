import { describe, expect, it } from "vitest";
import { remoteCommandArgv, remoteCommandEnvironment } from "./remote-command-environment.js";

// Keep reason: REG-12 bootstrap ran before the Pi-specific cache policy existed.
describe("remote command compile-cache policy", () => {
  it("covers missing env and canonicalizes every caller-supplied disable value", () => {
    expect(remoteCommandEnvironment()).toEqual({ NODE_DISABLE_COMPILE_CACHE: "1" });
    for (const value of ["", "0", "1"]) {
      const input = { NODE_DISABLE_COMPILE_CACHE: value, NODE_COMPILE_CACHE: "/tmp/node-compile-cache", CUSTOM: "retained" };
      expect(remoteCommandEnvironment(input)).toEqual({ ...input, NODE_DISABLE_COMPILE_CACHE: "1" });
      expect(input.NODE_DISABLE_COMPILE_CACHE).toBe(value);
    }
  });

  it("rejects empty duplex commands rather than printing the inherited environment", () => {
    for (const input of [[], [""]]) expect(() => remoteCommandArgv(input)).toThrow("must not be empty");
  });

  it("does not reinterpret duplex command arguments or mutate the input", () => {
    const input = ["/path with spaces/node", "-e", "process.stdout.write('literal $HOME; &')"];
    expect(remoteCommandArgv(input)).toEqual(["env", "NODE_DISABLE_COMPILE_CACHE=1", ...input]);
    expect(input[0]).toBe("/path with spaces/node");
  });
});
