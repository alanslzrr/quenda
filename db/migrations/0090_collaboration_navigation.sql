-- Read models for existing administrative tasks. No metrics, verification
-- references or credentials issued by another municipality are exposed.
CREATE FUNCTION domain.issued_credentials(after_id uuid)
RETURNS TABLE(id uuid, agreement_id uuid, agreement_name text, account_id text, starts_at timestamptz, ends_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT c.id,c.agreement_id,a.name,s.account_id,c.starts_at,c.ends_at,c.revoked_at
 FROM domain.agreement_credential c
 JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
 JOIN domain.agreement a ON a.id=c.agreement_id
 WHERE c.issuer_tenant_id=tenant AND (after_id IS NULL OR c.id>after_id)
 ORDER BY c.id LIMIT 21;
END $$;

CREATE FUNCTION domain.monthly_review_options(agreement uuid,after_month date)
RETURNS TABLE(month text,revision integer,participants jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT to_char(s.month_start,'YYYY-MM'),s.revision,
 (SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.name) ORDER BY m.name,m.id)
  FROM domain.municipality m WHERE m.id=ANY(s.participants))
 FROM domain.monthly_assessment s
 WHERE s.agreement_id=agreement AND tenant=ANY(s.participants)
 AND (after_month IS NULL OR s.month_start>after_month)
 AND NOT EXISTS(SELECT 1 FROM domain.monthly_assessment newer WHERE newer.agreement_id=s.agreement_id AND newer.month_start=s.month_start AND newer.revision>s.revision)
 ORDER BY s.month_start LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION domain.issued_credentials(uuid),domain.monthly_review_options(uuid,date) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.issued_credentials(uuid),domain.monthly_review_options(uuid,date) TO quenda_domain;
