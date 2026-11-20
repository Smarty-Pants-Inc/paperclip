-- paperclip:migration-compat online_compatible: Adds a presentation-only JSONB column with a constant default; old releases ignore it and existing preferences keep working.
-- Fork migration: a merge-down renumbers this file (byte-identical SQL body) if upstream ships its own 0489.
ALTER TABLE "user_workspace_preferences" ADD COLUMN "agent_reasoning_display" jsonb DEFAULT '{}'::jsonb NOT NULL;