CREATE TABLE domain.agreement_credential (
 id uuid PRIMARY KEY,
 agreement_id uuid NOT NULL,
 issued_version integer NOT NULL,
 issuer_tenant_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 verification_reference text NOT NULL CHECK(length(btrim(verification_reference)) BETWEEN 1 AND 500),
 issued_by text NOT NULL REFERENCES auth."user"(id),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL,
 revoked_at timestamptz,
 revoked_by text REFERENCES auth."user"(id),
 revocation_reason text CHECK(length(btrim(revocation_reason)) BETWEEN 1 AND 500),
 revocation_correlation_id uuid,
 FOREIGN KEY(agreement_id,issued_version,issuer_tenant_id) REFERENCES domain.agreement_participant(agreement_id,version,tenant_id),
 FOREIGN KEY(agreement_id,subject_id) REFERENCES domain.agreement_subject(agreement_id,id),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at),
 CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL AND revocation_correlation_id IS NULL)
  OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL AND revocation_correlation_id IS NOT NULL))
);
CREATE INDEX agreement_credential_subject ON domain.agreement_credential(agreement_id,subject_id,starts_at,ends_at) WHERE revoked_at IS NULL;
CREATE INDEX agreement_credential_issuer ON domain.agreement_credential(issuer_tenant_id,id);
ALTER TABLE domain.agreement_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_credential_maintenance ON domain.agreement_credential TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.agreement_credential FROM PUBLIC,quenda_domain,quenda_auth;

CREATE FUNCTION domain.issue_agreement_credential(credential uuid,agreement uuid,revision integer,account text,starts timestamptz,ends timestamptz,reference text,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); subject uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision AND p.tenant_id=tenant AND p.accreditation_issuer) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR SHARE;
 PERFORM 1 FROM domain.agreement_version v WHERE v.agreement_id=agreement AND v.version=revision
 AND v.status='ACTIVADO' AND v.eligibility='acreditacion_vigente' AND v.starts_at<=clock_timestamp() AND v.ends_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inactive agreement version' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM domain.municipal_profile p WHERE p.tenant_id=tenant AND p.account_id=account FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES(agreement,gen_random_uuid(),account) ON CONFLICT(agreement_id,account_id) DO NOTHING;
 SELECT s.id INTO subject FROM domain.agreement_subject s WHERE s.agreement_id=agreement AND s.account_id=account;
 INSERT INTO domain.agreement_credential(id,agreement_id,issued_version,issuer_tenant_id,subject_id,starts_at,ends_at,verification_reference,issued_by,correlation_id)
 VALUES(credential,agreement,revision,tenant,subject,starts,ends,reference,actor,correlation);
END $$;
CREATE FUNCTION domain.revoke_agreement_credential(credential uuid,reason text,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); agreement uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT c.agreement_id INTO agreement FROM domain.agreement_credential c WHERE c.id=credential AND c.issuer_tenant_id=tenant;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR SHARE;
 PERFORM 1 FROM domain.agreement_credential c WHERE c.id=credential FOR UPDATE;
 UPDATE domain.agreement_credential SET revoked_at=clock_timestamp(),revoked_by=actor,revocation_reason=reason,revocation_correlation_id=correlation
 WHERE id=credential AND revoked_at IS NULL;
END $$;
CREATE FUNCTION domain.issued_credential_visible(credential uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM domain.agreement_credential c WHERE c.id=credential
 AND c.issuer_tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid);
END $$;
REVOKE ALL ON FUNCTION domain.issue_agreement_credential(uuid,uuid,integer,text,timestamptz,timestamptz,text,uuid),domain.revoke_agreement_credential(uuid,text,uuid),domain.issued_credential_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.issue_agreement_credential(uuid,uuid,integer,text,timestamptz,timestamptz,text,uuid),domain.revoke_agreement_credential(uuid,text,uuid),domain.issued_credential_visible(uuid) TO quenda_domain;
