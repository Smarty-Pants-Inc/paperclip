import { expect, it } from "vitest";
import { githubCredentialEnvironment } from "./github-credential-environment.js";

it("carries the runner-ingress selector and session capability to runnerd without admitting ambient values", () => {
  expect(githubCredentialEnvironment({
    PAPERCLIP_GITHUB_ACCESS_TRANSPORT: "runner_ingress",
    PAPERCLIP_GITHUB_BROKER_TOKEN: "session-capability",
    AMBIENT_SECRET: "must-not-cross",
  })).toEqual({
    PAPERCLIP_GITHUB_ACCESS_TRANSPORT: "runner_ingress",
    PAPERCLIP_GITHUB_BROKER_TOKEN: "session-capability",
  });
  expect(githubCredentialEnvironment({})).not.toHaveProperty("PAPERCLIP_GITHUB_ACCESS_TRANSPORT");
});
