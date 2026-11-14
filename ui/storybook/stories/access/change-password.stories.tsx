import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ProfileSettings } from "@/pages/ProfileSettings";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const FIXTURE_CURRENT_PASSWORD = "vault-generated-password";
const meta = {
  id: "feature-change-password",
  title: "Getting started and access/Login, invitations, and access/Change password",
  component: ProfileSettings,
  parameters: {
    layout: "padded",
    paperclip: {
      "capabilities": [
        "access/login",
        "navigation-preferences/profile"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Settings > Profile Change password form: validation, wrong current password and success. It calls Better Auth's documented POST /api/auth/change-password with revokeOtherSessions true; the real password change and session revocation are covered by the server integration test."
    },
  },
  beforeEach: ({ parameters }) => {
    return prepareFixtureApi(
      [
        { path: "/api/auth/get-session", read: () => storybookAuthSession },
        {
          path: /\/users\/me\/inbox-agent-policy$/,
          read: () => ({ companyId: "company-storybook", userId: storybookAuthSession.user.id, mode: "disabled", allowedAgentIds: [], materialized: false, createdAt: null, updatedAt: null }),
        },
        {
          path: "/api/auth/change-password",
          method: "POST",
          read: ({ body }) =>
            body.currentPassword === FIXTURE_CURRENT_PASSWORD
              ? { token: "fixture-only", user: storybookAuthSession.user }
              : Response.json({ code: "INVALID_PASSWORD", message: "Invalid password" }, { status: 400 }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof ProfileSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
async function fill(canvasElement: HTMLElement, current: string, next: string, confirm: string) {
  const c = within(canvasElement);
  await userEvent.type(await c.findByLabelText("Current password"), current);
  await userEvent.type(c.getByLabelText("New password"), next);
  await userEvent.type(c.getByLabelText("Confirm new password"), confirm);
  await userEvent.click(c.getByRole("button", { name: "Change password" }));
  return c;
}
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", { name: "Change password" });
  },
};
export const Changed: Story = {
  play: async ({ canvasElement }) => {
    const c = await fill(canvasElement, FIXTURE_CURRENT_PASSWORD, "owner-chosen-password", "owner-chosen-password");
    await expect(await c.findByText("Password changed. Other devices were signed out.")).toBeVisible();
  },
};
export const WrongCurrentPassword: Story = {
  play: async ({ canvasElement }) => {
    const c = await fill(canvasElement, "not-my-password", "owner-chosen-password", "owner-chosen-password");
    await expect(await c.findByText("Your current password is wrong.")).toBeVisible();
  },
};
export const ConfirmationMismatch: Story = {
  play: async ({ canvasElement }) => {
    const c = await fill(canvasElement, FIXTURE_CURRENT_PASSWORD, "owner-chosen-password", "owner-chosen-passwrd");
    await expect(await c.findByText("The new passwords don't match.")).toBeVisible();
  },
};
