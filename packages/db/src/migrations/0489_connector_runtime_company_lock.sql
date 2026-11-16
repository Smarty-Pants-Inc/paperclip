-- paperclip:migration-compat online_compatible: CREATE OR REPLACE keeps every existing function's name, arguments and return type, and the triggers are unchanged; the only addition is the new function paperclip_lock_runtime_agents. The previous release calls the same functions and writes the same revision rows (each agent once per transaction), now ordered by one company advisory lock instead of an agent row scan, and it was observed running on the migrated schema (RFL src9). No table is rewritten and no data is touched, so no lock is held long.
-- #20805: company-wide connector runtime invalidation takes ONE company lock
-- instead of a FOR NO KEY UPDATE scan of every active agent row. The scan joined
-- deadlock cycles with any transaction that already held one agent row (a hirer).
-- Same agents, same revision rows, same per-transaction de-duplication.
--
-- Per-resource commit order (server/src/services/plugin-lifecycle-inbox.ts) still
-- holds: a per-agent writer keeps its agent row lock and then holds the company
-- lock SHARED until commit; a company-wide invalidation holds it EXCLUSIVE until
-- commit. So no agent_runtime revision of one agent can commit out of id order.
-- Lock order: agent rows, then the company runtime lock. Callers that lock an
-- agent row after a company-wide write take the exclusive lock first
-- (server/src/services/agent-runtime-lock.ts).
-- Rollback: packages/db/src/migration-rollbacks/0489_connector_runtime_company_lock.down.sql
CREATE OR REPLACE FUNCTION paperclip_record_agent_runtime(p_company uuid, p_agent uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR NO KEY UPDATE;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('paperclip.connector_runtime:' || p_company::text, 0));
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_connector_company(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE setting text := 'paperclip.runtime_' || replace(p_company::text, '-', '_'); xid text := pg_current_xact_id()::text;
  candidate uuid; agent_setting text;
BEGIN
  IF current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('paperclip.connector_runtime:' || p_company::text, 0));
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id LOOP
    agent_setting := 'paperclip.runtime_agent_' || replace(candidate::text, '-', '_');
    IF current_setting(agent_setting, true) IS DISTINCT FROM xid THEN
      INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
        VALUES (p_company, 'agent_runtime', candidate, 'update');
      PERFORM set_config(agent_setting, xid, true);
    END IF;
  END LOOP;
  PERFORM set_config(setting, xid, true);
END;
$$;
--> statement-breakpoint
-- #20805 R2 (src8): multi-agent fanouts lock every agent row first, then the shared
-- company hold. Before this, a PL/pgSQL FOR loop locked rows while it recorded
-- (cursor batches), so it held the shared lock and then waited for another agent
-- row; a hire holding that row and waiting for the exclusive lock deadlocked.
-- Same candidate sets, same order, same revision rows.
CREATE OR REPLACE FUNCTION paperclip_lock_runtime_agents(p_agents uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Rows first: the agent rows a statement will record, in id order, before its
  -- first shared company hold. Skips companies this transaction already
  -- invalidated (their agents are not recorded again).
  PERFORM 1 FROM agents WHERE id = ANY(coalesce(p_agents, '{}'::uuid[]))
    AND status NOT IN ('pending_approval', 'terminated')
    AND current_setting('paperclip.runtime_' || replace(company_id::text, '-', '_'), true) IS DISTINCT FROM pg_current_xact_id()::text
    ORDER BY id FOR NO KEY UPDATE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_company_agent_runtimes(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOREACH candidate IN ARRAY ARRAY(SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE) LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_skill_source_runtimes(p_company uuid, sources uuid[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOREACH candidate IN ARRAY ARRAY(SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND (paperclip_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug)
          OR paperclip_environment_selects_runtime_skill(p_company, a.default_environment_id, s.id)))
    ORDER BY a.id FOR NO KEY UPDATE) LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_skill_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOREACH candidate IN ARRAY ARRAY(SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'paperclip_runner' AND keys && ARRAY['paperclipai/paperclip/paperclip', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box']) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{paperclipSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{paperclipSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys))
      OR paperclip_environment_selects_runtime_skill(company, a.default_environment_id, coalesce((current->>'id')::uuid, (previous->>'id')::uuid)))
    ORDER BY a.id FOR NO KEY UPDATE) LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_environment_runtimes_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; candidate record;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'plugin_company_settings' THEN
    IF coalesce((previous->>'enabled')::boolean, true) IS NOT DISTINCT FROM coalesce((current->>'enabled')::boolean, true) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (CASE TG_TABLE_NAME
    WHEN 'environments' THEN previous->'config' IS NOT DISTINCT FROM current->'config' AND previous->'driver' IS NOT DISTINCT FROM current->'driver'
    WHEN 'plugins' THEN previous->'manifest_json' IS NOT DISTINCT FROM current->'manifest_json' AND previous->'status' IS NOT DISTINCT FROM current->'status'
    ELSE previous->'default_environment_id' IS NOT DISTINCT FROM current->'default_environment_id' END) THEN RETURN NEW; END IF;
  FOR candidate IN SELECT locked.id, locked.company_id FROM agents locked WHERE locked.id = ANY(ARRAY(SELECT a.id FROM agents a
    WHERE a.status NOT IN ('pending_approval', 'terminated') AND (CASE TG_TABLE_NAME
      WHEN 'environments' THEN coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
        = coalesce((current->>'id')::uuid, (previous->>'id')::uuid)
      WHEN 'plugins' THEN EXISTS (SELECT 1 FROM environments e
        WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
          AND e.driver = 'plugin' AND e.config->>'pluginKey' = coalesce(current->>'plugin_key', previous->>'plugin_key'))
      WHEN 'plugin_company_settings' THEN a.company_id = coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid)
        AND EXISTS (SELECT 1 FROM environments e JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
          WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
            AND e.driver = 'plugin' AND p.id = coalesce((current->>'plugin_id')::uuid, (previous->>'plugin_id')::uuid))
      ELSE a.default_environment_id IS NULL END)
    ORDER BY a.company_id, a.id FOR NO KEY UPDATE OF a)) ORDER BY locked.company_id, locked.id LOOP
    PERFORM paperclip_record_agent_runtime(candidate.company_id, candidate.id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_connector_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid; query text; target record; binding record; candidate uuid; agent_ids uuid[];
  old_projection text := '(to_jsonb(o) - $1)'; new_projection text := '(to_jsonb(n) - $1)';
  ignored text[] := ARRAY['updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_seen_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_TABLE_NAME = 'tool_profiles' AND TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'connection_grant_delegations' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, agent_id FROM new_rows ORDER BY company_id, agent_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, agent_id FROM old_rows ORDER BY company_id, agent_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, (target->>''agent_id'')::uuid AS agent_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, agent_id';
    END IF;
    EXECUTE 'SELECT array_agg(a.id) FROM (' || query || ') q JOIN agents a ON a.company_id = q.company_id AND a.id = q.agent_id'
      INTO agent_ids USING ignored;
    PERFORM paperclip_lock_runtime_agents(agent_ids);
    FOR binding IN EXECUTE query USING ignored LOOP
      PERFORM paperclip_invalidate_connector_agent(binding.company_id, binding.agent_id);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'company_secret_bindings' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM new_rows ORDER BY company_id, target_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM old_rows ORDER BY company_id, target_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, target->>''target_type'' AS target_type, target->>''target_id'' AS target_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, target_id';
    END IF;
    EXECUTE 'SELECT array_agg(a.id) FROM (' || query || ') q JOIN agents a ON a.company_id = q.company_id AND a.id::text = q.target_id
      WHERE q.target_type = ''agent''' INTO agent_ids USING ignored;
    PERFORM paperclip_lock_runtime_agents(agent_ids);
    FOR binding IN EXECUTE query USING ignored LOOP
      IF binding.target_type = 'agent' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = binding.company_id AND id::text = binding.target_id;
        IF FOUND THEN PERFORM paperclip_record_agent_runtime(binding.company_id, candidate); END IF;
      ELSE PERFORM paperclip_invalidate_connector_company(binding.company_id);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'connection_grants' THEN
    old_projection := old_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''
      #- ''{provider_tenant,github,accessRevision}'' #- ''{provider_tenant,github,lastAccessRefreshAt}'' #- ''{provider_tenant,github,bindingSync}'' #- ''{provider_tenant,github,continuityRetry}''';
    new_projection := new_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''
      #- ''{provider_tenant,github,accessRevision}'' #- ''{provider_tenant,github,lastAccessRefreshAt}'' #- ''{provider_tenant,github,bindingSync}'' #- ''{provider_tenant,github,continuityRetry}''';
  END IF;
  IF TG_TABLE_NAME = 'tool_policies' THEN
    old_projection := old_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
    new_projection := new_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
  END IF;
  IF TG_TABLE_NAME IN ('tool_profile_bindings', 'tool_connection_installs', 'tool_profile_entries', 'tool_policies') THEN
    IF TG_TABLE_NAME IN ('tool_profile_entries', 'tool_policies') THEN
      IF TG_OP = 'INSERT' THEN query := 'SELECT to_jsonb(n) AS row_data FROM new_rows n';
      ELSIF TG_OP = 'DELETE' THEN query := 'SELECT to_jsonb(o) AS row_data FROM old_rows o';
      ELSE query := format('WITH changed AS (
        SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
        WHERE %s IS DISTINCT FROM %s)
        SELECT previous AS row_data FROM changed WHERE previous IS NOT NULL UNION
        SELECT current AS row_data FROM changed WHERE current IS NOT NULL', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
      END IF;
      IF TG_TABLE_NAME = 'tool_profile_entries' THEN
        query := 'SELECT b.company_id, b.target_type, b.target_id FROM (' || query || ') changed
          JOIN tool_profile_bindings b ON b.company_id = (row_data->>''company_id'')::uuid
          AND b.profile_id = (row_data->>''profile_id'')::uuid';
      ELSE
        query := 'SELECT (row_data->>''company_id'')::uuid AS company_id, t.target_type, t.target_id
          FROM (' || query || ') changed CROSS JOIN LATERAL
          paperclip_connector_policy_targets((row_data->>''company_id'')::uuid, row_data->''selectors'') t';
      END IF;
    ELSIF TG_OP = 'INSERT' THEN query := 'SELECT company_id, target_type, target_id FROM new_rows';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT company_id, target_type, target_id FROM old_rows';
    ELSE query := format('WITH changed AS (
      SELECT o.company_id AS old_company, o.target_type AS old_type, o.target_id AS old_target,
        n.company_id AS new_company, n.target_type AS new_type, n.target_id AS new_target
      FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I WHERE %s IS DISTINCT FROM %s)
      SELECT old_company AS company_id, old_type AS target_type, old_target AS target_id FROM changed WHERE old_company IS NOT NULL UNION
      SELECT new_company AS company_id, new_type AS target_type, new_target AS target_id FROM changed WHERE new_company IS NOT NULL',
      TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
    END IF;
    EXECUTE 'SELECT array_agg(a.id) FROM (' || query || ') q JOIN agents a ON a.company_id = q.company_id AND a.id::text = lower(q.target_id)
      WHERE q.target_type = ''agent''' INTO agent_ids USING ignored;
    PERFORM paperclip_lock_runtime_agents(agent_ids);
    FOR target IN EXECUTE 'SELECT DISTINCT company_id, target_type, target_id FROM (' || query || ') targets
      WHERE target_type IN (''agent'', ''company'')
      ORDER BY company_id, target_type DESC, target_id' USING ignored LOOP
      IF target.target_type = 'company' AND target.target_id = target.company_id::text THEN
        PERFORM paperclip_invalidate_connector_company(target.company_id);
      ELSIF target.target_type = 'agent' AND target.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = target.company_id AND id = target.target_id::uuid;
        IF FOUND THEN PERFORM paperclip_invalidate_connector_agent(target.company_id, candidate); END IF;
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id FROM new_rows ORDER BY company_id';
  ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id FROM old_rows ORDER BY company_id';
  ELSE query := format('WITH changed AS (
    SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
    WHERE %s IS DISTINCT FROM %s)
    SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
    SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
  END IF;
  FOR company IN EXECUTE query USING ignored LOOP
    PERFORM paperclip_invalidate_connector_company(company);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- #20805 R2 (src11, review-fleet-4 F1a/F1b): the agent file-event revision is a
-- STATEMENT-level AFTER INSERT trigger on activity_log (as the connector trigger
-- is). The row-level BEFORE trigger took the shared company hold for row 1 and
-- then took agent rows after it: the activity row's own agent_id FK key share
-- (the RI check runs after the BEFORE trigger) and a later row's target. Now
-- every RI key share has run (AFTER ROW, before this trigger), then every file
-- event's target agent row is locked in id order, then each revision is recorded
-- (shared hold) and written into its activity row. Same events, same revision
-- rows in row order, same details key.
CREATE OR REPLACE FUNCTION paperclip_agent_runtime_files_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE event record; revision bigint;
BEGIN
  PERFORM paperclip_lock_runtime_agents(ARRAY(SELECT n.entity_id::uuid FROM new_rows n
    WHERE n.entity_type = 'agent' AND n.action IN ('agent.files_updated', 'agent.instructions_path_updated',
      'agent.instructions_bundle_updated', 'agent.instructions_file_updated', 'agent.instructions_file_deleted', 'plugin.managed_agent.reset')));
  FOR event IN SELECT n.id, n.company_id, n.entity_id::uuid AS agent_id FROM new_rows n
    WHERE n.entity_type = 'agent' AND n.action IN ('agent.files_updated', 'agent.instructions_path_updated',
      'agent.instructions_bundle_updated', 'agent.instructions_file_updated', 'agent.instructions_file_deleted', 'plugin.managed_agent.reset') LOOP
    revision := paperclip_record_agent_runtime(event.company_id, event.agent_id);
    UPDATE activity_log SET details = coalesce(details, '{}'::jsonb) || jsonb_build_object('agentRuntimeRevision', revision::text)
      WHERE id = event.id;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_runtime_files_changed ON activity_log;
CREATE TRIGGER paperclip_agent_runtime_files_changed AFTER INSERT ON activity_log
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_agent_runtime_files_changed();
--> statement-breakpoint
-- #20805 R2 (src11, review-fleet-4 F1c): an agents row's existing manager
-- (reports_to) takes its FK key share in a BEFORE ROW trigger, while the
-- statement's rows are written and before any AFTER ROW runtime record
-- (paperclip_agent_runtime_changed) takes the shared company hold. Before this, in
-- a multi-row agents INSERT the RI check of a later row took the manager's key
-- share after an earlier row's runtime record held the shared lock. The RI
-- check then finds the key share already held. Same rows, same revisions.
CREATE OR REPLACE FUNCTION paperclip_agent_runtime_lock_manager() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM agents WHERE id = NEW.reports_to FOR KEY SHARE;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_runtime_lock_manager_insert ON agents;
CREATE TRIGGER paperclip_agent_runtime_lock_manager_insert BEFORE INSERT ON agents
  FOR EACH ROW WHEN (NEW.reports_to IS NOT NULL) EXECUTE FUNCTION paperclip_agent_runtime_lock_manager();
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_runtime_lock_manager_update ON agents;
CREATE TRIGGER paperclip_agent_runtime_lock_manager_update BEFORE UPDATE OF reports_to ON agents
  FOR EACH ROW WHEN (NEW.reports_to IS NOT NULL AND NEW.reports_to IS DISTINCT FROM OLD.reports_to)
  EXECUTE FUNCTION paperclip_agent_runtime_lock_manager();
--> statement-breakpoint
-- #20805 R2 (src11, review-fleet-4 F1d): the instance-wide skill-pin fanout locks
-- every candidate agent row of EVERY company first (company, then id order, as
-- paperclip_environment_runtimes_changed does), then fans out company by company.
-- Before this it held the shared hold of each earlier company while it waited for
-- a later company's agent row. Same companies, same order, same revision rows.
CREATE OR REPLACE FUNCTION paperclip_skill_pins_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid;
BEGIN
  IF coalesce(OLD.experimental->'enableBetaSkills', 'false'::jsonb) IS DISTINCT FROM coalesce(NEW.experimental->'enableBetaSkills', 'false'::jsonb) THEN
    PERFORM 1 FROM agents WHERE status NOT IN ('pending_approval', 'terminated') ORDER BY company_id, id FOR NO KEY UPDATE;
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM paperclip_invalidate_company_agent_runtimes(company);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
