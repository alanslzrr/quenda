ALTER TABLE domain.reservation
 ADD COLUMN usage_rules_version integer,
 ADD COLUMN rules_accepted_at timestamptz,
 ADD COLUMN booking_policy_version integer,
 ADD COLUMN conditions_accepted_at timestamptz,
 ADD COLUMN non_cancellable_accepted boolean,
 ADD FOREIGN KEY(tenant_id,unit_id,usage_rules_version) REFERENCES domain.unit_usage_rules(tenant_id,unit_id,version),
 ADD CHECK((usage_rules_version IS NULL AND rules_accepted_at IS NULL AND booking_policy_version IS NULL AND conditions_accepted_at IS NULL AND non_cancellable_accepted IS NULL)
 OR (usage_rules_version IS NOT NULL AND usage_rules_version>0 AND rules_accepted_at IS NOT NULL AND isfinite(rules_accepted_at) AND booking_policy_version IS NOT NULL AND booking_policy_version>0 AND conditions_accepted_at IS NOT NULL AND isfinite(conditions_accepted_at) AND non_cancellable_accepted IS NOT NULL));
GRANT UPDATE(usage_rules_version,rules_accepted_at,booking_policy_version,conditions_accepted_at,non_cancellable_accepted) ON domain.reservation TO quenda_domain;

CREATE FUNCTION domain.reservation_conditions(tenant uuid,resource uuid)
RETURNS TABLE(usage_rules_version integer,booking_policy_version integer,cancellation_minutes integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.usage_rules_version,m.booking_policy_version,m.cancellation_minutes
 FROM domain.reservable_unit u JOIN domain.municipality m ON m.id=u.tenant_id
 JOIN domain.unit_usage_rules v ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.usage_rules_version)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE u.tenant_id=tenant AND u.id=resource AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND v.text_content ~ '[^[:space:]]'
 FOR SHARE OF u,m,f
$$;
REVOKE ALL ON FUNCTION domain.reservation_conditions(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.reservation_conditions(uuid,uuid) TO quenda_domain;

CREATE FUNCTION domain.reservation_snapshot(r domain.reservation) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT jsonb_build_object('unitId',r.unit_id,'calendarVersion',r.calendar_version,
 'startsAt',r.starts_at,'endsAt',r.ends_at,'status',r.status,'revision',r.revision,
 'cancellationMinutes',r.cancellation_minutes,'timezone',r.timezone,
 'usageRulesVersion',r.usage_rules_version,'rulesAcceptedAt',r.rules_accepted_at,
 'bookingPolicyVersion',r.booking_policy_version,'conditionsAcceptedAt',r.conditions_accepted_at,
 'nonCancellableAccepted',r.non_cancellable_accepted)
$$;
REVOKE ALL ON FUNCTION domain.reservation_snapshot(domain.reservation) FROM PUBLIC;

ALTER TABLE domain.reservation_event ADD COLUMN administrative boolean;
DROP FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text);
CREATE FUNCTION domain.append_reservation_event(reservation uuid,event uuid,correlation uuid,motive text,administrative_operation boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_reservation domain.reservation%ROWTYPE; previous domain.reservation_event%ROWTYPE;
 snapshot jsonb; event_kind text;
BEGIN
 SELECT * INTO current_reservation FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation FOR UPDATE;
 IF NOT FOUND OR actor IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF current_reservation.account_id<>actor AND NOT domain.lock_permission('RESERVATION_MANAGE',current_reservation.unit_id) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
 END IF;
 IF (current_reservation.account_id<>actor OR administrative_operation) AND (motive IS NULL OR length(btrim(motive))=0) THEN
  RAISE EXCEPTION 'Administrative reason required' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM domain.reservation_event e WHERE e.tenant_id=tenant AND e.reservation_id=reservation ORDER BY revision DESC LIMIT 1;
 IF current_reservation.revision<>coalesce(previous.revision,0)+1 OR previous.kind='CANCELADA' THEN
  RAISE EXCEPTION 'Invalid event revision' USING ERRCODE='23514';
 END IF;
 IF previous.id IS NULL AND current_reservation.status<>'CONFIRMADA' THEN
  RAISE EXCEPTION 'Invalid initial event' USING ERRCODE='23514';
 END IF;
 event_kind:=CASE WHEN previous.id IS NULL THEN 'CONFIRMADA' WHEN current_reservation.status='CANCELADA' THEN 'CANCELADA' ELSE 'MODIFICADA' END;
 snapshot:=domain.reservation_snapshot(current_reservation);
 INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,reason,before_state,after_state,administrative)
 VALUES(tenant,event,reservation,current_reservation.revision,event_kind,actor,correlation,motive,previous.after_state,snapshot,administrative_operation OR current_reservation.account_id<>actor);
 INSERT INTO domain.reservation_notice(tenant_id,event_id,account_id) VALUES(tenant,event,current_reservation.account_id);
 INSERT INTO domain.reservation_email(tenant_id,event_id) VALUES(tenant,event);
END $$;
REVOKE ALL ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text,boolean) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.check_reservation_event_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE tenant uuid:=NEW.tenant_id; reservation uuid; expected jsonb;
 current_reservation domain.reservation%ROWTYPE; latest domain.reservation_event%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='reservation' THEN reservation:=NEW.id; ELSE reservation:=NEW.reservation_id; END IF;
 SELECT * INTO latest FROM domain.reservation_event e WHERE e.tenant_id=tenant AND e.reservation_id=reservation ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO current_reservation FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation;
 expected:=domain.reservation_snapshot(current_reservation);
 -- Old audit records remain byte-for-byte unchanged, with explicitly absent evidence.
 IF NOT latest.after_state ? 'usageRulesVersion' AND current_reservation.usage_rules_version IS NULL THEN
 expected:=expected-ARRAY['usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted']; END IF;
 IF latest.revision<>current_reservation.revision OR latest.after_state IS DISTINCT FROM expected THEN
 RAISE EXCEPTION 'Inconsistent event snapshot' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

DROP FUNCTION domain.own_reservations(uuid,uuid);
CREATE FUNCTION domain.own_reservations(after_id uuid,after_tenant uuid)
RETURNS TABLE(tenant_id uuid,id uuid,unit_id uuid,starts_at timestamptz,ends_at timestamptz,status text,
 revision integer,calendar_version integer,cancellation_minutes integer,timezone text,municipality text,unit_name text,usage_rules_version integer,rules_accepted_at timestamptz,booking_policy_version integer,conditions_accepted_at timestamptz,non_cancellable_accepted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.unit_id,r.starts_at,r.ends_at,r.status,r.revision,r.calendar_version,r.cancellation_minutes,r.timezone,m.name,u.name,r.usage_rules_version,r.rules_accepted_at,r.booking_policy_version,r.conditions_accepted_at,r.non_cancellable_accepted
 FROM domain.reservation r JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND (after_id IS NULL OR (r.id,r.tenant_id)>(after_id,after_tenant))
 ORDER BY r.id,r.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservations(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_reservations(uuid,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.reservation_export(from_date date,to_date date,unit uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 zone text; first_instant timestamptz; last_instant timestamptz; observed timestamptz:=statement_timestamp(); items jsonb;
BEGIN
 IF NOT domain.lock_permission('DATA_EXPORT',unit) OR NOT (domain.lock_permission('RESERVATION_READ',unit) OR domain.lock_permission('RESERVATION_MANAGE',unit)) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
 END IF;
 IF from_date IS NULL OR to_date IS NULL OR NOT isfinite(from_date) OR NOT isfinite(to_date) OR to_date-from_date NOT BETWEEN 1 AND 366 THEN
  RAISE EXCEPTION 'Invalid period' USING ERRCODE='23514';
 END IF;
 SELECT m.timezone INTO zone FROM domain.municipality m WHERE m.id=tenant;
 IF NOT FOUND OR (unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.reservable_unit u WHERE u.tenant_id=tenant AND u.id=unit)) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 first_instant:=from_date::timestamp AT TIME ZONE zone;
 last_instant:=to_date::timestamp AT TIME ZONE zone;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'unitId',r.unit_id,'accountId',r.account_id,
  'startsAt',r.starts_at,'endsAt',r.ends_at,'status',CASE WHEN r.status='CONFIRMADA' AND r.ends_at<=observed THEN 'FINALIZADA' ELSE r.status END,
  'revision',r.revision,'calendarVersion',r.calendar_version,'cancellationMinutes',r.cancellation_minutes,'timeZone',r.timezone,'usageRulesVersion',r.usage_rules_version,'rulesAcceptedAt',r.rules_accepted_at,'bookingPolicyVersion',r.booking_policy_version,'conditionsAcceptedAt',r.conditions_accepted_at,'nonCancellableAccepted',r.non_cancellable_accepted,'usageRulesText',v.text_content) ORDER BY r.id),'[]'::jsonb)
 INTO items FROM (SELECT * FROM domain.reservation r WHERE r.tenant_id=tenant AND (unit IS NULL OR r.unit_id=unit)
  AND r.starts_at<last_instant AND r.ends_at>first_instant ORDER BY r.id LIMIT 10001) r
 LEFT JOIN domain.unit_usage_rules v ON (v.tenant_id,v.unit_id,v.version)=(r.tenant_id,r.unit_id,r.usage_rules_version);
 IF jsonb_array_length(items)>10000 THEN RAISE EXCEPTION 'Export period too large' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('format','quenda.reservations','version',2,'tenantId',tenant,'unitId',unit,'generatedAt',observed,
  'period',jsonb_build_object('from',from_date,'to',to_date,'timeZone',zone,'selection','overlap'),
  'entities',jsonb_build_array('reservations'),'reservations',items);
END $$;
REVOKE ALL ON FUNCTION domain.reservation_export(date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.reservation_export(date,date,uuid) TO quenda_domain;

-- Historical rows stay nullable. Runtime cannot create new unevidenced bookings,
-- manufacture a different holder's acceptance, or remove existing evidence.
CREATE FUNCTION domain.guard_reservation_acceptance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_rules integer; current_policy integer; current_cancellation integer; changed boolean;
BEGIN
 IF session_user='quenda_migrator' THEN RETURN NEW; END IF;
 changed:=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN
 changed:=(NEW.unit_id,NEW.cancellation_minutes,NEW.usage_rules_version,NEW.rules_accepted_at,NEW.booking_policy_version,NEW.conditions_accepted_at,NEW.non_cancellable_accepted)
 IS DISTINCT FROM (OLD.unit_id,OLD.cancellation_minutes,OLD.usage_rules_version,OLD.rules_accepted_at,OLD.booking_policy_version,OLD.conditions_accepted_at,OLD.non_cancellable_accepted);
 END IF;
 IF NOT changed THEN
  IF TG_OP='UPDATE' AND (NEW.starts_at,NEW.ends_at) IS DISTINCT FROM (OLD.starts_at,OLD.ends_at) THEN
   SELECT c.usage_rules_version INTO current_rules FROM domain.reservation_conditions(NEW.tenant_id,NEW.unit_id) c;
   IF NEW.usage_rules_version IS NULL OR current_rules IS DISTINCT FROM NEW.usage_rules_version THEN
    RAISE EXCEPTION 'Holder acceptance required for schedule change' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF actor IS DISTINCT FROM NEW.account_id OR NEW.usage_rules_version IS NULL OR NEW.rules_accepted_at IS NULL OR NEW.booking_policy_version IS NULL
 OR NEW.conditions_accepted_at IS NULL OR NEW.non_cancellable_accepted IS NULL THEN
 RAISE EXCEPTION 'Explicit holder acceptance required' USING ERRCODE='23514'; END IF;
 SELECT c.usage_rules_version,c.booking_policy_version,c.cancellation_minutes INTO current_rules,current_policy,current_cancellation
 FROM domain.reservation_conditions(NEW.tenant_id,NEW.unit_id) c;
 IF NOT FOUND OR (NEW.usage_rules_version,NEW.booking_policy_version,NEW.cancellation_minutes) IS DISTINCT FROM (current_rules,current_policy,current_cancellation) THEN
 RAISE EXCEPTION 'Stale accepted conditions' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION domain.guard_reservation_acceptance() FROM PUBLIC;
CREATE TRIGGER reservation_acceptance_guard BEFORE INSERT OR UPDATE ON domain.reservation
 FOR EACH ROW EXECUTE FUNCTION domain.guard_reservation_acceptance();

CREATE FUNCTION domain.accepted_usage_rules(reservation_id_arg uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r domain.reservation%ROWTYPE; content text;
BEGIN
 SELECT b.* INTO r FROM domain.reservation b WHERE b.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND b.id=reservation_id_arg;
 IF NOT FOUND OR NOT coalesce((r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_READ',r.unit_id) OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)),false) THEN
 RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT text_content INTO content FROM domain.unit_usage_rules WHERE (tenant_id,unit_id,version)=(r.tenant_id,r.unit_id,r.usage_rules_version);
 RETURN content;
END $$;
REVOKE ALL ON FUNCTION domain.accepted_usage_rules(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.accepted_usage_rules(uuid) TO quenda_domain;
