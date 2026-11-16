-- DOWN for 0489_connector_runtime_company_lock.sql: restores the function bodies
-- of 0354_agent_connection_assignment_hooks.sql exactly. CREATE OR REPLACE only;
-- no rows are rewritten. Tested by connector-runtime-company-lock-migration.test.ts.
CREATE OR REPLACE FUNCTION paperclip_record_agent_runtime(p_company uuid, p_agent uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR NO KEY UPDATE;
  IF FOUND THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_invalidate_connector_company(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE setting text := 'paperclip.runtime_' || replace(p_company::text, '-', '_'); xid text := pg_current_xact_id()::text; candidate uuid;
BEGIN
  IF current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM paperclip_invalidate_connector_agent(p_company, candidate);
  END LOOP;
  PERFORM set_config(setting, xid, true);
END;
$$;
