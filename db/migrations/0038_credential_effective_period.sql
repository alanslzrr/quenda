CREATE OR REPLACE FUNCTION domain.issue_agreement_credential(credential uuid,agreement uuid,revision integer,account text,starts timestamptz,ends timestamptz,reference text,correlation uuid) RETURNS void
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
 PERFORM 1 FROM domain.agreement_activation a WHERE a.agreement_id=agreement AND a.version=revision
 AND a.effective_period @> clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agreement has no current effective period' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM domain.municipal_profile p WHERE p.tenant_id=tenant AND p.account_id=account FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES(agreement,gen_random_uuid(),account) ON CONFLICT(agreement_id,account_id) DO NOTHING;
 SELECT s.id INTO subject FROM domain.agreement_subject s WHERE s.agreement_id=agreement AND s.account_id=account;
 INSERT INTO domain.agreement_credential(id,agreement_id,issued_version,issuer_tenant_id,subject_id,starts_at,ends_at,verification_reference,issued_by,correlation_id)
 VALUES(credential,agreement,revision,tenant,subject,starts,ends,reference,actor,correlation);
END $$;
