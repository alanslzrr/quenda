-- NULL is the platform scope, never a wildcard. Only a current operator can
-- access its own municipality-creation receipt in that scope.
ALTER TABLE domain.idempotent_command DROP CONSTRAINT idempotent_command_pkey;
ALTER TABLE domain.idempotent_command ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE domain.idempotent_command ADD CONSTRAINT idempotent_command_scope UNIQUE NULLS NOT DISTINCT(actor_id,operation,key,tenant_id);
ALTER TABLE domain.idempotent_command ADD CHECK(tenant_id IS NOT NULL OR operation='municipality.create');
CREATE INDEX idempotent_command_tenant_operation ON domain.idempotent_command(tenant_id,operation);
ALTER POLICY command_actor ON domain.idempotent_command
 USING(tenant_id IS NOT DISTINCT FROM nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND actor_id=nullif(current_setting('quenda.account_id',true),'')
  AND (tenant_id IS NOT NULL OR domain.lock_current_operator()))
 WITH CHECK(tenant_id IS NOT DISTINCT FROM nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND actor_id=nullif(current_setting('quenda.account_id',true),'')
  AND (tenant_id IS NOT NULL OR domain.lock_current_operator()));
CREATE OR REPLACE FUNCTION domain.check_command_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM domain.idempotent_command c WHERE
  c.actor_id=NEW.actor_id AND c.operation=NEW.operation AND c.key=NEW.key
  AND c.tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND c.result IS NULL) THEN
  RAISE EXCEPTION 'Incomplete command result' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION domain.purge_expired_idempotent_commands(batch integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
 IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
 WITH expired AS (
  SELECT c.ctid FROM domain.idempotent_command c
  WHERE c.expires_at<=clock_timestamp() ORDER BY c.expires_at LIMIT batch FOR UPDATE SKIP LOCKED
 ) DELETE FROM domain.idempotent_command c USING expired e WHERE c.ctid=e.ctid;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
