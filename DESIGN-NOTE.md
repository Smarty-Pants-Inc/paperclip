# Inline reasoning display

- **One place decides.** "Reasoning display: Folded / Inline" lives on the agent's page (Harness / Runtime → Display). It is the
  signed-in person's own preference for that agent, saved on the server, so it applies to every chat with the agent on
  every browser and device. There is no per-chat switch and no per-browser value: the old
  `paperclip:task-chat:reasoning-display:v1` localStorage key is no longer read or written.
- **Resolution, per run:** the person's preference for the run's agent, else the adapter's declared default
  (`transcriptPresentation.liveReasoningView === "inline"`), else Folded. See `ui/src/components/task-chat/reasoning-display.ts`.
- **Storage:** `user_workspace_preferences.agent_reasoning_display` (jsonb map of agent id → `fold` | `inline`), written through
  `PUT /api/companies/:companyId/workspace-preferences/me` with `{ agentReasoningDisplay: { agentId, display } }`
  (`display: null` clears it). The route checks the agent belongs to that company with a read only. The agent record
  (adapterConfig, runtimeConfig, updatedAt), its config revisions and its provider sessions are never touched, so a save
  is not an agent-configuration change and starts no fresh thread (#20303).
- **Look:** reasoning text is italic and a step quieter than the reply in both themes. Bodies use the muted tier;
  headlines sit between it and the reply colour (`color-mix(in oklab, var(--foreground) 72%, var(--muted-foreground))`) so
  they still lead. Emphasis inside reasoning flips upright. The rules are one marked block in `ui/src/index.css`
  (`reasoning-look:start` … `reasoning-look:end`) on the existing hooks (`.task-chat-reasoning-markdown`,
  `.task-chat-reasoning-headline`); no new markup. Inline reasoning keeps its fully outlined neutral surface; no one-edge
  accent stripe.
- **Upstream:** paperclipai/paperclip master (f33db357f7) has no reasoning display preference to adopt; its adapters only
  declare `liveReasoningView` (`ticker` | `scrollLog`).
- **Tests:** unit tests for the look, the resolution order, the agent-page setting and the absence of the switch and the
  old key; server tests proving the agent row, revisions and sessions are unchanged by a save; a Playwright spec
  (`tests/e2e/reasoning-display.spec.ts`) with a seeded Codex run transcript holding real reasoning items, at 1440 and
  390, light and dark, that sets the preference on the agent page and opens the chat in fresh browser contexts.
