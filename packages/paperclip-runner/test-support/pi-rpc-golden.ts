import { createPiEventProjector, type PiProjectedEvent } from "../src/drivers/pi/pi-event-projector.js";

/** Recording replay only; production driver must supply its own admitted identity. */
export function projectPiRecording(wire: Record<string, unknown>[], fenced = false): PiProjectedEvent[] {
  if (fenced) {
    // No client prompt/turn grant exists. The recorder sends clear_queue+abort
    // at this boundary. Unauthorized provider output cannot enter a run. This
    // fixture-journal diagnostic belongs to turn-0, not an admitted prompt.
    return wire.filter(event => event.type === "agent_start").map(() => ({ runId: "pi-capture", turnId: "turn-0", eventType: "harness.diagnostic", payload: { code: "pi_unrequested_agent_start_fenced", providerMethod: "agent_start" } }));
  }
  let turn = 0, settled = true;
  let projector = createPiEventProjector({ runId: "pi-capture", turnId: "turn-0" });
  return wire.flatMap(event => {
    if (event.type === "agent_start" && settled) { projector = createPiEventProjector({ runId: "pi-capture", turnId: `turn-${++turn}` }); settled = false; }
    const output = projector.project(event);
    if (event.type === "agent_settled") settled = true;
    return output;
  });
}
