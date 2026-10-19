ALTER TABLE domain.agreement ADD COLUMN latest_version integer NOT NULL DEFAULT 1 CHECK(latest_version>0);
UPDATE domain.agreement a SET latest_version=(SELECT max(v.version) FROM domain.agreement_version v WHERE v.agreement_id=a.id);
ALTER TABLE domain.agreement ADD CONSTRAINT agreement_latest_version_fk
 FOREIGN KEY(id,latest_version) REFERENCES domain.agreement_version(agreement_id,version) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION domain.create_agreement_version(agreement uuid,expected integer,input jsonb,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 latest integer; next_version integer; participant jsonb; resource jsonb;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=expected AND p.tenant_id=tenant) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR UPDATE;
 SELECT max(v.version) INTO latest FROM domain.agreement_version v WHERE v.agreement_id=agreement;
 IF expected IS DISTINCT FROM latest OR latest=2147483647 THEN
  RAISE EXCEPTION 'Version conflict' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'participants') p WHERE (p->>'tenantId')::uuid=tenant) THEN
  RAISE EXCEPTION 'Creator must participate' USING ERRCODE='23514';
 END IF;
 next_version:=latest+1;
 INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id)
 VALUES(agreement,next_version,(input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,input->>'purpose',input->>'legalBasis',input->>'responsibilities',input->>'retentionPolicy',input->>'eligibility',(input->>'weeklyLimit')::integer,(input->>'aggregateReports')::boolean,actor,correlation);
 FOR participant IN SELECT value FROM jsonb_array_elements(input->'participants') LOOP
  INSERT INTO domain.agreement_participant(agreement_id,version,tenant_id,accreditation_issuer)
  VALUES(agreement,next_version,(participant->>'tenantId')::uuid,(participant->>'accreditationIssuer')::boolean);
  FOR resource IN SELECT value FROM jsonb_array_elements(participant->'unitIds') LOOP
   INSERT INTO domain.agreement_unit(agreement_id,version,tenant_id,unit_id)
   VALUES(agreement,next_version,(participant->>'tenantId')::uuid,(resource#>>'{}')::uuid);
  END LOOP;
 END LOOP;
 UPDATE domain.agreement a SET latest_version=next_version WHERE a.id=agreement;
 RETURN next_version;
END $$;
REVOKE ALL ON FUNCTION domain.create_agreement_version(uuid,integer,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.create_agreement_version(uuid,integer,jsonb,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.approve_agreement(agreement uuid,revision integer,units uuid[],correlation uuid) RETURNS text
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
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR UPDATE;
 IF revision<>(SELECT max(v.version) FROM domain.agreement_version v WHERE v.agreement_id=agreement) THEN
  RAISE EXCEPTION 'Superseded version' USING ERRCODE='23514';
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
