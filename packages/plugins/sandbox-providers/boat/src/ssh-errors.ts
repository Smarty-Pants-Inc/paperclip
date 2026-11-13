export type BoatDuplexErrorCode = "BOAT_SSH_DISABLED" | "BOAT_SSH_PREPARE_FAILED" | "BOAT_SSH_HOST_KEY_MISMATCH"
  | "BOAT_SSH_CONNECT_FAILED" | "BOAT_SSH_SESSION_LOST" | "BOAT_SSH_INPUT_LIMIT" | "BOAT_SSH_OUTPUT_LIMIT"
  | "BOAT_SSH_PREFLIGHT_FAILED" | "BOAT_SSH_RETIRE_FAILED" | "BOAT_SSH_RETIRE_PENDING" | "BOAT_SSH_CLOSED" | "BOAT_SSH_ROUTE_LIMIT"
  | "BOAT_SSH_LEASE_UNBOUND" | "BOAT_SSH_RUNNER_MISMATCH" | "BOAT_SSH_COMMAND_REFUSED";
/** Body-free errors: SSH stderr and guardian stdin never become RPC diagnostics. */
export class BoatDuplexError extends Error {
  constructor(readonly code: BoatDuplexErrorCode) { super(code); this.name = "BoatDuplexError"; }
}
