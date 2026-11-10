CREATE OR REPLACE FUNCTION domain.retention_booking_candidates(scope_tenant uuid,category text,cutoff timestamptz,batch_limit integer)
RETURNS TABLE(target_key text,subject_id text,anchor_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF scope_tenant IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff) OR batch_limit NOT BETWEEN 1 AND 100 THEN RETURN; END IF;
 IF category='COMMUNICATIONS' THEN
  RETURN QUERY SELECT e.id::text,r.account_id,greatest(e.occurred_at,coalesce(m.created_at,n.created_at),coalesce((SELECT max(coalesce(a.finished_at,a.started_at)) FROM domain.reservation_email_attempt a WHERE a.tenant_id=e.tenant_id AND a.event_id=e.id),e.occurred_at)) anchor
  FROM domain.reservation_event e JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id)
  LEFT JOIN domain.reservation_email m ON (m.tenant_id,m.event_id)=(e.tenant_id,e.id)
  LEFT JOIN domain.reservation_notice n ON (n.tenant_id,n.event_id)=(e.tenant_id,e.id)
  WHERE e.tenant_id=scope_tenant AND (m.event_id IS NOT NULL OR n.event_id IS NOT NULL)
  AND greatest(e.occurred_at,coalesce(m.created_at,n.created_at),coalesce((SELECT max(coalesce(a.finished_at,a.started_at)) FROM domain.reservation_email_attempt a WHERE a.tenant_id=e.tenant_id AND a.event_id=e.id),e.occurred_at))<=cutoff
  AND domain.retention_candidate_due(scope_tenant,category,e.id::text)
  ORDER BY anchor,e.id LIMIT batch_limit;
 ELSIF category='RESERVATIONS' THEN
  RETURN QUERY SELECT r.id::text,r.account_id,greatest(r.ends_at,coalesce((SELECT max(e.occurred_at) FROM domain.reservation_event e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id),r.created_at),(SELECT max(ce.occurred_at) FROM domain.agreement_consumption_event ce WHERE ce.tenant_id=r.tenant_id AND ce.reservation_id=r.id)) anchor
  FROM domain.reservation r WHERE r.tenant_id=scope_tenant
  AND greatest(r.ends_at,coalesce((SELECT max(e.occurred_at) FROM domain.reservation_event e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id),r.created_at),(SELECT max(ce.occurred_at) FROM domain.agreement_consumption_event ce WHERE ce.tenant_id=r.tenant_id AND ce.reservation_id=r.id))<=cutoff
  AND domain.retention_candidate_due(scope_tenant,category,r.id::text)
  ORDER BY anchor,r.id LIMIT batch_limit;
 END IF;
END $$;

-- The extra arguments are internal: runtime roles cannot invoke these helpers.
CREATE FUNCTION domain.retention_booking_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz,requested_action text,block_days integer,verified_replay boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item uuid; r domain.reservation; e domain.reservation_event; m domain.reservation_email; anchor timestamptz; payload jsonb;
BEGIN
 IF scope_tenant IS NULL OR category IS NULL OR category NOT IN ('COMMUNICATIONS','RESERVATIONS') OR cutoff IS NULL OR NOT isfinite(cutoff) OR cutoff>statement_timestamp() THEN RETURN jsonb_build_object('status','CONFLICT','reason','INVALID_TARGET'); END IF;
 BEGIN item:=target_key::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status','CONFLICT','reason','INVALID_TARGET'); END;
 IF category='COMMUNICATIONS' THEN
  SELECT * INTO e FROM domain.reservation_event WHERE tenant_id=scope_tenant AND id=item FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT'); END IF;
  SELECT * INTO r FROM domain.reservation WHERE tenant_id=scope_tenant AND id=e.reservation_id FOR UPDATE;
  SELECT * INTO m FROM domain.reservation_email WHERE tenant_id=scope_tenant AND event_id=item FOR UPDATE;
  IF m.event_id IS NULL AND NOT EXISTS(SELECT 1 FROM domain.reservation_notice WHERE tenant_id=scope_tenant AND event_id=item) THEN RETURN jsonb_build_object('status','ABSENT'); END IF;
  IF m.lease_until>statement_timestamp() THEN RETURN jsonb_build_object('status','CONFLICT','reason','EMAIL_IN_FLIGHT'); END IF;
  SELECT greatest(e.occurred_at,m.created_at,(SELECT created_at FROM domain.reservation_notice WHERE tenant_id=scope_tenant AND event_id=item),
   (SELECT max(coalesce(finished_at,started_at)) FROM domain.reservation_email_attempt WHERE tenant_id=scope_tenant AND event_id=item)) INTO anchor;
  IF anchor>cutoff OR domain.retention_target_held(scope_tenant,category,target_key,r.account_id) THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_ELIGIBLE_OR_HELD'); END IF;
  payload:=jsonb_build_object('eventContent',jsonb_build_object('eventId',e.id,'reservationId',e.reservation_id,'revision',e.revision,'kind',e.kind,'occurredAt',e.occurred_at,'after',domain.personal_reservation_snapshot(e.after_state)),'notice',(SELECT to_jsonb(n) FROM domain.reservation_notice n WHERE tenant_id=scope_tenant AND event_id=item),
   'email',(SELECT to_jsonb(n)-ARRAY['lease_token'] FROM domain.reservation_email n WHERE tenant_id=scope_tenant AND event_id=item),
   'attempts',coalesce((SELECT jsonb_agg(to_jsonb(n)-ARRAY['token']) FROM domain.reservation_email_attempt n WHERE tenant_id=scope_tenant AND event_id=item),'[]'::jsonb));
  DELETE FROM domain.reservation_email_attempt WHERE tenant_id=scope_tenant AND event_id=item;
  DELETE FROM domain.reservation_email WHERE tenant_id=scope_tenant AND event_id=item;
  DELETE FROM domain.reservation_notice WHERE tenant_id=scope_tenant AND event_id=item;
 ELSE
  SELECT * INTO r FROM domain.reservation WHERE tenant_id=scope_tenant AND id=item FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT'); END IF;
  SELECT greatest(r.ends_at,coalesce(max(occurred_at),r.created_at),(SELECT max(ce.occurred_at) FROM domain.agreement_consumption_event ce WHERE ce.tenant_id=scope_tenant AND ce.reservation_id=item)) INTO anchor FROM domain.reservation_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  IF anchor>cutoff OR r.ends_at>statement_timestamp() OR domain.retention_target_held(scope_tenant,category,target_key,r.account_id) THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_ELIGIBLE_OR_HELD'); END IF;
  -- A municipality cannot erase another controller's quota/accountability
  -- evidence through its own reservation policy, nor erase unexpired notices.
  IF EXISTS(SELECT 1 FROM domain.agreement_consumption WHERE tenant_id=scope_tenant AND reservation_id=item)
  OR EXISTS(SELECT 1 FROM domain.agreement_consumption_event WHERE tenant_id=scope_tenant AND reservation_id=item)
  THEN
   IF NOT domain.shared_retention_allowed(scope_tenant,category,item,requested_action,block_days,verified_replay) THEN RETURN jsonb_build_object('status','CONFLICT','reason','SHARED_CONTROLLER_REVIEW'); END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM domain.reservation_notice n JOIN domain.reservation_event v ON (v.tenant_id,v.id)=(n.tenant_id,n.event_id) WHERE v.tenant_id=scope_tenant AND v.reservation_id=item)
  OR EXISTS(SELECT 1 FROM domain.reservation_email n JOIN domain.reservation_event v ON (v.tenant_id,v.id)=(n.tenant_id,n.event_id) WHERE v.tenant_id=scope_tenant AND v.reservation_id=item)
  THEN RETURN jsonb_build_object('status','CONFLICT','reason','COMMUNICATIONS_RETENTION'); END IF;
  IF EXISTS(SELECT 1 FROM domain.idempotent_command c WHERE c.tenant_id=scope_tenant AND c.operation IN ('reservation.create','reservation.modify','reservation.cancel','reservation.accept-usage-rules') AND c.result->>'id'=item::text AND c.expires_at>statement_timestamp()) THEN RETURN jsonb_build_object('status','CONFLICT','reason','IDEMPOTENCY_WINDOW'); END IF;
  payload:=jsonb_build_object('reservation',to_jsonb(r),
   'events',coalesce((SELECT jsonb_agg(CASE WHEN v.actor_name IS NULL THEN to_jsonb(v)-'actor_name' ELSE to_jsonb(v) END ORDER BY revision) FROM domain.reservation_event v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb),
   'reads',coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM domain.reservation_read_event v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb),
   'occupancy',coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM domain.occupancy v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb));
  IF EXISTS(SELECT 1 FROM domain.agreement_consumption WHERE tenant_id=scope_tenant AND reservation_id=item) OR EXISTS(SELECT 1 FROM domain.agreement_consumption_event WHERE tenant_id=scope_tenant AND reservation_id=item) THEN
  payload:=payload || jsonb_build_object(
   'sharedControllers',domain.shared_retention_material(scope_tenant,category,item)->'controllers',
   'consumption',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.agreement_id) FROM domain.agreement_consumption c WHERE (c.tenant_id,c.reservation_id)=(scope_tenant,item)),'[]'::jsonb),
   'consumptionEvents',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM domain.agreement_consumption_event c WHERE (c.tenant_id,c.reservation_id)=(scope_tenant,item)),'[]'::jsonb));
  END IF;
  DELETE FROM domain.agreement_consumption_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.agreement_consumption WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.idempotent_command WHERE tenant_id=scope_tenant AND operation IN ('reservation.create','reservation.modify','reservation.cancel','reservation.accept-usage-rules') AND result->>'id'=item::text AND expires_at<=statement_timestamp();
  DELETE FROM domain.reservation_read_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.occupancy WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.reservation_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.reservation WHERE tenant_id=scope_tenant AND id=item;
 END IF;
 RETURN jsonb_build_object('status','APPLIED','subjectId',r.account_id,'payload',payload);
END $$;
REVOKE ALL ON FUNCTION domain.retention_booking_action(uuid,text,text,timestamptz,text,integer,boolean) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE OR REPLACE FUNCTION domain.retention_booking_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.retention_booking_action($1,$2,$3,$4,NULL,NULL,false)
$$;
CREATE FUNCTION domain.retention_municipal_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz,requested_action text,block_days integer,verified_replay boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; anchor timestamptz; payload jsonb; item domain.agreement_credential%ROWTYPE;
 instant timestamptz:=clock_timestamp(); access_item domain.personal_data_access_event%ROWTYPE; denial_item domain.access_denial%ROWTYPE;
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
   'identityEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.identity_event e WHERE e.tenant_id=scope_tenant AND e.subject_id=subject),'[]'::jsonb),
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
  DELETE FROM domain.identity_event WHERE tenant_id=scope_tenant AND subject_id=subject;
  DELETE FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject;
 ELSIF category='AUTHORITY' THEN
  SELECT jsonb_build_object(
   'operators',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM domain.platform_operator p WHERE p.account_id=subject),'[]'::jsonb),
   'operatorInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.platform_operator_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'operatorEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.platform_operator_event e WHERE e.subject_id=subject),'[]'::jsonb),
   'privacyInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.global_privacy_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'privacyEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.global_privacy_permission_event e USING domain.global_privacy_invitation i WHERE e.invitation_id=i.id AND i.account_id=subject;
  DELETE FROM domain.global_privacy_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator_event WHERE subject_id=subject;
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
REVOKE ALL ON FUNCTION domain.retention_municipal_action(uuid,text,text,timestamptz,text,integer,boolean) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE OR REPLACE FUNCTION domain.retention_municipal_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.retention_municipal_action($1,$2,$3,$4,NULL,NULL,false)
$$;

CREATE FUNCTION domain.retention_apply(scope_tenant uuid,category text,target_key text,cutoff timestamptz,requested_action text,block_days integer,verified_replay boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE material jsonb; outcome jsonb; approvals jsonb;
BEGIN
 IF verified_replay AND (NOT (session_user='quenda_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) OR NOT EXISTS(SELECT 1 FROM domain.retention_control WHERE id AND restore_review_required)) THEN RAISE EXCEPTION 'Forbidden replay' USING ERRCODE='42501'; END IF;
 IF category IN ('RESERVATIONS','ACCREDITATIONS') THEN
  BEGIN material:=domain.shared_retention_material(scope_tenant,category,target_key::uuid);
  EXCEPTION WHEN invalid_text_representation THEN material:=NULL; END;
  IF coalesce((material->>'shared')::boolean,false) THEN
   SELECT jsonb_agg(jsonb_build_object('reviewerTenantId',r.reviewer_tenant_id,'digest',r.digest,'actorId',r.actor_id,'authorizationReference',r.authorization_reference,'reason',r.reason,'reviewedAt',r.reviewed_at) ORDER BY r.reviewer_tenant_id) INTO approvals
   FROM domain.shared_retention_review r WHERE (r.owner_tenant_id,r.category,r.target_key)=(scope_tenant,$2,$3::uuid) AND r.approved AND r.digest=domain.shared_retention_digest(scope_tenant,$2,$3::uuid,requested_action,block_days,material);
  END IF;
 END IF;
 IF category IN ('COMMUNICATIONS','RESERVATIONS') THEN outcome:=domain.retention_booking_action(scope_tenant,category,target_key,cutoff,requested_action,block_days,verified_replay);
 ELSIF category IN ('IDENTITY','AUTHENTICATION') THEN outcome:=domain.retention_identity_action(scope_tenant,category,target_key,cutoff);
 ELSE outcome:=domain.retention_municipal_action(scope_tenant,category,target_key,cutoff,requested_action,block_days,verified_replay); END IF;
 IF outcome->>'status'='APPLIED' AND coalesce((material->>'shared')::boolean,false) AND NOT verified_replay THEN
  outcome:=outcome||jsonb_build_object('sharedAuthorization',jsonb_build_object('controllers',material->'controllers','reviews',approvals));
 END IF;
 RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION domain.retention_apply(uuid,text,text,timestamptz,text,integer,boolean) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
-- Keep legacy callers on the same UTC serialization as policies and replay.
CREATE OR REPLACE FUNCTION domain.retention_apply(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.retention_apply($1,$2,$3,$4,NULL,NULL,false)
$$;
CREATE FUNCTION domain.retention_archive_held(archived domain.retention_archive) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.retention_target_held(archived.tenant_id,archived.category,archived.target_key,archived.subject_id)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(archived.payload->'sharedControllers','[]'::jsonb)) controller WHERE domain.retention_target_held(controller.value::uuid,archived.category,archived.target_key,archived.subject_id))
$$;
REVOKE ALL ON FUNCTION domain.retention_archive_held(domain.retention_archive) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE OR REPLACE FUNCTION domain.process_retention_batch(batch_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE p domain.retention_policy; c record; archived domain.retention_archive; outcome jsonb; event_number bigint; processed integer:=0; conflicts integer:=0; examined integer:=0; cutoff timestamptz;
BEGIN
 IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='23514'; END IF;
 PERFORM domain.lock_retention_control();
 -- Existing legal archives have their own approved destruction date. Revoking a
 -- prospective policy does not extend an already-approved legal retention.
 FOR archived IN SELECT * FROM domain.retention_archive ra WHERE destroy_after<=statement_timestamp() AND NOT domain.retention_archive_held(ra) ORDER BY destroy_after,id LIMIT batch_limit FOR UPDATE LOOP
  IF domain.retention_archive_held(archived) THEN CONTINUE; END IF;
  DELETE FROM domain.retention_archive WHERE id=archived.id;
  INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action,details)
  VALUES('ARCHIVE_DESTROYED',archived.tenant_id,archived.category,archived.target_key,archived.subject_id,'ERASE',jsonb_build_object('archiveId',archived.id,'blockedEvent',archived.event_id));
  processed:=processed+1;
 END LOOP;
 FOR p IN SELECT * FROM domain.retention_policy WHERE revoked_at IS NULL AND superseded_at IS NULL ORDER BY last_scanned_at NULLS FIRST,approved_at,id FOR UPDATE LOOP
  EXIT WHEN examined>=batch_limit;
  UPDATE domain.retention_policy SET last_scanned_at=clock_timestamp() WHERE id=p.id;
  cutoff:=statement_timestamp()-make_interval(days=>p.retention_days);
  FOR c IN SELECT * FROM domain.retention_candidates(p.tenant_id,p.category,cutoff,batch_limit) LOOP
   EXIT WHEN examined>=batch_limit;
   examined:=examined+1;
   BEGIN
    IF domain.retention_target_held(p.tenant_id,p.category,c.target_key,c.subject_id) THEN outcome:=jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD');
    ELSE outcome:=domain.retention_apply(p.tenant_id,p.category,c.target_key,cutoff,p.action,p.block_days); END IF;
    IF outcome->>'status'='APPLIED' THEN
     INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,subject_id,action,authorization_reference,details)
     VALUES('RETENTION_APPLIED',p.id,p.tenant_id,p.category,c.target_key,outcome->>'subjectId',p.action,p.approval_reference,jsonb_build_object('cutoff',cutoff,'blockDays',p.block_days,'sharedAuthorization',outcome->'sharedAuthorization')) RETURNING id INTO event_number;
     IF p.action='BLOCK' THEN
      INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after)
      VALUES(gen_random_uuid(),event_number,p.tenant_id,p.category,c.target_key,outcome->>'subjectId',outcome->'payload',statement_timestamp()+make_interval(days=>p.block_days));
     END IF;
     DELETE FROM domain.retention_conflict WHERE policy_id=p.id AND target_key=c.target_key;
     processed:=processed+1;
    ELSIF outcome->>'status'='CONFLICT' THEN
     INSERT INTO domain.retention_conflict(policy_id,target_key,reason) VALUES(p.id,c.target_key,outcome->>'reason')
     ON CONFLICT(policy_id,target_key) DO UPDATE SET reason=EXCLUDED.reason,last_seen_at=clock_timestamp();
     INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,reason) VALUES('RETENTION_SKIPPED',p.id,p.tenant_id,p.category,c.target_key,outcome->>'reason');
     conflicts:=conflicts+1;
    ELSIF outcome->>'status' IS DISTINCT FROM 'ABSENT' THEN RAISE EXCEPTION 'Invalid retention result'; END IF;
   EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO domain.retention_conflict(policy_id,target_key,reason) VALUES(p.id,c.target_key,'PROTECTED_DEPENDENCY') ON CONFLICT(policy_id,target_key) DO UPDATE SET reason=EXCLUDED.reason,last_seen_at=clock_timestamp();
    INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,reason) VALUES('RETENTION_SKIPPED',p.id,p.tenant_id,p.category,c.target_key,'PROTECTED_DEPENDENCY');
    conflicts:=conflicts+1;
   END;
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('processed',processed,'conflicts',conflicts,'examined',examined);
END $$;
REVOKE ALL ON FUNCTION domain.process_retention_batch(integer) FROM PUBLIC,quenda_auth,quenda_domain;
GRANT EXECUTE ON FUNCTION domain.process_retention_batch(integer) TO quenda_worker;

CREATE OR REPLACE FUNCTION domain.execute_privacy_action(scope_tenant uuid,specification jsonb,correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE operation text:=specification->>'action'; category text:=specification->>'category'; target text:=specification->>'targetKey'; outcome jsonb; event_number bigint; block_days integer;
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 PERFORM domain.lock_retention_control();
 IF specification IS NULL OR jsonb_typeof(specification) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='23514'; END IF;
 IF correlation_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(specification) v WHERE v.key<>'blockDays' AND jsonb_typeof(v.value)<>'string')
 OR NOT specification ?& ARRAY['category','targetKey','action','authorizationReference','reason']
 OR (specification-ARRAY['category','targetKey','action','blockDays','authorizationReference','reason'])<>'{}'::jsonb
 OR category IS NULL OR category NOT IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')
 OR operation IS NULL OR operation NOT IN ('ERASE','BLOCK') OR coalesce(length(btrim(target)),0) NOT BETWEEN 1 AND 500
 OR coalesce(length(btrim(specification->>'authorizationReference')),0) NOT BETWEEN 1 AND 500 OR coalesce(length(btrim(specification->>'reason')),0) NOT BETWEEN 1 AND 500
 OR (category IN ('IDENTITY','AUTHENTICATION') AND scope_tenant IS NOT NULL)
 OR (category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND scope_tenant IS NULL)
 OR (operation='ERASE' AND specification ? 'blockDays')
 THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='23514'; END IF;
 IF operation='BLOCK' THEN
  IF coalesce(specification->>'blockDays','') !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'Invalid blocking period' USING ERRCODE='23514'; END IF;
  block_days:=(specification->>'blockDays')::integer;
  IF block_days>365000 THEN RAISE EXCEPTION 'Invalid blocking period' USING ERRCODE='23514'; END IF;
 END IF;
 BEGIN
  outcome:=domain.retention_apply(scope_tenant,category,target,statement_timestamp(),operation,block_days);
 EXCEPTION WHEN foreign_key_violation THEN outcome:=jsonb_build_object('status','CONFLICT','reason','PROTECTED_DEPENDENCY'); END;
 INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action,actor_id,authorization_reference,reason,correlation_id,details)
 VALUES(CASE WHEN outcome->>'status'='APPLIED' THEN 'RIGHTS_ACTION_APPLIED' ELSE 'RIGHTS_ACTION_SKIPPED' END,scope_tenant,category,target,outcome->>'subjectId',operation,current_setting('quenda.account_id',true),specification->>'authorizationReference',specification->>'reason',correlation_id,jsonb_build_object('cutoff',statement_timestamp(),'blockDays',block_days,'outcome',outcome->>'status','conflict',outcome->>'reason','sharedAuthorization',outcome->'sharedAuthorization')) RETURNING id INTO event_number;
 IF outcome->>'status'='APPLIED' AND operation='BLOCK' THEN
  INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after)
  VALUES(gen_random_uuid(),event_number,scope_tenant,category,target,outcome->>'subjectId',outcome->'payload',statement_timestamp()+make_interval(days=>block_days));
 END IF;
 RETURN (outcome-ARRAY['payload','subjectId','sharedAuthorization'])||jsonb_build_object('eventId',event_number::text);
END $$;
REVOKE ALL ON FUNCTION domain.execute_privacy_action(uuid,jsonb,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.execute_privacy_action(uuid,jsonb,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.retention_target_exists(scope_tenant uuid,scope_category text,target text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE kind text:=split_part(target,':',1); key text:=substring(target FROM position(':' IN target)+1);
BEGIN
 IF target IS NULL OR length(btrim(target)) NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM domain.retention_archive a WHERE a.tenant_id IS NOT DISTINCT FROM scope_tenant AND a.category=scope_category AND a.target_key=target) THEN RETURN true; END IF;
 IF scope_category IN ('RESERVATIONS','ACCREDITATIONS','COMMUNICATIONS') THEN
  BEGIN target:=target::uuid::text; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
 END IF;
 IF scope_tenant IS NOT NULL AND scope_category IN ('RESERVATIONS','ACCREDITATIONS') THEN
  IF EXISTS(SELECT 1 FROM domain.retention_archive a WHERE a.category=scope_category AND a.target_key=target AND (a.payload->'sharedControllers') ? scope_tenant::text) THEN RETURN true; END IF;
  IF scope_category='RESERVATIONS' AND EXISTS(
   SELECT 1 FROM domain.agreement_participant p WHERE p.tenant_id=scope_tenant AND p.agreement_id IN (
    SELECT c.agreement_id FROM domain.agreement_consumption c WHERE c.reservation_id=target::uuid
    UNION SELECT e.agreement_id FROM domain.agreement_consumption_event e WHERE e.reservation_id=target::uuid
   )
  ) THEN RETURN true; END IF;
  IF scope_category='ACCREDITATIONS' AND EXISTS(SELECT 1 FROM domain.agreement_credential c JOIN domain.agreement_participant p ON p.agreement_id=c.agreement_id WHERE c.id=target::uuid AND p.tenant_id=scope_tenant) THEN RETURN true; END IF;
 END IF;
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

CREATE FUNCTION domain.retention_canonical_target(category text,target text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF category IN ('RESERVATIONS','ACCREDITATIONS','COMMUNICATIONS') THEN
  BEGIN RETURN target::uuid::text; EXCEPTION WHEN invalid_text_representation THEN RETURN target; END;
 END IF;
 RETURN target;
END $$;
REVOKE ALL ON FUNCTION domain.retention_canonical_target(text,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE OR REPLACE FUNCTION domain.retention_target_held(scope_tenant uuid,scope_category text,target text,subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.retention_hold h WHERE h.tenant_id IS NOT DISTINCT FROM scope_tenant AND h.category=scope_category AND h.released_at IS NULL
 AND (domain.retention_canonical_target(scope_category,h.target_key)=domain.retention_canonical_target(scope_category,target) OR (h.subject_id=subject AND h.target_key IS NULL)))
$$;
