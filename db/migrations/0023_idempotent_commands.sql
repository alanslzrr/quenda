CREATE TABLE domain.idempotent_command (
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 100),
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 200),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation,key),
 CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at)
);
CREATE INDEX idempotent_command_expiry ON domain.idempotent_command(expires_at);
ALTER TABLE domain.idempotent_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.idempotent_command FORCE ROW LEVEL SECURITY;
CREATE POLICY command_maintenance ON domain.idempotent_command TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY command_actor ON domain.idempotent_command TO quenda_domain
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),''))
 WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),''));
GRANT SELECT,INSERT ON domain.idempotent_command TO quenda_domain;
GRANT UPDATE(fingerprint,result,created_at,expires_at) ON domain.idempotent_command TO quenda_domain;
CREATE FUNCTION domain.check_command_result() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM domain.idempotent_command c WHERE
  (c.tenant_id,c.actor_id,c.operation,c.key)=(NEW.tenant_id,NEW.actor_id,NEW.operation,NEW.key) AND c.result IS NULL) THEN
  RAISE EXCEPTION 'Incomplete command result' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.check_command_result() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER command_result_complete AFTER INSERT OR UPDATE ON domain.idempotent_command
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_command_result();
