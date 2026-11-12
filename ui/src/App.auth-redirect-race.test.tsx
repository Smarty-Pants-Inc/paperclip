// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function RootRedirect() {
  const location = useLocation();
  return <Navigate key={location.key} to="/PAP/dashboard" replace />;
}

function Race() {
  const navigate = useNavigate();
  return <button onClick={() => {
    navigate("/PAP/dashboard", { replace: true });
    navigate("/", { replace: true });
  }}>Trigger race</button>;
}

function AtLocation() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe("root company redirect navigation race", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    document.body.innerHTML = "";
  });

  it("re-runs the root redirect after a replacement navigation creates a new history entry", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<><RootRedirect /><Race /></>} />
          <Route path="/PAP/dashboard" element={<AtLocation />} />
        </Routes>
      </MemoryRouter>,
    ));
    await act(async () => {
      container.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/PAP/dashboard");
  });
});
