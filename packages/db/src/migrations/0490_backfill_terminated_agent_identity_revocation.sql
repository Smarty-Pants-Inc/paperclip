-- paperclip:migration-compat online_compatible: Only marks retained keys of already-terminated agents; nullable revocation metadata is additive and existing runtimes keep working. The selective join uses the agent primary key and updates at most one identity row per terminated agent.
UPDATE "agent_identity_keys" AS k
SET "revoked_at" = now()
FROM "agents" AS a
WHERE a."id" = k."agent_id"
  AND a."company_id" = k."company_id"
  AND a."status" = 'terminated'
  AND k."revoked_at" IS NULL;
