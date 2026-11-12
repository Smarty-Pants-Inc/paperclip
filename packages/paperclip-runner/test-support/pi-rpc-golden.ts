import { createPiEventProjector, type PiProjectedEvent } from "../src/drivers/pi/pi-event-projector.js";

/** Recording replay only; production driver must supply its own admitted identity. */
export function projectPiRecording(wire: Record<string, unknown>[], fenced = false): (PiProjectedEvent & { turnId?: string })[] {
  if (fenced) {
    // No client prompt/turn grant exists. The recorder sends clear_queue+abort
    // at this boundary. Unauthorized provider output cannot enter a run.
    return wire.filter(event => event.type === "agent_start").map(() => ({ eventType: "harness.diagnostic", payload: { code: "pi_unrequested_agent_start_fenced", providerMethod: "agent_start" } }));
  }
  let turn = 0, settled = true;
  let projector = createPiEventProjector({ turnId: "turn-0" });
  return wire.flatMap(event => {
    if (event.type === "agent_start" && settled) { projector = createPiEventProjector({ turnId: `turn-${++turn}` }); settled = false; }
    const output = projector.project(event).map(projected => ({ turnId: `turn-${turn}`, ...projected }));
    if (event.type === "agent_settled") settled = true;
    return output;
  });
}
