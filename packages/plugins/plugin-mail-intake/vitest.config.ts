import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export default defineConfig({
  // The boundary test imports the actual host validator without installing the
  // entire server. Resolve its three runtime dependencies from this test package.
  resolve: { alias: Object.fromEntries(["ajv", "ajv-formats", "@paperclipai/shared"].map(name => [name, require.resolve(name)])) },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
