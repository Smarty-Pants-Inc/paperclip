-- Inert fixture still exercises the real namespace migration path.
CREATE TABLE plugin_conversation_guardian_11f4625e60.notes (
  company_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  note_comment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, comment_id, kind)
);
