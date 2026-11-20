import { beforeAll } from "vitest";

/**
 * Loads a mocked module graph one time for the enclosing `describe` block,
 * not one time for each test.
 *
 * A per-test `vi.resetModules()` plus a per-test `vi.importActual` (or a
 * dynamic `import()`) forces Node to transform and evaluate the module
 * graph again on every test. This work is synchronous and CPU-bound. Under
 * CPU load, one re-import can take seconds instead of milliseconds and
 * stall a test past its timeout.
 *
 * A route module graph does not need a fresh import for test isolation.
 * `vi.hoisted` mocks keep a stable identity across tests. Each test can
 * still re-arm mock behavior in its own `beforeEach`. Register the module
 * mocks one time. Import the graph one time in `beforeAll`. Reuse the
 * result for every test in the block.
 *
 * Read `.value` only inside a test body. It throws before `beforeAll` runs.
 */
/**
 * The budget of the one-time graph load. A route graph is most of the server,
 * transformed and evaluated in this hook. Measured for the agents routes
 * (agent-instructions-routes.test.ts) on an idle 32-core host: 11.5 s in
 * `loadGraph` (`../middleware/index.js` 9.5 s, then `../routes/agents.js`
 * 2.0 s), against 0.2 s for all 27 tests after it. The default 30 s hook
 * budget is only 2.6 times that. A loaded host crosses it, and vitest then
 * reports every test of the file as skipped: none runs (rf-3,
 * smarty-dev#20787). Like the embedded-Postgres boot hooks, this hook
 * therefore carries its own budget: ten times the measured load.
 */
export const MODULE_GRAPH_LOAD_TIMEOUT_MS = 120_000;

export function hoistModuleGraph<T>(
  registerMocks: () => void,
  loadGraph: () => Promise<T>,
): { readonly value: T } {
  let graph: T | undefined;

  beforeAll(async () => {
    registerMocks();
    graph = await loadGraph();
  }, MODULE_GRAPH_LOAD_TIMEOUT_MS);

  return {
    get value(): T {
      if (graph === undefined) {
        throw new Error("module graph is not loaded yet — read .value inside a test");
      }
      return graph;
    },
  };
}
