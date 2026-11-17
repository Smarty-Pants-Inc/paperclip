export const NAMESPACE = 'plugin_screen_capture_fab5263148';

// $1-$3 are ONLY host ToolRunContext; $4-$6 are ONLY BOARD-set config.
// Reused verbatim in the claim and in its read-only refusal classifier.
const eligibility = `CASE
  WHEN $1::uuid <> $6::uuid THEN 'cross_company'
  WHEN f.run_id IS NULL THEN 'run_not_found_in_company'
  WHEN f.existing_agent_id IS NULL OR f.agent_id <> $3::uuid OR $3::uuid <> $5::uuid THEN 'not_primary'
  WHEN f.responsible_user_id IS DISTINCT FROM $4::text THEN 'not_paul'
  WHEN f.run_status <> 'running' THEN 'run_not_running'
  WHEN f.conversation_user_id IS DISTINCT FROM $4::text
    OR f.conversation_agent_id IS DISTINCT FROM $3::uuid THEN 'not_this_conversation'
  WHEN NULLIF(f.wake_comment_id, '') IS NULL THEN 'no_person_message'
  WHEN f.existing_comment_id IS NULL THEN 'missing_message'
  WHEN f.message_conversation_id IS DISTINCT FROM (f.conversation_id) THEN 'not_this_conversation'
  WHEN f.message_deleted THEN 'deleted'
  WHEN f.author_user_id IS DISTINCT FROM $4::text OR f.author_agent_id IS NOT NULL
    OR f.message_kind = 'agent' OR f.system_note IS TRUE THEN 'not_paul'
  WHEN f.has_newer_person OR f.has_later_agent THEN 'not_newest_unanswered'
  ELSE 'eligible' END`;

const facts = `FROM (SELECT 1) scope
LEFT JOIN ${NAMESPACE}.capture_facts f
  ON f.company_id = $1::uuid AND f.run_id = $2::uuid
CROSS JOIN LATERAL (SELECT ${eligibility} AS reason) decision`;

export const READ_FACTS = `SELECT f.*, decision.reason,
  EXISTS (SELECT 1 FROM ${NAMESPACE}.capture_claims used
    WHERE used.company_id = $1::uuid AND used.wake_comment_id = f.existing_comment_id) AS already_used,
  EXISTS (SELECT 1 FROM ${NAMESPACE}.capture_claims active
    WHERE active.company_id = $1::uuid AND active.run_id = $2::uuid AND active.in_flight) AS in_flight
${facts}`;

// ONE implicit PostgreSQL transaction: read fresh policy facts and atomically
// reserve the message (PK) and in-flight run (partial unique index).
export const CLAIM = `INSERT INTO ${NAMESPACE}.capture_claims
(wake_comment_id, attempt_id, company_id, run_id, agent_id, author_user_id,
 conversation_id, checked_newest_unanswered, read_at, expires_at,
 invocation_source, wake_reason, wake_source)
SELECT f.existing_comment_id, $7::uuid, f.company_id, f.run_id, f.agent_id,
 f.author_user_id, f.conversation_id, true, statement_timestamp(),
 statement_timestamp() + interval '120 seconds', f.invocation_source, f.wake_reason, f.wake_source
${facts}
WHERE decision.reason = 'eligible' AND f.company_id = $1::uuid
ON CONFLICT DO NOTHING`;

export const START_LOG = `INSERT INTO ${NAMESPACE}.capture_log
(id, company_id, run_id, agent_id, outcome, reason)
VALUES ($1, $2, $3, $4, 'pending', 'checking')`;

export const UPDATE_LOG = `UPDATE ${NAMESPACE}.capture_log SET
 wake_comment_id=$1, author_user_id=$2, responsible_user_id=$3, conversation_id=$4,
 invocation_source=$5, wake_reason=$6, wake_source=$7, outcome=$8, reason=$9
WHERE id=$10 AND company_id=$11 AND run_id=$12 AND agent_id=$13`;

export const FINISH_CLAIM = `UPDATE ${NAMESPACE}.capture_claims SET
 in_flight=false, outcome=$1, reason=$2
WHERE attempt_id=$3 AND company_id=$4 AND run_id=$5 AND agent_id=$6`;

export const READ_CLAIM = `SELECT wake_comment_id::text, author_user_id,
 conversation_id, read_at, expires_at
FROM ${NAMESPACE}.capture_claims
WHERE attempt_id=$1 AND company_id=$2 AND run_id=$3 AND agent_id=$4`;
