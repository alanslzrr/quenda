CREATE FUNCTION domain.retention_booking_candidates(scope_tenant uuid,category text,cutoff timestamptz,batch_limit integer)
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
  RETURN QUERY SELECT r.id::text,r.account_id,greatest(r.ends_at,coalesce((SELECT max(e.occurred_at) FROM domain.reservation_event e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id),r.created_at)) anchor
  FROM domain.reservation r WHERE r.tenant_id=scope_tenant
  AND greatest(r.ends_at,coalesce((SELECT max(e.occurred_at) FROM domain.reservation_event e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id),r.created_at))<=cutoff
  AND domain.retention_candidate_due(scope_tenant,category,r.id::text)
  ORDER BY anchor,r.id LIMIT batch_limit;
 END IF;
END $$;

CREATE FUNCTION domain.retention_booking_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
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
  SELECT greatest(r.ends_at,coalesce(max(occurred_at),r.created_at)) INTO anchor FROM domain.reservation_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  IF anchor>cutoff OR r.ends_at>statement_timestamp() OR domain.retention_target_held(scope_tenant,category,target_key,r.account_id) THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_ELIGIBLE_OR_HELD'); END IF;
  -- A municipality cannot erase another controller's quota/accountability
  -- evidence through its own reservation policy, nor erase unexpired notices.
  IF EXISTS(SELECT 1 FROM domain.agreement_consumption WHERE tenant_id=scope_tenant AND reservation_id=item)
  OR EXISTS(SELECT 1 FROM domain.agreement_consumption_event WHERE tenant_id=scope_tenant AND reservation_id=item)
  THEN RETURN jsonb_build_object('status','CONFLICT','reason','SHARED_CONTROLLER_REVIEW'); END IF;
  IF EXISTS(SELECT 1 FROM domain.reservation_notice n JOIN domain.reservation_event v ON (v.tenant_id,v.id)=(n.tenant_id,n.event_id) WHERE v.tenant_id=scope_tenant AND v.reservation_id=item)
  OR EXISTS(SELECT 1 FROM domain.reservation_email n JOIN domain.reservation_event v ON (v.tenant_id,v.id)=(n.tenant_id,n.event_id) WHERE v.tenant_id=scope_tenant AND v.reservation_id=item)
  THEN RETURN jsonb_build_object('status','CONFLICT','reason','COMMUNICATIONS_RETENTION'); END IF;
  IF EXISTS(SELECT 1 FROM domain.idempotent_command c WHERE c.tenant_id=scope_tenant AND c.operation IN ('reservation.create','reservation.modify','reservation.cancel','reservation.accept-usage-rules') AND c.result->>'id'=item::text AND c.expires_at>statement_timestamp()) THEN RETURN jsonb_build_object('status','CONFLICT','reason','IDEMPOTENCY_WINDOW'); END IF;
  payload:=jsonb_build_object('reservation',to_jsonb(r),
   'events',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY revision) FROM domain.reservation_event v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb),
   'reads',coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM domain.reservation_read_event v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb),
   'occupancy',coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM domain.occupancy v WHERE tenant_id=scope_tenant AND reservation_id=item),'[]'::jsonb));
  DELETE FROM domain.idempotent_command WHERE tenant_id=scope_tenant AND operation IN ('reservation.create','reservation.modify','reservation.cancel','reservation.accept-usage-rules') AND result->>'id'=item::text AND expires_at<=statement_timestamp();
  DELETE FROM domain.reservation_read_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.occupancy WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.reservation_event WHERE tenant_id=scope_tenant AND reservation_id=item;
  DELETE FROM domain.reservation WHERE tenant_id=scope_tenant AND id=item;
 END IF;
 RETURN jsonb_build_object('status','APPLIED','subjectId',r.account_id,'payload',payload);
END $$;
REVOKE ALL ON FUNCTION domain.retention_booking_candidates(uuid,text,timestamptz,integer),domain.retention_booking_action(uuid,text,text,timestamptz) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
