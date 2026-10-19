CREATE TABLE domain.agreement (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 timezone text NOT NULL,
 created_by text NOT NULL REFERENCES auth."user"(id),
 created_by_tenant uuid NOT NULL REFERENCES domain.municipality(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE domain.agreement_version (
 agreement_id uuid NOT NULL REFERENCES domain.agreement(id),
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL DEFAULT 'BORRADOR' CHECK(status IN ('BORRADOR','APROBADO','ACTIVADO','SUSPENDIDO')),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 1 AND 2000),
 legal_basis text NOT NULL CHECK(length(btrim(legal_basis)) BETWEEN 1 AND 2000),
 responsibilities text NOT NULL CHECK(length(btrim(responsibilities)) BETWEEN 1 AND 2000),
 retention_policy text NOT NULL CHECK(length(btrim(retention_policy)) BETWEEN 1 AND 2000),
 eligibility text NOT NULL CHECK(eligibility IN ('acceso_abierto','acreditacion_vigente')),
 weekly_limit integer CHECK(weekly_limit>0),
 aggregate_reports boolean NOT NULL,
 legal_review_reference text,
 report_review_reference text,
 correlation_id uuid NOT NULL,
 created_by text NOT NULL REFERENCES auth."user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(agreement_id,version),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at)
);
CREATE TABLE domain.agreement_participant (
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 accreditation_issuer boolean NOT NULL,
 PRIMARY KEY(agreement_id,version,tenant_id),
 FOREIGN KEY(agreement_id,version) REFERENCES domain.agreement_version(agreement_id,version)
);
CREATE INDEX agreement_participant_tenant ON domain.agreement_participant(tenant_id,agreement_id,version);
CREATE TABLE domain.agreement_unit (
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 tenant_id uuid NOT NULL,
 unit_id uuid NOT NULL,
 PRIMARY KEY(agreement_id,version,tenant_id,unit_id),
 FOREIGN KEY(agreement_id,version,tenant_id) REFERENCES domain.agreement_participant(agreement_id,version,tenant_id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id)
);
ALTER TABLE domain.agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_version FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_participant FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_unit ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_maintenance ON domain.agreement TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_version_maintenance ON domain.agreement_version TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_participant_maintenance ON domain.agreement_participant TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_unit_maintenance ON domain.agreement_unit TO quenda_migrator USING(true) WITH CHECK(true);
ALTER TABLE domain.agreement_unit FORCE ROW LEVEL SECURITY;
CREATE FUNCTION domain.agreement_version_visible(agreement uuid,revision integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement
 AND (revision IS NULL OR p.version=revision) AND p.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid);
END $$;
REVOKE ALL ON FUNCTION domain.agreement_version_visible(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.agreement_version_visible(uuid,integer) TO quenda_domain;
CREATE POLICY agreement_read ON domain.agreement FOR SELECT TO quenda_domain USING(domain.agreement_version_visible(id,NULL));
CREATE POLICY agreement_version_read ON domain.agreement_version FOR SELECT TO quenda_domain USING(domain.agreement_version_visible(agreement_id,version));
CREATE POLICY agreement_participant_read ON domain.agreement_participant FOR SELECT TO quenda_domain USING(domain.agreement_version_visible(agreement_id,version));
CREATE POLICY agreement_unit_read ON domain.agreement_unit FOR SELECT TO quenda_domain USING(domain.agreement_version_visible(agreement_id,version));
GRANT SELECT ON domain.agreement,domain.agreement_version,domain.agreement_participant,domain.agreement_unit TO quenda_domain;
CREATE FUNCTION domain.create_agreement_draft(agreement uuid,input jsonb,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); participant jsonb; resource jsonb;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'participants') p WHERE (p->>'tenantId')::uuid=tenant) THEN
  RAISE EXCEPTION 'Creator must participate' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=input->>'timeZone') THEN
  RAISE EXCEPTION 'Invalid timezone' USING ERRCODE='23514';
 END IF;
 INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES(agreement,input->>'name',input->>'timeZone',actor,tenant);
 INSERT INTO domain.agreement_version(agreement_id,version,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id)
 VALUES(agreement,1,(input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,input->>'purpose',input->>'legalBasis',input->>'responsibilities',input->>'retentionPolicy',input->>'eligibility',(input->>'weeklyLimit')::integer,(input->>'aggregateReports')::boolean,actor,correlation);
 FOR participant IN SELECT value FROM jsonb_array_elements(input->'participants') LOOP
  INSERT INTO domain.agreement_participant(agreement_id,version,tenant_id,accreditation_issuer) VALUES(agreement,1,(participant->>'tenantId')::uuid,(participant->>'accreditationIssuer')::boolean);
  FOR resource IN SELECT value FROM jsonb_array_elements(participant->'unitIds') LOOP
   INSERT INTO domain.agreement_unit(agreement_id,version,tenant_id,unit_id) VALUES(agreement,1,(participant->>'tenantId')::uuid,(resource#>>'{}')::uuid);
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION domain.create_agreement_draft(uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.create_agreement_draft(uuid,jsonb,uuid) TO quenda_domain;
