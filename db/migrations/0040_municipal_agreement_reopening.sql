CREATE TABLE domain.unit_agreement_release_event (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 unit_id uuid NOT NULL,
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(agreement_id,version,tenant_id,unit_id) REFERENCES domain.agreement_assignment(agreement_id,version,tenant_id,unit_id)
);
CREATE INDEX unit_agreement_release_event_unit ON domain.unit_agreement_release_event(tenant_id,unit_id,occurred_at);
ALTER TABLE domain.unit_agreement_release_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.unit_agreement_release_event FORCE ROW LEVEL SECURITY;
CREATE POLICY unit_agreement_release_maintenance ON domain.unit_agreement_release_event TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY unit_agreement_release_read ON domain.unit_agreement_release_event FOR SELECT TO quenda_domain
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_current_administrator());
GRANT SELECT ON domain.unit_agreement_release_event TO quenda_domain;

CREATE FUNCTION domain.read_unit_agreement_restriction(unit uuid)
RETURNS TABLE(agreement_id uuid,version integer,has_remaining_assignment boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.reservable_unit u WHERE u.tenant_id=tenant AND u.id=unit) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 RETURN QUERY SELECT g.agreement_id,g.version,EXISTS(SELECT 1 FROM domain.agreement_assignment a
  WHERE a.tenant_id=tenant AND a.unit_id=unit AND NOT isempty(a.effective_period) AND upper(a.effective_period)>clock_timestamp())
 FROM domain.unit_agreement_gate g WHERE g.tenant_id=tenant AND g.unit_id=unit;
END $$;
CREATE FUNCTION domain.release_unit_agreement_restriction(unit uuid,expected_agreement uuid,expected_version integer,reason text,correlation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 gate domain.unit_agreement_gate%ROWTYPE;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM domain.reservable_unit u WHERE u.tenant_id=tenant AND u.id=unit FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 SELECT g.* INTO gate FROM domain.unit_agreement_gate g WHERE g.tenant_id=tenant AND g.unit_id=unit FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF (gate.agreement_id,gate.version) IS DISTINCT FROM (expected_agreement,expected_version)
 OR EXISTS(SELECT 1 FROM domain.agreement_assignment a WHERE a.tenant_id=tenant AND a.unit_id=unit
  AND NOT isempty(a.effective_period) AND upper(a.effective_period)>clock_timestamp()) THEN
  RAISE EXCEPTION 'Agreement restriction cannot be removed' USING ERRCODE='23514';
 END IF;
 DELETE FROM domain.unit_agreement_gate WHERE tenant_id=tenant AND unit_id=unit;
 INSERT INTO domain.unit_agreement_release_event(tenant_id,id,unit_id,agreement_id,version,actor_id,reason,correlation_id)
 VALUES(tenant,gen_random_uuid(),unit,gate.agreement_id,gate.version,actor,btrim(reason),correlation);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.read_unit_agreement_restriction(uuid),domain.release_unit_agreement_restriction(uuid,uuid,integer,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.read_unit_agreement_restriction(uuid),domain.release_unit_agreement_restriction(uuid,uuid,integer,text,uuid) TO quenda_domain;
