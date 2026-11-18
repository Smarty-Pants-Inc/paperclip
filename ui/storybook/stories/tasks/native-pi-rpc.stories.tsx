import { useState } from "react";
import { storybookAgents } from "../../fixtures/paperclipData";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Agent } from "@paperclipai/shared";
import { TaskChatRunnerTurn } from "@/components/task-chat/TaskChatRunnerTurn";
import { ComposerRunSettingsPicker } from "@/components/task-chat/ComposerRunSettingsPicker";
import type { ComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { transcriptToTaskChatItems } from "@/components/task-chat/transcript-adapter";
import { nativeRunEventsToTranscript } from "@/components/transcript/native-run-events";
import { captureTs, interruptedTerminal, piPersisted, piRpcGoldens } from "@/components/transcript/fixtures/pi-rpc-goldens";

function RecordedTranscript({ scenario }: { scenario: string }) {
  const events = piRpcGoldens[scenario];
  const turns = [...new Set(events.map(event => event.turnId).filter(Boolean))];
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 text-foreground">
    <header className="flex flex-col gap-2">
      <h1 className="text-lg font-semibold">Native Pi · {scenario}</h1>
      <p className="text-sm text-muted-foreground">Recorded Pi 1.5.2 RPC against a controlled HTTP peer. Production task-chat renderer; not a live company conversation.</p>
      {scenario === "abort" ? <p className="text-xs text-muted-foreground">Stopped status and terminal receipt are explicitly simulated driver authority. The capture itself does not settle a Paperclip run.</p> : null}
    </header>
    {turns.map(turnId => {
      const turnEvents = events.filter(event => event.turnId === turnId);
      if (scenario === "abort") turnEvents.push(interruptedTerminal);
      const items = transcriptToTaskChatItems(nativeRunEventsToTranscript(piPersisted(turnEvents)), { runId: `pi-${scenario}-${turnId}`, agentName: "Pi", running: false });
      return <TaskChatRunnerTurn key={turnId} runId={`pi-${scenario}-${turnId}`} agentName="Pi" agentIcon="pi"
        items={items} status={scenario === "abort" ? "cancelled" : "succeeded"}
        startedAtMs={Date.parse(captureTs)} finishedAtMs={Date.parse(captureTs) + 2000} />;
    })}
  </main>;
}

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function PiEffortPicker({ modelCase }: { modelCase: "gpt" | "claude" | "off" }) {
  const row = modelCase === "gpt"
    ? { id: "openai/gpt-6-astra", label: "GPT-6 Astra", thinkingLevels: [...levels] }
    : modelCase === "claude"
      // Deliberately over-advertise: the production policy must still remove max.
      ? { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", thinkingLevels: [...levels] }
      : { id: "neutral/nonreasoning", label: "Nonreasoning model", thinkingLevels: ["off"] };
  const agent: Agent = { ...storybookAgents[0], id: "pi-rpc", companyId: "storybook", name: "Pi", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: row.id }, defaultEnvironmentId: null };
  const [settings, setSettings] = useState<ComposerRunSettings | null>({ model: row.id, effort: modelCase === "off" ? "off" : "high", fast: false });
  return <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-6 p-6 text-foreground">
    <header className="flex flex-col gap-2">
      <h1 className="text-lg font-semibold">Pi RPC · {modelCase === "off" ? "off-only model" : modelCase} thinking</h1>
      <p className="text-sm text-muted-foreground">Production composer picker with a fixed, mocked model catalog. No model discovery or agent execution.</p>
    </header>
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
      <textarea aria-label="Message" placeholder="Message Pi…" rows={2} className="w-full resize-none bg-transparent text-base outline-none" />
      <div className="flex justify-end">
        <ComposerRunSettingsPicker companyId="storybook-pi-wave2" assigneeValue="agent:pi-rpc" currentAssigneeValue="agent:pi-rpc"
          options={[{ id: "agent:pi-rpc", label: "Pi" }]} agents={new Map([[agent.id, agent]])}
          settings={settings} onSettingsChange={setSettings} onAssigneeChange={() => {}}
          modelOptionsOverride={[row]} initialOpen initialView="settings" />
      </div>
    </div>
  </main>;
}

const meta = {
  id: "tasks-native-pi-rpc",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/Native Pi RPC recordings",
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["tasks/discussion", "runs-adapters/runs"], status: "current", implementation: "production", boundary: "fixtures",
      notes: "Immutable normalized real Pi 1.5.2 controlled-peer recordings through nativeRunEventsToTranscript and transcriptToTaskChatItems into TaskChatRunnerTurn, as used by TaskChatThread. Historical run status/timing are story fixtures, not projector authority. Abort adds an explicitly simulated driver terminal. Picker catalogs are mocked. Extension golden is fenced; queued user messages and opted-out thinking are not in these goldens. No live workflow or production-driver acceptance claimed.",
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Baseline: Story = { render: () => <RecordedTranscript scenario="baseline" /> };
export const Abort: Story = { render: () => <RecordedTranscript scenario="abort" /> };
export const Compaction: Story = { render: () => <RecordedTranscript scenario="compaction" /> };
export const Retry: Story = { render: () => <RecordedTranscript scenario="retry" /> };
export const GptThinking: Story = { render: () => <PiEffortPicker modelCase="gpt" /> };
export const ClaudeThinking: Story = { render: () => <PiEffortPicker modelCase="claude" /> };
export const OffOnlyThinking: Story = { render: () => <PiEffortPicker modelCase="off" /> };
