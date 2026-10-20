CREATE FUNCTION domain.privacy_operational() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT restore_review_required FROM domain.retention_control WHERE id
$$;
REVOKE ALL ON FUNCTION domain.privacy_operational() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.privacy_operational() TO quenda_domain,quenda_auth,quenda_worker;

-- Reading the exceptional legal archive is deliberately absent from the HTTP
-- API. Maintenance requires an external authorization and records the access.
CREATE FUNCTION domain.read_blocked_privacy_record(archive_id uuid,authorization_reference text,legal_purpose text,correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item domain.retention_archive;
BEGIN
 IF coalesce(length(btrim(authorization_reference)),0) NOT BETWEEN 1 AND 500 OR coalesce(length(btrim(legal_purpose)),0) NOT BETWEEN 1 AND 500 OR correlation_id IS NULL THEN RAISE EXCEPTION 'Authorization required' USING ERRCODE='23514'; END IF;
 SELECT * INTO item FROM domain.retention_archive WHERE id=archive_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,authorization_reference,reason,correlation_id,details)
 VALUES('BLOCKED_RECORD_ACCESSED',item.tenant_id,item.category,item.target_key,item.subject_id,authorization_reference,legal_purpose,correlation_id,jsonb_build_object('archiveId',item.id,'maintenanceLogin',session_user));
 RETURN item.payload;
END $$;
REVOKE ALL ON FUNCTION domain.read_blocked_privacy_record(uuid,text,text,uuid) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

-- Holds reference an existing record or a scoped subject, not an arbitrary key
-- that could silently fail to protect the intended data. Closed selectors keep
-- validation separate from destructive handlers and never execute caller SQL.
CREATE FUNCTION domain.retention_target_exists(scope_tenant uuid,scope_category text,target text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE kind text:=split_part(target,':',1); key text:=substring(target FROM position(':' IN target)+1);
BEGIN
 IF target IS NULL OR length(btrim(target)) NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM domain.retention_archive a WHERE a.tenant_id IS NOT DISTINCT FROM scope_tenant AND a.category=scope_category AND a.target_key=target) THEN RETURN true; END IF;
 IF scope_category='RESERVATIONS' AND scope_tenant IS NOT NULL THEN
  RETURN EXISTS(SELECT 1 FROM domain.reservation r WHERE r.tenant_id=scope_tenant AND r.id::text=target);
 ELSIF scope_category='COMMUNICATIONS' AND scope_tenant IS NOT NULL THEN
  RETURN EXISTS(SELECT 1 FROM domain.reservation_event e WHERE e.tenant_id=scope_tenant AND e.id::text=target AND (
   EXISTS(SELECT 1 FROM domain.reservation_notice n WHERE (n.tenant_id,n.event_id)=(e.tenant_id,e.id))
   OR EXISTS(SELECT 1 FROM domain.reservation_email m WHERE (m.tenant_id,m.event_id)=(e.tenant_id,e.id))));
 ELSIF scope_category IN ('MUNICIPAL_PROFILE','AUTHORITY','ACCREDITATIONS') THEN
  RETURN domain.retention_municipal_anchor(scope_tenant,scope_category,target) IS NOT NULL;
 ELSIF scope_category='IDENTITY' AND scope_tenant IS NULL AND kind='identity' AND position(':' IN target)>0 THEN
  RETURN EXISTS(SELECT 1 FROM auth."user" WHERE id=key);
 ELSIF scope_category='AUTHENTICATION' AND scope_tenant IS NULL AND position(':' IN target)>0 THEN
  IF kind='session-event' THEN RETURN EXISTS(SELECT 1 FROM auth.session_event WHERE id::text=key);
  ELSIF kind='credential-event' THEN RETURN EXISTS(SELECT 1 FROM auth.credential_event WHERE id::text=key);
  ELSIF kind='deactivation-event' THEN RETURN EXISTS(SELECT 1 FROM auth.account_deactivation_event WHERE id::text=key);
  ELSIF kind='reactivation-event' THEN RETURN EXISTS(SELECT 1 FROM auth.account_reactivation_event WHERE id::text=key);
  ELSIF kind='security-event' THEN RETURN EXISTS(SELECT 1 FROM auth.account_security_event WHERE id::text=key);
  ELSIF kind='email-event' THEN RETURN EXISTS(SELECT 1 FROM auth.email_change_event WHERE id::text=key);
  ELSIF kind='request-event' THEN RETURN EXISTS(SELECT 1 FROM auth.request_event WHERE request_id::text=key);
  ELSIF kind='expired-verification' THEN RETURN EXISTS(SELECT 1 FROM auth.verification WHERE id=key);
  ELSIF kind='expired-session' THEN RETURN EXISTS(SELECT 1 FROM auth.session WHERE id=key);
  ELSIF kind='email-challenge' THEN RETURN EXISTS(SELECT 1 FROM auth.email_change_challenge WHERE id::text=key);
  ELSIF kind='reactivation-challenge' THEN RETURN EXISTS(SELECT 1 FROM auth.account_reactivation_challenge WHERE token_digest=key);
  ELSIF kind='deactivation-proof' THEN RETURN EXISTS(SELECT 1 FROM auth.account_deactivation_proof WHERE token_digest=key);
  END IF;
 END IF;
 RETURN false;
END $$;
CREATE FUNCTION domain.retention_subject_exists(scope_tenant uuid,subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM auth."user" WHERE id=subject) AND (
  scope_tenant IS NULL
  OR EXISTS(SELECT 1 FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.retention_archive WHERE tenant_id=scope_tenant AND subject_id=subject)
  OR EXISTS(SELECT 1 FROM domain.personal_data_records(subject,scope_tenant,false,true)))
$$;
REVOKE ALL ON FUNCTION domain.retention_target_exists(uuid,text,text),domain.retention_subject_exists(uuid,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
