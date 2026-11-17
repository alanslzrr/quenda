-- Agreements whose monthly report the acting municipality can request. A
-- municipal REPORT_READ holder sees only the name and the latest activated
-- version with aggregate reports in which its municipality participates: no
-- other participants, units, months, metrics or review state.
CREATE FUNCTION domain.report_agreement_options(after_id uuid)
RETURNS TABLE(agreement_id uuid,name text,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF NOT domain.lock_permission('REPORT_READ',NULL) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT a.id,a.name,max(v.version)::integer
 FROM domain.agreement a
 JOIN domain.agreement_version v ON v.agreement_id=a.id
 JOIN domain.agreement_participant p ON (p.agreement_id,p.version)=(v.agreement_id,v.version)
 JOIN domain.agreement_activation x ON (x.agreement_id,x.version)=(v.agreement_id,v.version)
 WHERE p.tenant_id=tenant AND v.status='ACTIVADO' AND v.aggregate_reports
 AND (after_id IS NULL OR a.id>after_id)
 GROUP BY a.id,a.name
 ORDER BY a.id LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION domain.report_agreement_options(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.report_agreement_options(uuid) TO quenda_domain;
