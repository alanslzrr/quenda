CREATE TABLE domain.agreement_approval (
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 tenant_id uuid NOT NULL,
 approved_by text NOT NULL REFERENCES auth."user"(id),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL,
 PRIMARY KEY(agreement_id,version,tenant_id),
 FOREIGN KEY(agreement_id,version,tenant_id) REFERENCES domain.agreement_participant(agreement_id,version,tenant_id)
);
ALTER TABLE domain.agreement_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_approval_maintenance ON domain.agreement_approval TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_approval_read ON domain.agreement_approval FOR SELECT TO quenda_domain
 USING(domain.agreement_version_visible(agreement_id,version));
GRANT SELECT ON domain.agreement_approval TO quenda_domain;

CREATE FUNCTION domain.approve_agreement(agreement uuid,revision integer,units uuid[],correlation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_status text; expected_units uuid[];
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_participant p
  WHERE p.agreement_id=agreement AND p.version=revision AND p.tenant_id=tenant) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 SELECT v.status INTO current_status FROM domain.agreement_version v
 WHERE v.agreement_id=agreement AND v.version=revision FOR UPDATE;
 IF current_status NOT IN ('BORRADOR','APROBADO') THEN
  RAISE EXCEPTION 'Version cannot be approved' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(u.unit_id ORDER BY u.unit_id),ARRAY[]::uuid[]) INTO expected_units
 FROM domain.agreement_unit u WHERE u.agreement_id=agreement AND u.version=revision AND u.tenant_id=tenant;
 IF units IS NULL OR expected_units IS DISTINCT FROM ARRAY(SELECT unnest(units) ORDER BY 1) THEN
  RAISE EXCEPTION 'Approval must match participant units' USING ERRCODE='23514';
 END IF;
 INSERT INTO domain.agreement_approval(agreement_id,version,tenant_id,approved_by,correlation_id)
 VALUES(agreement,revision,tenant,actor,correlation) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(
  SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision
  AND NOT EXISTS(SELECT 1 FROM domain.agreement_approval a
   WHERE (a.agreement_id,a.version,a.tenant_id)=(p.agreement_id,p.version,p.tenant_id))
 ) THEN
  UPDATE domain.agreement_version SET status='APROBADO' WHERE agreement_id=agreement AND version=revision;
  current_status:='APROBADO';
 END IF;
 RETURN current_status;
END $$;
REVOKE ALL ON FUNCTION domain.approve_agreement(uuid,integer,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.approve_agreement(uuid,integer,uuid[],uuid) TO quenda_domain;
