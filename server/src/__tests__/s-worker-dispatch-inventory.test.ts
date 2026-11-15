import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
type Node = { type: string; start: number; end: number; [key: string]: any };
function walk(node: Node, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []) {
  visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walk(child, visit, [...parents, node]);
    } else if (value && typeof value === "object" && value.type) walk(value, visit, [...parents, node]);
  }
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "__tests__" || entry.name === "__fixtures__") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.ts$/.test(path) && !/\.(test|spec)\.ts$/.test(path) ? [path] : [];
  });
}
const compact = (source: string) => source.replace(/\s+/g, " ").trim();
const member = (node: Node, name: string) => node.type === "MemberExpression"
  && (node.computed ? node.property.value === name : node.property.name === name);
function returnsHandle(node: Node | undefined): boolean {
  if (!node) return false;
  if (["TSNonNullExpression", "TSAsExpression", "ChainExpression", "ParenthesizedExpression"].includes(node.type)) return returnsHandle(node.expression);
  if (node.type === "ConditionalExpression") return returnsHandle(node.consequent) || returnsHandle(node.alternate);
  return node.type === "CallExpression" && ["getWorker", "startWorker", "createPluginWorkerHandle"].some(name =>
    member(node.callee, name) || node.callee.type === "Identifier" && node.callee.name === name);
}

// Deliberately conservative: all handle-reference uses (including aliases and
// extraction/escaping) are inventoried, not merely literal getWorker().call().
// Any changed entry needs a source audit, never an automatic snapshot refresh.
function inventory(sources: Map<string, string>) {
  const result: string[] = [];
  for (const [file, source] of sources) {
    const parsed = parseSync(file, source);
    expect(parsed.errors, file).toEqual([]);
    const ast = parsed.program as unknown as Node;
    const aliases = new Set<string>();
    walk(ast, node => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && returnsHandle(node.init)) aliases.add(node.id.name);
    });
    const seen: string[] = [];
    const reference = (node: Node, parent: Node) => ["FunctionDeclaration", "TSInterfaceDeclaration", "VariableDeclarator"].includes(parent.type)
      ? `${parent.type} ${node.name}` : compact(source.slice(parent.start, parent.end));
    walk(ast, (node, parents) => {
      const parent = parents.at(-1);
      if (node.type === "Identifier" && aliases.has(node.name) && parent
        && !(parent.type === "MemberExpression" && parent.property === node && !parent.computed)) {
        seen.push(`handle reference: ${reference(node, parent)}`);
      }
      if (["getWorker", "startWorker", "openLoginPtySession", "openDuplexChannel"].some(name => member(node, name))) {
        seen.push(`boundary reference: ${compact(source.slice(node.start, node.end))}`);
      }
      if (node.type === "Identifier" && ["PluginWorkerHandle", "createPluginWorkerHandle"].includes(node.name) && parent) {
        seen.push(`handle type/factory: ${reference(node, parent)}`);
      }
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && ["callInternal", "callInternalRaw"].includes(node.callee.name)) {
        seen.push(`internal RPC: ${node.callee.name}(${compact(source.slice(node.arguments[0].start, node.arguments[0].end))})`);
      }
    });
    for (const entry of seen) result.push(`${file}: ${entry}`);
  }
  return result.sort();
}
const sources = new Map(files(root).map(path => [relative(root, path), readFileSync(path, "utf8")]));
const source = (file: string) => sources.get(`services/${file}.ts`)!;
function region(file: string, start: string, end: string) {
  const text = source(file), from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return compact(text.slice(from, to));
}

describe("S audited worker dispatch inventory", () => {
  it("has no new direct worker/handle/internal RPC boundary", () => {
    expect(inventory(sources)).toMatchSnapshot();
  });
  it("pins fresh allocation params, absence of reuse/resume keys, and rejection of the old task id", () => {
    expect(region("environment-task-runtime", "const params = { driverKey: replacementDriverKey", "const {runnerTaskIdentity:")).toMatchSnapshot();
    expect(source("environment-task-runtime")).toContain('Object.keys(params).some(key => /providerLeaseId|reuse|resume/i.test(key))');
    expect(source("environment-task-runtime")).toContain('throw new SandboxLeaseStartDeniedError()');
  });
  it("pins both login callers to the same fresh acquisition flow with reuse disabled", () => {
    expect(compact(source("adapter-login-lease"))).toMatchSnapshot();
    expect(region("device-login-service", "export function createWorkerBoundLoginPtyOpener(", "export interface ProductionLoginSessionRuntimeDeps")).toMatchSnapshot();
    expect(compact(source("device-login-service").slice(source("device-login-service").indexOf("export function createProductionLoginSessionRuntime(")))).toMatchSnapshot();
    expect(region("setup-token-transport-binding", "export function createProductionSetupTokenSandboxProvider(", "/** Builds the durable,")).toMatchSnapshot();
    expect(compact(source("setup-token-transport-binding").slice(source("setup-token-transport-binding").indexOf("export function createWorkerBoundLoginPtyOpener(")))).toMatchSnapshot();
    expect(source("device-login-service")).toContain('binding.providerLeaseId !== binding.lease.providerLeaseId');
    expect(source("setup-token-transport-binding")).toContain('providerLeaseId !== acquiredProviderLeaseId');
  });
  it("calls the same persisted FOR SHARE fence at manager.call and direct duplex", () => {
    expect(source("environment-runtime").match(/await assertLeaseStartable\(/g)).toHaveLength(2);
    expect(region("environment-runtime", "async function assertLeaseStartable(", "function createSandboxEnvironmentDriver(")).toMatchSnapshot();
    expect(region("environment-runtime", "    async openDuplexChannel(input)", "    async resolveCapabilities(input)")).toMatchSnapshot();
    expect(region("environment-runtime", "  const workers = options.pluginWorkerManager;", "  const environmentsSvc = environmentService(db);")).toMatchSnapshot();
  });
  it("detects a direct caller, alias, or extra internal opener (checker negative controls)", () => {
    const existing = 'const handle = manager.getWorker(id); handle.call("environmentAcquireLease", params);';
    const baseline = inventory(new Map([["services/probe.ts", existing]]));
    for (const addition of [
      'const worker = manager.getWorker(id); worker.call("environmentResumeLease", params);',
      'const worker = manager.getWorker(id); const escaped = worker; escaped.openDuplexChannel(params);',
      'callInternal("newSandboxOp", params);',
      'manager.openLoginPtySession(id, params);',
      'handle.call("environmentAcquireLease", params);', // even a duplicate at a new call site
    ]) expect(inventory(new Map([["services/probe.ts", `${existing}\n${addition}`]]))).not.toEqual(baseline);
  });
});
