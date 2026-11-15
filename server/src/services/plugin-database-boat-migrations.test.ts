import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import boatManifest from "../../../packages/plugins/sandbox-providers/boat/src/manifest.js";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
} from "./plugin-database.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const boatRoot = path.join(repoRoot, "packages/plugins/sandbox-providers/boat");

describe("Boat plugin database migrations", () => {
  it("uses the host-derived manifest namespace for every migration statement", async () => {
    const database = boatManifest.database;
    expect(database).toBeDefined();
    const namespace = derivePluginDatabaseNamespace(boatManifest.id, database?.namespaceSlug);
    const migrationDir = path.join(boatRoot, database?.migrationsDir ?? "migrations");
    const files = (await readdir(migrationDir)).filter(file => file.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const sql = await readFile(path.join(migrationDir, file), "utf8");
      for (const statement of sql.split(";").map(statement => statement.trim()).filter(Boolean)) {
        expect(() => validatePluginMigrationStatement(statement, namespace), `${file}: ${statement}`).not.toThrow();
      }
    }
  });
});
