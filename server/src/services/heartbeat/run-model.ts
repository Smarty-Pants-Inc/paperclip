import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { RunModel } from "@paperclipai/shared";

const savedModel = sql`${heartbeatRuns.runnerProfileJson} #> '{nativeExecutionInput,provider,model}'`;
const savedModelName = sql`${heartbeatRuns.runnerProfileJson} #>> '{nativeExecutionInput,provider,model}'`;

const reportedModel = sql`${heartbeatRuns.runnerProfileJson} #> '{providerResponseModel,name}'`;
const reportedModelName = sql`${heartbeatRuns.runnerProfileJson} #>> '{providerResponseModel,name}'`;

/**
 * The ingestion owner saves only response-origin Pi reports on this run.
 * Prefer the latest report, otherwise retain the immutable launch selection.
 * Both are scalar JSON reads: polling never scans the event history or reads
 * the agent's editable configuration. Old runs without a report stay launch-only.
 */
export const runModelColumn = sql<RunModel | null>`case
  when jsonb_typeof(${reportedModel}) = 'string' and ${reportedModelName} ~ '[^[:space:]]'
    then jsonb_build_object('name', ${reportedModelName}, 'source', 'provider')
  when jsonb_typeof(${savedModel}) = 'string' and ${savedModelName} ~ '[^[:space:]]'
    then jsonb_build_object('name', ${savedModelName}, 'source', 'launch')
  else null end`.as("runModel");
