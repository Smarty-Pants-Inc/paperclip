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
