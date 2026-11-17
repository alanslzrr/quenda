-- Municipal AUTHORITY retention of an account that accepted an
-- email-addressed administrator invitation. Since 0125 the events written when
-- the invitation was created, replaced or revoked before acceptance
-- (CREATE_MUNICIPALITY, INVITE_ADMINISTRATOR, RECOVER_ADMINISTRATOR,
-- REVOKE_INVITATION) name no account, yet they reference the invitation that
-- acceptance bound to the account. Deleting the account set left them behind
-- and the foreign key turned the whole action into RETAINED_REFERENCE.
--
-- As 0126 does for operator events, the account set now includes the identity
-- events of the administrator invitations the account accepted: they anchor,
-- archive and leave with the account. Manager events already follow the
-- manager invitations of the account, so manager invitations need no change.
-- The functions are otherwise identical to 0126.

CREATE OR REPLACE FUNCTION domain.retention_municipal_anchor(scope_tenant uuid,requested_category text,target_key text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result timestamptz;
BEGIN
 IF requested_category='AUTHORITY' AND target_key LIKE 'access:%' THEN
  SELECT occurred_at INTO result FROM domain.personal_data_access_event WHERE id::text=substring(target_key FROM 8) AND scope_tenant_id IS NOT DISTINCT FROM scope_tenant;
  RETURN result;
 ELSIF requested_category='AUTHORITY' AND target_key LIKE 'denial:%' AND scope_tenant IS NULL THEN
  SELECT occurred_at INTO result FROM domain.access_denial WHERE request_id::text=substring(target_key FROM 8);
  RETURN result;
 ELSIF requested_category='AUTHORITY' AND target_key LIKE 'address:%' THEN
  IF scope_tenant IS NULL THEN
   IF target_key LIKE 'address:operator:%' THEN
    SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.platform_operator_invitation
    WHERE id::text=substring(target_key FROM 18) AND account_id IS NULL AND recipient_email IS NOT NULL;
   ELSIF target_key LIKE 'address:privacy:%' THEN
    SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.global_privacy_invitation
    WHERE id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL;
   END IF;
   RETURN result;
  END IF;
  IF target_key LIKE 'address:administrator:%' THEN
   SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.administrator_invitation
   WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 23) AND account_id IS NULL AND recipient_email IS NOT NULL;
  ELSIF target_key LIKE 'address:manager:%' THEN
   SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.manager_invitation
   WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL;
  END IF;
  RETURN result;
 END IF;
 IF requested_category='MUNICIPAL_PROFILE' AND scope_tenant IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=target_key) THEN RETURN NULL; END IF;
  SELECT max(instant) INTO result FROM (
   SELECT created_at AS instant FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT ends_at FROM domain.reservation WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT e.occurred_at FROM domain.reservation_event e JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id) WHERE r.tenant_id=scope_tenant AND r.account_id=target_key
   UNION ALL SELECT created_at FROM domain.reservation_notice WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT occurred_at FROM domain.identity_event WHERE tenant_id=scope_tenant AND (subject_id=target_key OR actor_id=target_key)
   UNION ALL SELECT e.occurred_at FROM domain.manager_event e WHERE e.tenant_id=scope_tenant AND (e.actor_id=target_key OR EXISTS(SELECT 1 FROM domain.manager_invitation i WHERE (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) AND i.account_id=target_key))
   UNION ALL SELECT greatest(c.issued_at,coalesce(c.revoked_at,c.ends_at)) FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id) WHERE c.issuer_tenant_id=scope_tenant AND s.account_id=target_key
  ) activity;
 ELSIF requested_category='AUTHORITY' THEN
  IF scope_tenant IS NOT NULL THEN
   SELECT max(instant) INTO result FROM (
    SELECT coalesce(revoked_at,expires_at,granted_at) AS instant FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,role_expires_at,expires_at,created_at) FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=target_key
    UNION ALL SELECT coalesce(g.revoked_at,i.revoked_at,i.role_expires_at,i.expires_at,i.created_at) FROM domain.manager_invitation i LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id) WHERE i.tenant_id=scope_tenant AND i.account_id=target_key
    UNION ALL SELECT occurred_at FROM domain.identity_event WHERE tenant_id=scope_tenant AND (subject_id=target_key OR invitation_id IN (SELECT i.id FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=target_key))
    UNION ALL SELECT e.occurred_at FROM domain.manager_event e JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=target_key
   ) history;
  ELSE
   SELECT max(instant) INTO result FROM (
    SELECT coalesce(revoked_at,created_at) AS instant FROM domain.platform_operator WHERE account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,expires_at,created_at) FROM domain.platform_operator_invitation WHERE account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,role_expires_at,expires_at,created_at) FROM domain.global_privacy_invitation WHERE account_id=target_key
    UNION ALL SELECT occurred_at FROM domain.platform_operator_event WHERE subject_id=target_key
     OR invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=target_key)
    UNION ALL SELECT e.occurred_at FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=target_key
   ) history;
  END IF;
 ELSIF requested_category='ACCREDITATIONS' AND scope_tenant IS NOT NULL THEN
  SELECT coalesce(revoked_at,ends_at) INTO result FROM domain.agreement_credential WHERE issuer_tenant_id=scope_tenant AND id::text=target_key;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION domain.retention_municipal_anchor(uuid,text,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE OR REPLACE FUNCTION domain.retention_municipal_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz,requested_action text,block_days integer,verified_replay boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; anchor timestamptz; payload jsonb; item domain.agreement_credential%ROWTYPE;
 instant timestamptz:=clock_timestamp(); access_item domain.personal_data_access_event%ROWTYPE; denial_item domain.access_denial%ROWTYPE;
 administrator_item domain.administrator_invitation%ROWTYPE; manager_item domain.manager_invitation%ROWTYPE;
 operator_item domain.platform_operator_invitation%ROWTYPE; privacy_item domain.global_privacy_invitation%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR category IS NULL OR category NOT IN ('MUNICIPAL_PROFILE','AUTHORITY','ACCREDITATIONS') OR cutoff IS NULL OR NOT isfinite(cutoff) THEN
  RAISE EXCEPTION 'Invalid retention action' USING ERRCODE='22023'; END IF;
 IF category='AUTHORITY' AND target_key LIKE 'access:%' THEN
  SELECT * INTO access_item FROM domain.personal_data_access_event WHERE id::text=substring(target_key FROM 8) AND scope_tenant_id IS NOT DISTINCT FROM scope_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  IF access_item.occurred_at>cutoff OR access_item.occurred_at>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',access_item.subject_id); END IF;
  IF domain.retention_target_held(scope_tenant,category,target_key,access_item.subject_id) OR domain.retention_target_held(scope_tenant,category,target_key,access_item.actor_id) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',access_item.subject_id); END IF;
  DELETE FROM domain.personal_data_access_event WHERE id=access_item.id;
  RETURN jsonb_build_object('status','APPLIED','subjectId',access_item.subject_id,'payload',jsonb_build_object('personalDataAccessEvent',to_jsonb(access_item)),'anchorAt',access_item.occurred_at);
 ELSIF category='AUTHORITY' AND target_key LIKE 'denial:%' THEN
  IF scope_tenant IS NOT NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','GLOBAL_SECURITY_SCOPE_REQUIRED','subjectId',NULL); END IF;
  SELECT * INTO denial_item FROM domain.access_denial WHERE request_id::text=substring(target_key FROM 8) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  IF denial_item.occurred_at>cutoff OR denial_item.occurred_at>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',denial_item.actor_id); END IF;
  IF domain.retention_target_held(NULL,category,target_key,denial_item.actor_id) THEN RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',denial_item.actor_id); END IF;
  DELETE FROM domain.access_denial WHERE request_id=denial_item.request_id;
  RETURN jsonb_build_object('status','APPLIED','subjectId',denial_item.actor_id,'payload',jsonb_build_object('accessDenial',to_jsonb(denial_item)),'anchorAt',denial_item.occurred_at);
 ELSIF category='AUTHORITY' AND target_key LIKE 'address:%' THEN
  IF target_key LIKE 'address:operator:%' OR target_key LIKE 'address:privacy:%' THEN
   IF scope_tenant IS NOT NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','GLOBAL_SECURITY_SCOPE_REQUIRED','subjectId',NULL); END IF;
   IF target_key LIKE 'address:operator:%' THEN
    SELECT * INTO operator_item FROM domain.platform_operator_invitation
    WHERE id::text=substring(target_key FROM 18) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(operator_item.revoked_at,operator_item.expires_at);
    payload:=jsonb_build_object('operatorInvitation',to_jsonb(operator_item));
   ELSE
    SELECT * INTO privacy_item FROM domain.global_privacy_invitation
    WHERE id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(privacy_item.revoked_at,privacy_item.expires_at);
    payload:=jsonb_build_object('privacyInvitation',to_jsonb(privacy_item));
   END IF;
  ELSE
   IF scope_tenant IS NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','MUNICIPAL_SCOPE_REQUIRED','subjectId',NULL); END IF;
   IF target_key LIKE 'address:administrator:%' THEN
    SELECT * INTO administrator_item FROM domain.administrator_invitation
    WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 23) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(administrator_item.revoked_at,administrator_item.expires_at);
    payload:=jsonb_build_object('administratorInvitation',to_jsonb(administrator_item));
   ELSIF target_key LIKE 'address:manager:%' THEN
    SELECT * INTO manager_item FROM domain.manager_invitation
    WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(manager_item.revoked_at,manager_item.expires_at);
    payload:=jsonb_build_object('managerInvitation',to_jsonb(manager_item));
   ELSE RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  END IF;
  -- A pending invitation is never due: its anchor is still in the future.
  IF anchor>cutoff OR anchor>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',NULL); END IF;
  IF domain.retention_target_held(scope_tenant,category,target_key,NULL) THEN RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',NULL); END IF;
  IF scope_tenant IS NULL THEN
   UPDATE domain.platform_operator_invitation SET recipient_email=NULL WHERE id=operator_item.id;
   UPDATE domain.global_privacy_invitation SET recipient_email=NULL WHERE id=privacy_item.id;
  ELSE
   UPDATE domain.administrator_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=administrator_item.id;
   UPDATE domain.manager_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=manager_item.id;
  END IF;
  RETURN jsonb_build_object('status','APPLIED','subjectId',NULL,'payload',payload,'anchorAt',anchor);
 END IF;
 IF category='ACCREDITATIONS' THEN
  SELECT c.* INTO item FROM domain.agreement_credential c WHERE c.issuer_tenant_id=scope_tenant AND c.id::text=target_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  SELECT s.account_id INTO subject FROM domain.agreement_subject s WHERE (s.agreement_id,s.id)=(item.agreement_id,item.subject_id) FOR SHARE;
 ELSE subject:=target_key; END IF;
 -- Lifecycle lock serializes account withdrawal with destructive identity work.
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 IF category='ACCREDITATIONS' THEN
  SELECT c.* INTO item FROM domain.agreement_credential c WHERE c.issuer_tenant_id=scope_tenant AND c.id::text=target_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 END IF;
 IF category='MUNICIPAL_PROFILE' THEN
  PERFORM 1 FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=subject FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 ELSIF category='AUTHORITY' THEN
  IF scope_tenant IS NOT NULL THEN
   PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject FOR UPDATE;
   PERFORM 1 FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY invitation_id FOR UPDATE;
  ELSE
   PERFORM 1 FROM domain.platform_operator WHERE account_id=subject FOR UPDATE;
   PERFORM 1 FROM domain.platform_operator_invitation WHERE account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.global_privacy_invitation WHERE account_id=subject ORDER BY id FOR UPDATE;
  END IF;
 END IF;
 IF category='AUTHORITY' AND domain.retention_authority_active(scope_tenant,subject) THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_AUTHORITY','subjectId',subject); END IF;
 anchor:=domain.retention_municipal_anchor(scope_tenant,category,target_key);
 IF anchor IS NULL THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 -- An already withdrawn target needs no further mutation. Its blocked archive
 -- may remain under hold while recovery verifies the original ledger.
 IF domain.retention_target_held(scope_tenant,category,target_key,subject) THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',subject); END IF;
 IF anchor>cutoff THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',subject); END IF;
 IF category='MUNICIPAL_PROFILE' THEN
  IF scope_tenant IS NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','MUNICIPAL_SCOPE_REQUIRED','subjectId',subject); END IF;
  -- A profile is an internal service relation, not a membership to cancel. Any
  -- retained booking, permission or accreditation blocks its removal.
  IF EXISTS(SELECT 1 FROM domain.reservation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id) WHERE c.issuer_tenant_id=scope_tenant AND s.account_id=subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','RETAINED_SERVICE_DEPENDENCIES','subjectId',subject); END IF;
  SELECT jsonb_build_object('municipalProfile',to_jsonb(p)) INTO payload FROM domain.municipal_profile p WHERE p.tenant_id=scope_tenant AND p.account_id=subject;
  DELETE FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=subject;
 ELSIF category='AUTHORITY' AND scope_tenant IS NOT NULL THEN
  SELECT jsonb_build_object(
   'administrators',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM domain.municipal_administrator a WHERE a.tenant_id=scope_tenant AND a.account_id=subject),'[]'::jsonb),
   'administratorInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'identityEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.identity_event e WHERE e.tenant_id=scope_tenant AND (e.subject_id=subject
    OR e.invitation_id IN (SELECT i.id FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject))),'[]'::jsonb),
   'managerInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.manager_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'managerGrants',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM domain.manager_grant g WHERE g.tenant_id=scope_tenant AND g.account_id=subject),'[]'::jsonb),
   'managerPermissions',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM domain.manager_permission p JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(p.tenant_id,p.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'managerEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.manager_event e JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.manager_event e USING domain.manager_invitation i WHERE (e.tenant_id,e.invitation_id)=(i.tenant_id,i.id) AND i.tenant_id=scope_tenant AND i.account_id=subject;
  DELETE FROM domain.manager_permission p USING domain.manager_invitation i WHERE (p.tenant_id,p.invitation_id)=(i.tenant_id,i.id) AND i.tenant_id=scope_tenant AND i.account_id=subject;
  UPDATE domain.manager_invitation SET replaces_invitation_id=NULL WHERE tenant_id=scope_tenant AND account_id=subject AND replaces_invitation_id IS NOT NULL;
  DELETE FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.identity_event WHERE tenant_id=scope_tenant AND (subject_id=subject OR invitation_id IN (SELECT i.id FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject));
  DELETE FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject;
 ELSIF category='AUTHORITY' THEN
  SELECT jsonb_build_object(
   'operators',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM domain.platform_operator p WHERE p.account_id=subject),'[]'::jsonb),
   'operatorInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.platform_operator_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'operatorEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.platform_operator_event e WHERE e.subject_id=subject
    OR e.invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=subject)),'[]'::jsonb),
   'privacyInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.global_privacy_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'privacyEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.global_privacy_permission_event e USING domain.global_privacy_invitation i WHERE e.invitation_id=i.id AND i.account_id=subject;
  DELETE FROM domain.global_privacy_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator_event WHERE subject_id=subject
   OR invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=subject);
  DELETE FROM domain.platform_operator_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator WHERE account_id=subject;
 ELSE
  IF item.revoked_at IS NULL AND item.ends_at>instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_ACCREDITATION','subjectId',subject); END IF;
  IF EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=item.agreement_id AND p.tenant_id<>scope_tenant)
   AND NOT domain.shared_retention_allowed(scope_tenant,category,item.id,requested_action,block_days,verified_replay) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','SHARED_CONTROLLER_REVIEW','subjectId',subject); END IF;
  payload:=jsonb_build_object('agreementCredential',to_jsonb(item));
  IF EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=item.agreement_id AND p.tenant_id<>scope_tenant) THEN
   payload:=payload||jsonb_build_object('sharedControllers',domain.shared_retention_material(scope_tenant,category,item.id)->'controllers');
  END IF;
  DELETE FROM domain.agreement_credential WHERE id=item.id;
 END IF;
 RETURN jsonb_build_object('status','APPLIED','subjectId',subject,'payload',payload,'anchorAt',anchor);
EXCEPTION WHEN foreign_key_violation THEN
 -- The exception block rolls back every earlier statement in this function,
 -- including deletes. A dependent historic record never causes partial erasure.
 RETURN jsonb_build_object('status','CONFLICT','reason','RETAINED_REFERENCE','subjectId',subject);
END $$;
