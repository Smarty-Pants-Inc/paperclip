// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposerAccessoryHost } from "./ChatComposerAccessoryHost";
import { _resetPluginModuleLoader, registerPluginReactComponent, type ResolvedPluginSlot } from "@/plugins/slots";

const state = vi.hoisted(() => ({ slots: [] as ResolvedPluginSlot[], props: [] as unknown[] }));
vi.mock("@/plugins/slots", async original => ({
  ...await original<typeof import("@/plugins/slots")>(),
  usePluginSlots: () => ({ slots: state.slots }),
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => null } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const slot = (pluginKey: string, id: string, order = 0): ResolvedPluginSlot => ({
  type: "chatComposerAccessory", pluginId: pluginKey, pluginKey, id, order,
  displayName: `${pluginKey}/${id}`, exportName: id, pluginDisplayName: pluginKey, pluginVersion: "1",
});
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  state.slots = []; state.props = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(() => root.unmount()); container.remove(); client.clear(); _resetPluginModuleLoader(); vi.restoreAllMocks();
});
async function paint(children: React.ReactNode = <div>Built-in tray</div>) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ChatComposerAccessoryHost companyId="company" conversationIssueId="chat" agentId="smarty">{children}</ChatComposerAccessoryHost></QueryClientProvider>);
  });
}
const host = () => container.querySelector<HTMLElement>('[data-testid="chat-composer-accessory-host"]')!;
const primary = () => container.querySelector<HTMLElement>('[data-accessory-key]:not([hidden])');
function register(item: ResolvedPluginSlot) {
  registerPluginReactComponent(item.pluginKey, item.exportName, props => {
    state.props.push(props);
    return <div>{item.displayName}</div>;
  });
}
describe("Chat composer accessory arbitration", () => {
  it("adds no DOM wrapper or gap when its only contribution returns null", async () => {
    function Empty() { return null; }
    await paint(<Empty />);
    expect(container.childNodes).toHaveLength(0);
  });

  it("collapses for no rendered contribution and observes a tray becoming available or empty", async () => {
    function Empty() { return null; }
    await paint(<Empty />);
    expect(host()).toBeNull();
    expect(primary()).toBeNull();
    await paint();
    expect(host()).toBeNull();
    expect(container.textContent).toBe("Built-in tray");
    await paint(null);
    expect(container.childNodes).toHaveLength(0);
  });

  it("keeps the built-in first and exposes only one primary with deterministic plugin ordering", async () => {
    state.slots = [slot("z", "a", -1), slot("a", "z"), slot("a", "a"), slot("b", "a")];
    state.slots.forEach(register);
    await paint();
    expect(primary()?.textContent).toBe("Built-in tray");
    expect(container.querySelectorAll('[data-accessory-key]:not([hidden])')).toHaveLength(1);
    expect(host().textContent).toContain("+4");
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(select.options).map(option => option.text)).toEqual(["Tasks", "z/a", "a/a", "a/z", "b/a"]);
    await act(() => { select.value = JSON.stringify(["a", "a"]); select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(primary()?.textContent).toBe("a/a");
    expect(container.querySelectorAll('[data-accessory-key]:not([hidden])')).toHaveLength(1);
    expect(state.props.at(-1)).toEqual(expect.objectContaining({ context: {
      companyId: "company", conversationIssueId: "chat", agentId: "smarty", theme: "light", entityId: "chat", entityType: "issue",
    } }));
    expect(Object.keys(state.props.at(-1) as object).sort()).toEqual(["context", "slot"]);
  });

  it("omits absent, null and broken plugin output, retaining the working fallback", async () => {
    state.slots = [slot("absent", "a"), slot("broken", "a"), slot("empty", "a"), slot("good", "a")];
    registerPluginReactComponent("broken", "a", () => { throw new Error("broken contribution"); });
    registerPluginReactComponent("empty", "a", () => null);
    register(state.slots[3]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await paint(null);
    expect(primary()?.textContent).toBe("good/a");
    expect(container.querySelector("select")).toBeNull();
    state.slots = [];
    await paint(null);
    expect(host()).toBeNull();
  });

  it("switching accessories closes the previously expanded panel", async () => {
    function Tray() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(!open)}>Tray</button>{open ? createPortal(<div data-expanded-tray>Tasks panel</div>, document.body) : null}</>;
    }
    const item = slot("other", "accessory"); state.slots = [item]; register(item);
    await paint(<Tray />);
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector("[data-expanded-tray]")).not.toBeNull();
    await act(() => {
      const select = container.querySelector<HTMLSelectElement>("select")!;
      select.value = JSON.stringify(["other", "accessory"]); select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector("[data-expanded-tray]")).toBeNull();
    expect(primary()?.textContent).toBe("other/accessory");
  });
});
