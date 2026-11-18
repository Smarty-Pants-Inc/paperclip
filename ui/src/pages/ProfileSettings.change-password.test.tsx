// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

// Only the session read is stubbed. The password change goes through the real
// `authApi`, so the test sees the exact request the browser would send to
// Better Auth's documented endpoint (POST /api/auth/change-password,
// https://better-auth.com/docs/authentication/email-password#update-password).
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, getSession: mockGetSession } };
});

vi.mock("@/components/InboxAgentPolicyControl", () => ({ InboxAgentPolicyControl: () => null }));
vi.mock("@/api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_PASSWORD = "vault-generated-password";
const NEW_PASSWORD = "paul-chose-this-one";

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ProfileSettings change password", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGetSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Paul", email: "paul@example.com", image: null },
    });
    fetchMock = vi.fn(async () => jsonResponse(200, { token: "new-session-token", user: { id: "user-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ProfileSettings /></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();
  }

  function field(label: string): HTMLInputElement {
    const labelEl = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.trim() === label);
    expect(labelEl, `label "${label}"`).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>(`#${CSS.escape(labelEl!.htmlFor)}`);
    expect(input, `input for "${label}"`).toBeTruthy();
    return input!;
  }

  async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function fillAndSubmit(current: string, next: string, confirm: string) {
    await type(field("Current password"), current);
    await type(field("New password"), next);
    await type(field("Confirm new password"), confirm);
    const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes("Change password"));
    expect(button).toBeTruthy();
    await act(async () => {
      button!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
  }

  function changePasswordCalls() {
    return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/change-password"));
  }

  it("shows a Change password form with current, new and confirm fields", async () => {
    await renderPage();
    expect(Array.from(container.querySelectorAll("h2")).some((el) => el.textContent === "Change password")).toBe(true);
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      const input = field(label);
      expect(input.type).toBe("password");
    }
    expect(field("Current password").autocomplete).toBe("current-password");
    expect(field("New password").autocomplete).toBe("new-password");
  });

  it("calls the documented change-password endpoint with revokeOtherSessions on and keeps this session", async () => {
    await renderPage();
    await fillAndSubmit(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);

    const calls = changePasswordCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0]!;
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    // No sign-out: Better Auth replaces this browser's session cookie itself.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sign-out"))).toBe(false);

    expect(container.textContent).toContain("Password changed. Other devices were signed out.");
    expect(field("Current password").value).toBe("");
    expect(field("New password").value).toBe("");
    expect(field("Confirm new password").value).toBe("");
    // Still signed in on this page.
    expect(container.textContent).toContain("paul@example.com");
  });

  it("says plainly when the current password is wrong", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(400, { code: "INVALID_PASSWORD", message: "Invalid password" }));
    await renderPage();
    await fillAndSubmit("not-my-password", NEW_PASSWORD, NEW_PASSWORD);

    expect(changePasswordCalls()).toHaveLength(1);
    expect(container.textContent).toContain("Your current password is wrong.");
    expect(container.textContent).not.toContain("Password changed.");
    expect(container.textContent).not.toContain("INVALID_PASSWORD");
  });

  it.each([
    ["the confirmation does not match", OLD_PASSWORD, NEW_PASSWORD, "something-else-1", "The new passwords don't match."],
    ["the new password is the current one", OLD_PASSWORD, OLD_PASSWORD, OLD_PASSWORD, "Choose a new password that differs from your current one."],
    ["the new password is shorter than the auth rule", OLD_PASSWORD, "short", "short", "Use at least 8 characters."],
    ["the new password is longer than the auth rule", OLD_PASSWORD, "x".repeat(129), "x".repeat(129), "Use at most 128 characters."],
  ])("does not call the server when %s", async (_case, current, next, confirm, message) => {
    await renderPage();
    await fillAndSubmit(current, next, confirm);
    expect(changePasswordCalls()).toHaveLength(0);
    expect(container.textContent).toContain(message);
  });
});
