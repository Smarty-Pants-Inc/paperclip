import { expect, it } from "vitest";
import { githubCredentialEnvironment } from "./github-credential-environment.js";

it("carries the explicit runner-ingress selector to runnerd without admitting ambient values", () => {
  expect(githubCredentialEnvironment({
    PAPERCLIP_GITHUB_ACCESS_TRANSPORT: "runner_ingress",
  })).toEqual({
    PAPERCLIP_GITHUB_ACCESS_TRANSPORT: "runner_ingress",
  });
  expect(githubCredentialEnvironment({})).not.toHaveProperty("PAPERCLIP_GITHUB_ACCESS_TRANSPORT");
});
