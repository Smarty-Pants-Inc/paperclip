-- Namespace = derivePluginDatabaseNamespace('smarty.screen-capture', 'screen_capture').
-- Documented path: doc/plugins/PLUGIN_AUTHORING_GUIDE.md, Plugin database declarations.
CREATE TABLE plugin_screen_capture_fab5263148.capture_claims (
  wake_comment_id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  author_user_id text NOT NULL,
  conversation_id uuid NOT NULL,
  checked_newest_unanswered boolean NOT NULL CHECK (checked_newest_unanswered),
  read_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  in_flight boolean NOT NULL DEFAULT true,
  outcome text NOT NULL DEFAULT 'claimed',
  reason text NOT NULL DEFAULT 'eligible',
  invocation_source text,
  wake_reason text,
  wake_source text,
  frame_sha256 text CHECK (frame_sha256 IS NULL OR frame_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX capture_claims_one_in_flight_per_run
  ON plugin_screen_capture_fab5263148.capture_claims (company_id, run_id) WHERE in_flight;

CREATE TABLE plugin_screen_capture_fab5263148.capture_log (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  wake_comment_id text,
  author_user_id text,
  responsible_user_id text,
  conversation_id uuid,
  attempted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome text NOT NULL,
  reason text NOT NULL,
  invocation_source text,
  wake_reason text,
  wake_source text,
  frame_sha256 text CHECK (frame_sha256 IS NULL OR frame_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX capture_log_company_run
  ON plugin_screen_capture_fab5263148.capture_log (company_id, run_id, attempted_at);

-- Every core join and correlated read is tied to r.company_id. No comment body,
-- context_snapshot, presentation object, name or credential is exposed.
CREATE VIEW plugin_screen_capture_fab5263148.capture_facts AS
SELECT r.company_id, r.id AS run_id, r.agent_id, r.status AS run_status,
  r.issue_id AS conversation_id, r.responsible_user_id,
  r.invocation_source,
  r.context_snapshot->>'wakeCommentId' AS wake_comment_id,
  r.context_snapshot->>'wakeReason' AS wake_reason,
  COALESCE(r.context_snapshot->>'wakeSource', r.context_snapshot->>'source') AS wake_source,
  a.id AS existing_agent_id,
  i.conversation_user_id, i.conversation_agent_id,
  c.id AS existing_comment_id, c.issue_id AS message_conversation_id,
  c.author_user_id, c.author_agent_id, c.author_type AS message_kind,
  c.created_at AS message_created_at, (c.deleted_at IS NOT NULL) AS message_deleted,
  (c.author_type = 'system' OR COALESCE(c.presentation->>'kind', '') = 'system_notice') AS system_note,
  EXISTS (
    SELECT 1 FROM public.issue_comments newer
    WHERE newer.company_id = r.company_id AND newer.issue_id = i.id
      AND newer.deleted_at IS NULL AND newer.author_user_id IS NOT NULL
      AND newer.author_agent_id IS NULL
      AND COALESCE(newer.author_type, 'user') <> 'system'
      AND COALESCE(newer.presentation->>'kind', '') <> 'system_notice'
      AND newer.created_at > c.created_at
  ) AS has_newer_person,
  EXISTS (
    SELECT 1 FROM public.issue_comments answer
    WHERE answer.company_id = r.company_id AND answer.issue_id = i.id
      AND answer.deleted_at IS NULL AND answer.author_agent_id IS NOT NULL
      AND COALESCE(answer.author_type, 'agent') <> 'system'
      AND COALESCE(answer.presentation->>'kind', '') <> 'system_notice'
      AND answer.created_at > c.created_at
  ) AS has_later_agent
FROM public.heartbeat_runs r
LEFT JOIN public.agents a ON a.id = r.agent_id AND a.company_id = r.company_id
LEFT JOIN public.issues i ON i.id = r.issue_id AND i.company_id = r.company_id
LEFT JOIN public.issue_comments c ON c.id::text = r.context_snapshot->>'wakeCommentId'
  AND c.company_id = r.company_id;
