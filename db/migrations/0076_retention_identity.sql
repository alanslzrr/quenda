-- A retained identifier is a tombstone for referential evidence, not anonymous data.
ALTER TABLE auth.account_lifecycle ADD COLUMN erased_at timestamptz;
CREATE INDEX account_lifecycle_retention ON auth.account_lifecycle(deactivated_at,account_id) WHERE deactivated_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX authentication_session_retention ON auth.session("expiresAt",id);
CREATE INDEX authentication_request_retention ON auth.request_event(occurred_at,request_id);
CREATE INDEX authentication_session_event_retention ON auth.session_event(occurred_at,id);
CREATE INDEX authentication_credential_event_retention ON auth.credential_event(occurred_at,id);
CREATE INDEX authentication_deactivation_retention ON auth.account_deactivation_event(occurred_at,id);
CREATE INDEX authentication_reactivation_retention ON auth.account_reactivation_event(occurred_at,id);
CREATE INDEX authentication_security_retention ON auth.account_security_event(occurred_at,id);
CREATE INDEX authentication_email_retention ON auth.email_change_event(occurred_at,id);
CREATE INDEX authentication_verification_retention ON auth.verification("expiresAt",id);

CREATE FUNCTION auth.guard_erased_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.erased_at IS NOT NULL AND (NEW.erased_at IS DISTINCT FROM OLD.erased_at OR NEW.deactivated_at IS NULL) THEN
  RAISE EXCEPTION 'Erased identity cannot be recovered' USING ERRCODE='42501';
 END IF;
 IF NEW.erased_at IS NOT NULL AND NEW.deactivated_at IS NULL THEN
  RAISE EXCEPTION 'Erased identity requires inactive lifecycle' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.guard_erased_identity() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER erased_identity_guard BEFORE UPDATE ON auth.account_lifecycle
 FOR EACH ROW EXECUTE FUNCTION auth.guard_erased_identity();

CREATE OR REPLACE FUNCTION auth.guard_active_account_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; erased timestamptz;
BEGIN
 IF TG_TABLE_NAME='user' THEN subject:=NEW.id; ELSE subject:=NEW."userId"; END IF;
 SELECT erased_at INTO erased FROM auth.account_lifecycle WHERE account_id=subject FOR UPDATE;
 IF erased IS NOT NULL THEN
  -- The owner-only retention action sets erased_at first. No web credential can
  -- set it, and even maintenance cannot restore personal fields through this path.
  IF TG_TABLE_NAME='user' THEN
   IF NEW.id=OLD.id AND NEW.name='Cuenta suprimida'
     AND NEW.email=encode(sha256(convert_to(NEW.id,'UTF8')),'hex')||'@erased.invalid'
     AND NOT NEW."emailVerified" AND NOT coalesce(NEW."twoFactorEnabled",false)
     AND NEW.image IS NULL AND NEW."createdAt"=OLD."createdAt" THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Identity erased' USING ERRCODE='42501';
 END IF;
 IF session_user='quenda_migrator' AND TG_TABLE_NAME IN ('account','twoFactor') THEN
  UPDATE auth.account_lifecycle SET session_generation=session_generation+1 WHERE account_id=subject;
  RETURN NEW;
 END IF;
 UPDATE auth.account_lifecycle SET session_generation=session_generation+1
 WHERE account_id=subject AND deactivated_at IS NULL AND suspended_at IS NULL AND erased_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account inactive' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='user' THEN
 IF OLD."twoFactorEnabled" AND NOT coalesce(NEW."twoFactorEnabled",false)
 AND (EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=subject AND revoked_at IS NULL)
   OR EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE account_id=subject AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM domain.manager_grant g JOIN domain.manager_invitation i ON i.tenant_id=g.tenant_id AND i.id=g.invitation_id
       WHERE g.account_id=subject AND g.revoked_at IS NULL AND (i.role_expires_at IS NULL OR i.role_expires_at>clock_timestamp()))) THEN
  RAISE EXCEPTION 'Administrative authority requires MFA' USING ERRCODE='42501';
 END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth.lock_reactivation_account(subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION 'Serializable reactivation required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject AND deactivated_at IS NOT NULL AND suspended_at IS NULL AND erased_at IS NULL FOR UPDATE;
 RETURN FOUND;
END $$;

CREATE FUNCTION domain.retention_identity_candidates(scope_tenant uuid,category text,cutoff timestamptz,batch_limit integer)
RETURNS TABLE(target_key text,subject_id text,anchor_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF scope_tenant IS NOT NULL OR cutoff IS NULL OR batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 500 THEN RETURN; END IF;
 IF category='IDENTITY' THEN
  RETURN QUERY SELECT 'identity:'||l.account_id,l.account_id,l.deactivated_at FROM auth.account_lifecycle l
  WHERE l.deactivated_at<=cutoff AND l.erased_at IS NULL
   AND domain.retention_candidate_due(NULL,category,'identity:'||l.account_id) ORDER BY l.deactivated_at,l.account_id LIMIT batch_limit;
 ELSIF category='AUTHENTICATION' THEN
  RETURN QUERY SELECT candidate.target_key,candidate.subject_id,candidate.anchor_at FROM (
   SELECT 'session-event:'||e.id AS target_key,e.subject_id,e.occurred_at AS anchor_at FROM auth.session_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'credential-event:'||e.id,e.subject_id,e.occurred_at FROM auth.credential_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'deactivation-event:'||e.id,e.subject_id,e.occurred_at FROM auth.account_deactivation_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'reactivation-event:'||e.id,e.subject_id,e.occurred_at FROM auth.account_reactivation_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'security-event:'||e.id,e.subject_id,e.occurred_at FROM auth.account_security_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'email-event:'||e.id,e.account_id,e.occurred_at FROM auth.email_change_event e WHERE e.occurred_at<=cutoff
   UNION ALL SELECT 'expired-verification:'||v.id,u.id,v."expiresAt" FROM auth.verification v LEFT JOIN auth."user" u ON u.id=v.value
    WHERE v."expiresAt"<=cutoff AND v."expiresAt"<clock_timestamp()
   UNION ALL SELECT 'request-event:'||e.request_id,max(e.actor_id),max(e.occurred_at) FROM auth.request_event e
    GROUP BY e.request_id HAVING max(e.occurred_at)<=cutoff
   UNION ALL SELECT 'expired-session:'||s.id,s."userId",s."expiresAt" FROM auth.session s WHERE s."expiresAt"<=cutoff AND s."expiresAt"<clock_timestamp()
   UNION ALL SELECT 'email-challenge:'||c.id,c.account_id,c.expires_at FROM auth.email_change_challenge c WHERE c.expires_at<=cutoff AND c.expires_at<clock_timestamp()
   UNION ALL SELECT 'reactivation-challenge:'||c.token_digest,c.account_id,c.expires_at FROM auth.account_reactivation_challenge c WHERE c.expires_at<=cutoff AND c.expires_at<clock_timestamp()
   UNION ALL SELECT 'deactivation-proof:'||p.token_digest,p.account_id,p.expires_at FROM auth.account_deactivation_proof p WHERE p.expires_at<=cutoff AND p.expires_at<clock_timestamp()
  ) candidate WHERE domain.retention_candidate_due(NULL,category,candidate.target_key) ORDER BY candidate.anchor_at,candidate.target_key LIMIT batch_limit;
 END IF;
END $$;
REVOKE ALL ON FUNCTION domain.retention_identity_candidates(uuid,text,timestamptz,integer) FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION domain.retention_identity_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE kind text:=split_part(target_key,':',1); key text:=substring(target_key FROM position(':' IN target_key)+1);
 subject text; anchor timestamptz; payload jsonb; item record; count_rows integer; instant timestamptz:=clock_timestamp();
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION 'Serializable retention required' USING ERRCODE='42501'; END IF;
 IF scope_tenant IS NOT NULL OR cutoff IS NULL OR category IS NULL OR category NOT IN ('IDENTITY','AUTHENTICATION') THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','INVALID_SCOPE','subjectId',NULL,'payload',NULL);
 END IF;
 IF category='IDENTITY' AND kind='identity' THEN
  SELECT l.account_id,l.deactivated_at,l.erased_at,l.suspended_at INTO item FROM auth.account_lifecycle l WHERE l.account_id=key FOR UPDATE;
  IF NOT FOUND OR item.erased_at IS NOT NULL THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL,'payload',NULL); END IF;
  subject:=item.account_id;
  IF item.deactivated_at IS NULL OR item.deactivated_at>cutoff THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','IDENTITY_NOT_DUE','subjectId',subject,'payload',NULL); END IF;
  IF item.suspended_at IS NOT NULL THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','SECURITY_REVIEW_REQUIRED','subjectId',subject,'payload',NULL); END IF;
  IF domain.retention_target_held(NULL,category,target_key,subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',subject,'payload',NULL); END IF;
  IF EXISTS(SELECT 1 FROM domain.retention_hold h WHERE h.released_at IS NULL AND h.subject_id=subject AND NOT(h.tenant_id IS NULL AND h.category='AUTHENTICATION')) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','IDENTITY_EVIDENCE_HELD','subjectId',subject,'payload',NULL); END IF;
  IF domain.retention_target_held(NULL,'AUTHENTICATION',NULL,subject)
   OR EXISTS(SELECT 1 FROM auth.verification v WHERE v.value=subject AND domain.retention_target_held(NULL,'AUTHENTICATION','expired-verification:'||v.id,subject))
   OR EXISTS(SELECT 1 FROM auth.session s WHERE s."userId"=subject AND domain.retention_target_held(NULL,'AUTHENTICATION','expired-session:'||s.id,subject))
   OR EXISTS(SELECT 1 FROM auth.email_change_challenge c WHERE c.account_id=subject AND domain.retention_target_held(NULL,'AUTHENTICATION','email-challenge:'||c.id,subject))
   OR EXISTS(SELECT 1 FROM auth.account_reactivation_challenge c WHERE c.account_id=subject AND domain.retention_target_held(NULL,'AUTHENTICATION','reactivation-challenge:'||c.token_digest,subject))
   OR EXISTS(SELECT 1 FROM auth.account_deactivation_proof p WHERE p.account_id=subject AND domain.retention_target_held(NULL,'AUTHENTICATION','deactivation-proof:'||p.token_digest,subject)) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','AUTHENTICATION_HOLD','subjectId',subject,'payload',NULL); END IF;
  IF EXISTS(SELECT 1 FROM domain.retention_archive a WHERE a.tenant_id IS NOT NULL AND a.subject_id=subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','ARCHIVED_MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY','subjectId',subject,'payload',NULL); END IF;
  IF domain.retention_target_held(NULL,'AUTHORITY',subject,subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','IDENTITY_EVIDENCE_HELD','subjectId',subject,'payload',NULL); END IF;
  IF EXISTS(SELECT 1 FROM domain.municipal_profile WHERE account_id=subject)
   OR EXISTS(SELECT 1 FROM domain.reservation WHERE account_id=subject)
   OR EXISTS(SELECT 1 FROM domain.agreement_subject s JOIN domain.agreement_credential c ON (c.agreement_id,c.subject_id)=(s.agreement_id,s.id) WHERE s.account_id=subject)
   OR EXISTS(SELECT 1 FROM domain.agreement_subject s JOIN domain.agreement_consumption c ON (c.agreement_id,c.subject_id)=(s.agreement_id,s.id) WHERE s.account_id=subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY','subjectId',subject,'payload',NULL); END IF;
  IF EXISTS(SELECT 1 FROM domain.reservation WHERE account_id=subject AND status='CONFIRMADA' AND ends_at>instant) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_RESERVATIONS','subjectId',subject,'payload',NULL); END IF;
  IF auth.account_has_administrative_authority(subject) OR EXISTS(SELECT 1 FROM domain.global_privacy_invitation WHERE account_id=subject AND accepted_at IS NOT NULL AND revoked_at IS NULL AND (role_expires_at IS NULL OR role_expires_at>instant)) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_AUTHORITY','subjectId',subject,'payload',NULL); END IF;
  SELECT jsonb_build_object('identity',to_jsonb(u),'preferences',(SELECT to_jsonb(p) FROM domain.account_preferences p WHERE p.account_id=subject),
   'lifecycle',jsonb_build_object('deactivatedAt',item.deactivated_at),'retainedReferences','PSEUDONYMOUS_NOT_ANONYMOUS') INTO payload
  FROM auth."user" u WHERE u.id=subject FOR UPDATE;
  -- Credential material is never copied to the blocked-data vault. Inactive
  -- personal access is irreversibly withdrawn; evidence stays under its own policy.
  DELETE FROM auth.session WHERE "userId"=subject;
  DELETE FROM auth.account WHERE "userId"=subject;
  DELETE FROM auth."twoFactor" WHERE "userId"=subject;
  DELETE FROM auth.verification WHERE value=subject;
  DELETE FROM auth.account_deactivation_proof WHERE account_id=subject;
  DELETE FROM auth.account_reactivation_challenge WHERE account_id=subject;
  DELETE FROM auth.email_change_challenge WHERE account_id=subject;
  DELETE FROM domain.account_preferences WHERE account_id=subject;
  UPDATE auth.account_lifecycle SET erased_at=instant,session_generation=session_generation+1,
   suspended_password_fingerprint=NULL,suspended_mfa_fingerprint=NULL,suspended_backup_fingerprint=NULL WHERE account_id=subject;
  UPDATE auth."user" SET name='Cuenta suprimida',email=encode(sha256(convert_to(id,'UTF8')),'hex')||'@erased.invalid',
   "emailVerified"=false,image=NULL,"twoFactorEnabled"=false,"updatedAt"=instant WHERE id=subject;
  RETURN jsonb_build_object('status','APPLIED','subjectId',subject,'payload',payload);
 END IF;
 IF category<>'AUTHENTICATION' THEN RETURN jsonb_build_object('status','CONFLICT','reason','INVALID_TARGET','subjectId',NULL,'payload',NULL); END IF;
 IF kind='session-event' THEN
  SELECT e.subject_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.session_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='credential-event' THEN
  SELECT e.subject_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.credential_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='deactivation-event' THEN
  SELECT e.subject_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.account_deactivation_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='reactivation-event' THEN
  SELECT e.subject_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.account_reactivation_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='security-event' THEN
  SELECT e.subject_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.account_security_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='email-event' THEN
  SELECT e.account_id,e.occurred_at,to_jsonb(e) INTO subject,anchor,payload FROM auth.email_change_event e WHERE e.id::text=key FOR UPDATE;
 ELSIF kind='expired-verification' THEN
  SELECT (SELECT u.id FROM auth."user" u WHERE u.id=v.value),v."expiresAt",
   jsonb_build_object('createdAt',v."createdAt",'updatedAt',v."updatedAt",'expiresAt',v."expiresAt",
    'kind',CASE WHEN v.identifier LIKE 'reset-password:%' THEN 'PASSWORD_RESET' WHEN v.identifier LIKE '2fa-attempts-%' THEN 'MFA_ATTEMPTS' WHEN v.identifier LIKE '2fa-%' THEN 'MFA_CHALLENGE' ELSE 'OTHER_VERIFICATION' END)
   INTO subject,anchor,payload FROM auth.verification v WHERE v.id=key FOR UPDATE;
 ELSIF kind='request-event' THEN
  PERFORM 1 FROM auth.request_event e WHERE e.request_id::text=key FOR UPDATE;
  SELECT max(e.actor_id),max(e.occurred_at),jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at,e.phase) INTO subject,anchor,payload
   FROM auth.request_event e WHERE e.request_id::text=key;
  IF anchor IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM auth.request_event e WHERE e.request_id::text=key AND e.phase='RECEIVED')
   OR NOT EXISTS(SELECT 1 FROM auth.request_event e WHERE e.request_id::text=key AND e.phase IN ('RETURNED','THREW'))) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','INCOMPLETE_AUTHENTICATION_AUDIT','subjectId',subject,'payload',NULL); END IF;
 ELSIF kind='expired-session' THEN
  SELECT s."userId",s."expiresAt",to_jsonb(s)-'token'-'id' INTO subject,anchor,payload FROM auth.session s WHERE s.id=key FOR UPDATE;
 ELSIF kind='email-challenge' THEN
  SELECT c.account_id,c.expires_at,to_jsonb(c)-'approval_digest'-'verification_digest'-'password_fingerprint'-'session_id'
  INTO subject,anchor,payload FROM auth.email_change_challenge c WHERE c.id::text=key FOR UPDATE;
 ELSIF kind='reactivation-challenge' THEN
  SELECT c.account_id,c.expires_at,to_jsonb(c)-'token_digest' INTO subject,anchor,payload FROM auth.account_reactivation_challenge c WHERE c.token_digest=key FOR UPDATE;
 ELSIF kind='deactivation-proof' THEN
  SELECT p.account_id,p.expires_at,to_jsonb(p)-'token_digest'-'password_hash'-'session_id' INTO subject,anchor,payload FROM auth.account_deactivation_proof p WHERE p.token_digest=key FOR UPDATE;
 ELSE RETURN jsonb_build_object('status','CONFLICT','reason','INVALID_TARGET','subjectId',NULL,'payload',NULL);
 END IF;
 IF anchor IS NULL THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject,'payload',NULL); END IF;
 IF anchor>cutoff OR anchor>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',subject,'payload',NULL); END IF;
 IF domain.retention_target_held(NULL,category,target_key,subject) THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',subject,'payload',NULL); END IF;
 IF kind='session-event' THEN DELETE FROM auth.session_event WHERE id::text=key;
 ELSIF kind='credential-event' THEN DELETE FROM auth.credential_event WHERE id::text=key;
 ELSIF kind='deactivation-event' THEN DELETE FROM auth.account_deactivation_event WHERE id::text=key;
 ELSIF kind='reactivation-event' THEN DELETE FROM auth.account_reactivation_event WHERE id::text=key;
 ELSIF kind='security-event' THEN DELETE FROM auth.account_security_event WHERE id::text=key;
 ELSIF kind='email-event' THEN DELETE FROM auth.email_change_event WHERE id::text=key;
 ELSIF kind='expired-verification' THEN DELETE FROM auth.verification WHERE id=key;
 ELSIF kind='request-event' THEN DELETE FROM auth.request_event WHERE request_id::text=key;
 ELSIF kind='expired-session' THEN DELETE FROM auth.session WHERE id=key;
 ELSIF kind='email-challenge' THEN DELETE FROM auth.email_change_challenge WHERE id::text=key;
 ELSIF kind='reactivation-challenge' THEN DELETE FROM auth.account_reactivation_challenge WHERE token_digest=key;
 ELSIF kind='deactivation-proof' THEN DELETE FROM auth.account_deactivation_proof WHERE token_digest=key;
 END IF;
 GET DIAGNOSTICS count_rows=ROW_COUNT;
 RETURN jsonb_build_object('status',CASE WHEN count_rows>0 THEN 'APPLIED' ELSE 'ABSENT' END,'subjectId',subject,'payload',payload);
END $$;
REVOKE ALL ON FUNCTION domain.retention_identity_action(uuid,text,text,timestamptz) FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
