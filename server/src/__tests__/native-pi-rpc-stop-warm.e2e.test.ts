import { it } from "vitest";
import { stopWarmProof } from "./native-pi-stop.fixture.js";

// Shared real server/DB/runnerd/proxy/Pi fixture; REG-03's actions and assertions
// remain unchanged. Matrix cells live in native-pi-rpc-stop-matrix.e2e.test.ts.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";
const thinking = process.env.PAPERCLIP_PI_E2E_THINKING_LEVEL ?? "xhigh";

it.skipIf(!enabled).each([1, 2, 3])(`Stop in turn %s mid-bash keeps the same resident/session and assistant history (thinking=${thinking})`,
  stopTurn => stopWarmProof(stopTurn), 600_000);

it.skipIf(!enabled)(`REG-03: a Stop, a killed retained runnerd, then a plain message resumes the same session on a new runner (thinking=${thinking})`,
  () => stopWarmProof(1, true), 600_000);
