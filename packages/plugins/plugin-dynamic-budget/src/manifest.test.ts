import {describe,it,expect} from 'vitest';
import {pluginManifestV1Schema} from '../../../shared/dist/validators/plugin.js';
import {readdirSync} from 'node:fs';
import manifest from './manifest.js';
describe('pinned host manifest acceptance',()=>{
  it('passes the actual host schema for declared read-only core tables',()=>{
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(manifest.database?.coreReadTables).toEqual(['cost_events','heartbeat_runs']);
    expect(manifest.capabilities).not.toContain('database.namespace.write');
  });
  it('requires own-namespace migration capability even without any SQL files',()=>{
    expect(pluginManifestV1Schema.safeParse({...manifest,capabilities:manifest.capabilities.filter(c=>c!=='database.namespace.migrate')}).success).toBe(false);
    expect(readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql'))).toEqual([]);
  });
});
