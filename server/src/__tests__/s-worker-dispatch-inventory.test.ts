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

const startMethods = new Set([
  "environmentAcquireLease", "environmentResumeLease", "environmentRunnerIngressEndpoint",
  "environmentRealizeWorkspace", "environmentExecute", "environmentSyncIn", "environmentSyncOut", "environmentTask",
]);
function mayStart(node: Node | undefined): boolean {
  if (!node) return true;
  node = unwrap(node);
  if (node.type === "Literal") return startMethods.has(node.value);
  if (node.type === "ConditionalExpression") return mayStart(node.consequent) || mayStart(node.alternate);
  return true; // A dynamic method is not evidence that dispatch cannot start work.
}
function unwrap(node: Node): Node {
  return ["TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "ChainExpression", "ParenthesizedExpression", "AwaitExpression"].includes(node.type)
    ? unwrap(node.expression ?? node.argument) : node;
}

// File-local, monotone may-alias analysis: reassignment/shadowing never erases a
// possible worker origin. Follow bindings, not arbitrary identifiers in an RHS
// (the result of worker.call(), for example, is not another worker).
function dispatchAliases(ast: Node) {
  const handles = new Set<string>(), managers = new Set<string>();
  const handleProperties = new Set<string>(), managerProperties = new Set<string>();
  const managerTypes = new Set(["PluginWorkerManager"]), handleTypes = new Set(["PluginWorkerHandle"]);
  walk(ast, node => {
    if (node.type !== "ImportSpecifier") return;
    if (node.imported.name === "PluginWorkerManager") managerTypes.add(node.local.name);
    if (node.imported.name === "PluginWorkerHandle") handleTypes.add(node.local.name);
  });
  const hasType = (node: Node | undefined, types: Set<string>) => {
    let found = false;
    if (node) walk(node, part => {
      if (part.type === "TSTypeReference" && types.has(part.typeName.name)) found = true;
    });
    return found;
  };
  walk(ast, node => {
    if (node.type === "Identifier" && hasType(node.typeAnnotation, managerTypes)) managers.add(node.name);
    if (node.type === "Identifier" && hasType(node.typeAnnotation, handleTypes)) handles.add(node.name);
    if (node.type === "TSPropertySignature") {
      if (hasType(node.typeAnnotation, managerTypes)) managerProperties.add(node.key.name ?? node.key.value);
      if (hasType(node.typeAnnotation, handleTypes)) handleProperties.add(node.key.name ?? node.key.value);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && returnsHandle(node.init)) handles.add(node.id.name);
  });
  const refers = (node: Node | undefined, names: Set<string>, manager: boolean): boolean => {
    if (!node) return false;
    node = unwrap(node);
    if (node.type === "Identifier") return names.has(node.name);
    if (node.type === "ConditionalExpression") return refers(node.consequent, names, manager) || refers(node.alternate, names, manager);
    if (node.type === "LogicalExpression") return refers(node.left, names, manager) || refers(node.right, names, manager);
    if (node.type === "MemberExpression") return (manager ? managerProperties : handleProperties).has(node.computed ? node.property.value : node.property.name)
      || ["call", "openDuplexChannel", "openLoginPtySession"].some(name => member(node!, name)) && refers(node.object, names, manager);
    return manager
      ? node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "createPluginWorkerManager"
      : returnsHandle(node);
  };
  const addBindings = (pattern: Node, names: Set<string>) => {
    if (pattern.type === "Identifier") names.add(pattern.name);
    else if (pattern.type === "AssignmentPattern") addBindings(pattern.left, names);
    else if (pattern.type === "RestElement") addBindings(pattern.argument, names);
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach((p: Node) => addBindings(p.value ?? p.argument, names));
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach((p: Node | null) => { if (p) addBindings(p, names); });
  };
  const bind = (pattern: Node, value: Node | undefined, names: Set<string>, manager: boolean) => {
    if (value) value = unwrap(value);
    if (pattern.type === "Identifier") { if (refers(value, names, manager)) names.add(pattern.name); }
    else if (pattern.type === "AssignmentPattern") { bind(pattern.left, value, names, manager); bind(pattern.left, pattern.right, names, manager); }
    else if (pattern.type === "RestElement") bind(pattern.argument, value, names, manager);
    else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type === "RestElement") { bind(property.argument, value, names, manager); continue; }
        const key = property.key.name ?? property.key.value;
        const entry = value?.type === "ObjectExpression" ? value.properties.find((p: Node) => (p.key?.name ?? p.key?.value) === key) : undefined;
        // A destructured member escapes the handle too (notably { call: rpc }).
        bind(property.value, entry?.value ?? (refers(value, names, manager) ? value : undefined), names, manager);
        if ((manager ? managerProperties : handleProperties).has(key)) addBindings(property.value, names);
      }
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((part: Node | null, i: number) => {
        if (part) bind(part, value?.type === "ArrayExpression" ? value.elements[i] : value, names, manager);
      });
    }
  };
  let size: number;
  do {
    size = handles.size + managers.size;
    walk(ast, node => {
      const binding = node.type === "VariableDeclarator" ? [node.id, node.init]
        : node.type === "AssignmentExpression" && node.operator === "=" ? [node.left, node.right] : null;
      if (binding) { bind(binding[0], binding[1], handles, false); bind(binding[0], binding[1], managers, true); }
    });
  } while (handles.size + managers.size !== size);
  return { handles, isManager: (node: Node) => refers(node, managers, true) };
}

// Deliberately conservative: all handle-reference uses (including aliases and
// extraction/escaping) are inventoried, not merely literal getWorker().call().
// Any changed entry needs a source audit, never an automatic snapshot refresh.
function inventory(sources: Map<string, string>, rawManagers = false) {
  const result: string[] = [];
  for (const [file, source] of sources) {
    const parsed = parseSync(file, source);
    expect(parsed.errors, file).toEqual([]);
    const ast = parsed.program as unknown as Node;
    const { handles: aliases, isManager } = dispatchAliases(ast);
    const seen: string[] = [];
    const reference = (node: Node, parent: Node) => ["FunctionDeclaration", "TSInterfaceDeclaration", "VariableDeclarator"].includes(parent.type)
      ? `${parent.type} ${node.name}` : compact(source.slice(parent.start, parent.end));
    walk(ast, (node, parents) => {
      const parent = parents.at(-1);
      if (rawManagers) {
        if (node.type !== "CallExpression") return;
        const callee = unwrap(node.callee);
        const method = node.arguments[1];
        const literalStart = method?.type === "Literal" && startMethods.has(method.value);
        // Match the wire method regardless of receiver spelling/type. For typed
        // managers, a dynamic method or extracted call must also be audited.
        if (member(callee, "call") && (literalStart || isManager(callee.object) && mayStart(method))
          || callee.type === "Identifier" && isManager(callee)) {
          seen.push(`manager RPC: ${compact(source.slice(callee.start, callee.end))}(${node.arguments.slice(0, 2).map((arg: Node) => compact(source.slice(arg.start, arg.end))).join(", ")})`);
        }
        return;
      }
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
  it("has no new raw manager start/resume dispatch", () => {
    // Existing guarded sites only; preserve duplicates so another call at the
    // same spelling fails too. No snapshot refresh or file-wide exemptions.
    // environment-runtime:1816,2096,2202,2896,2973,3030,3178,3828,3847
    // and plugin-environment-driver:593,641,658 receive the fenced manager
    // built at environment-runtime:4126-4143 (wired at 4151-4163, 3910,3972,4002).
    // Its sole raw forwarding call is :4141, after assertLeaseStartable(:4136).
    // environment-task-runtime:235,237 (twice),240 gets that same manager at
    // environment-runtime:4335; :399,417 additionally pin fresh allocation
    // params at :392-398 in the existing fresh-allocation snapshot below.
    expect(inventory(sources, true)).toEqual([
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginId, "environmentExecute")',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginId, "environmentRealizeWorkspace")',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginId, "environmentResumeLease")',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginId, "environmentRunnerIngressEndpoint")',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginId, method)',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginProvider.resolved.plugin.id, "environmentAcquireLease")',
      'services/environment-runtime.ts: manager RPC: pluginWorkerManager.call(pluginProvider.resolved.plugin.id, "environmentResumeLease")',
      'services/environment-runtime.ts: manager RPC: workerManager.call(plugin.id, "environmentAcquireLease")',
      'services/environment-runtime.ts: manager RPC: workerManager.call(plugin.id, "environmentResumeLease")',
      'services/environment-runtime.ts: manager RPC: workers.call(pluginId, method)',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, "environmentAcquireLease")',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, "environmentAcquireLease")',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, method)',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, method)',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, method)',
      'services/environment-task-runtime.ts: manager RPC: workers.call(plugin.id, method)',
      'services/plugin-environment-driver.ts: manager RPC: input.workerManager.call(plugin.id, "environmentExecute")',
      'services/plugin-environment-driver.ts: manager RPC: input.workerManager.call(plugin.id, "environmentRealizeWorkspace")',
      'services/plugin-environment-driver.ts: manager RPC: input.workerManager.call(plugin.id, "environmentResumeLease")',
    ]);
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
  it("follows already-escaped handles and managers, including destructured and reassigned aliases", () => {
    for (const declaration of [
      "const escaped = worker;",
      "let escaped; escaped = worker;",
      "const first = worker; const escaped = first;",
      "const { worker: escaped } = { worker };",
      "const [escaped] = [worker];",
      "const { call: escaped } = worker;",
      "let escaped; ({ call: escaped } = worker);",
    ]) {
      for (const seed of ["const worker = manager.getWorker(id);", "let worker: PluginWorkerHandle;"]) {
        const setup = `${seed} ${declaration}`;
        const baseline = inventory(new Map([["services/probe.ts", setup]]));
        for (const call of ['escaped.call("environmentResumeLease", params);', 'escaped("environmentResumeLease", params);']) {
          expect(inventory(new Map([["services/probe.ts", `${setup} ${call}`]])), declaration).not.toEqual(baseline);
        }
      }
    }
    for (const method of startMethods) {
      expect(inventory(new Map([["services/probe.ts", `manager.call(id, "${method}", params);`]]), true)).toHaveLength(1);
    }
    for (const declaration of [
      "const escaped = manager;", "let escaped; escaped = manager;",
      "const first = manager; const escaped = first;",
      "const { manager: escaped } = { manager };", "const [escaped] = [manager];",
    ]) {
      const setup = `function probe(manager: PluginWorkerManager) { ${declaration}`;
      expect(inventory(new Map([["services/probe.ts", `${setup} escaped.call(id, method, params); }`]]), true), declaration).toHaveLength(1);
    }
    expect(inventory(new Map([["services/probe.ts", 'function probe(options: { workerManager: PluginWorkerManager }) { const { workerManager: escaped } = options; escaped.call(id, method, params); }']]), true)).toHaveLength(1);
    for (const declaration of ["const { call: rpc } = manager;", "let rpc; ({ call: rpc } = manager);", "const rpc = manager.call;"]) {
      expect(inventory(new Map([["services/probe.ts", `function probe(manager: PluginWorkerManager) { ${declaration} rpc(id, method, params); }`]]), true), declaration).toHaveLength(1);
    }
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
