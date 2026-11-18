import { isNativeContinuationRefusal } from './native-continuation-refusal.js';
const prefix='Notification transport failed closed: runner_process_termination_unconfirmed: runnerd process supervision failed: ';
const cases=[
 ['non-supervision access denied',{error:prefix+'access denied'}],
 ['non-supervision ownership',{error:prefix+'runner_state_identity_mismatch: prior_owner_active'}],
 ['supervision exact live',{error:prefix+'Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)',errorCode:'notification_transport_failed'}],
 ['supervision then independent same-field owner',{error:prefix+'boat_command_possibly_ran: unavailable; runner_state_identity_mismatch: prior_owner_active'}],
 ['supervision then independent other-field owner',{error:prefix+'boat_command_possibly_ran: unavailable',errorCode:'runner_state_identity_mismatch: prior_owner_active'}],
 ['bare termination',{error:'runner_process_termination_unconfirmed'}],
 ['retained binding D10',{error:'native_controller_recovery_missing_evidence:retained_sandbox_binding'}],
 ['unsupported metadata D10',{error:'native_controller_recovery_unsupported:metadata_format'}],
 ['unsupported supervisor',{error:'native_controller_recovery_unsupported:supervisor_compatibility'}],
 ['cleanup quarantined',{error:'native_session_cleanup_quarantined'}],
 ['warm runner exited',{error:'native_runner_warm_attachment_runner_exited'}],
] as const;
for(const [name,run] of cases)console.log(JSON.stringify({name,run,refused:isNativeContinuationRefusal(run)}));
