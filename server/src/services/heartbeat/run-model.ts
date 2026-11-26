import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { RunModel } from "@paperclipai/shared";

const savedModel = sql`${heartbeatRuns.runnerProfileJson} #> '{nativeExecutionInput,provider,model}'`;
const savedModelName = sql`${heartbeatRuns.runnerProfileJson} #>> '{nativeExecutionInput,provider,model}'`;

/**
 * Project only the saved run selection, never the agent's editable config.
 * Session events currently lack a latest-session-event index: scanning a run's
 * event history on every presence poll is not acceptable. Until that lookup is
 * indexed, report launch provenance only, not a provider-confirmed identity.
 */
export const runModelColumn = sql<RunModel | null>`case
  when jsonb_typeof(${savedModel}) = 'string' and ${savedModelName} ~ '[^[:space:]]'
    then jsonb_build_object('name', ${savedModelName}, 'source', 'launch')
  else null end`.as("runModel");
