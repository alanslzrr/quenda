-- Accepted rules identify their original unit; pending rules belong to the
-- reservation's current unit. Neither field is a new reservation status.
ALTER TABLE domain.reservation
 ADD COLUMN usage_rules_unit_id uuid,
 ADD COLUMN pending_usage_rules_version integer;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='domain.reservation'::regclass
 AND ((contype='f' AND confrelid='domain.unit_usage_rules'::regclass)
 OR (contype='c' AND pg_get_constraintdef(oid) LIKE '%usage_rules_version%')) LOOP
 EXECUTE format('ALTER TABLE domain.reservation DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
-- The previous foreign key proves this unit for existing genuine evidence.
-- Historical NULL evidence and immutable audit events are not manufactured.
UPDATE domain.reservation SET usage_rules_unit_id=unit_id WHERE usage_rules_version IS NOT NULL;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE domain.reservation
 ADD CONSTRAINT reservation_accepted_rules_fk FOREIGN KEY(tenant_id,usage_rules_unit_id,usage_rules_version)
 REFERENCES domain.unit_usage_rules(tenant_id,unit_id,version),
 ADD CONSTRAINT reservation_pending_rules_fk FOREIGN KEY(tenant_id,unit_id,pending_usage_rules_version)
 REFERENCES domain.unit_usage_rules(tenant_id,unit_id,version),
 ADD CONSTRAINT reservation_rules_evidence CHECK(
 (usage_rules_unit_id IS NULL AND usage_rules_version IS NULL AND rules_accepted_at IS NULL)
 OR (usage_rules_unit_id IS NOT NULL AND usage_rules_version IS NOT NULL AND usage_rules_version>0 AND rules_accepted_at IS NOT NULL AND isfinite(rules_accepted_at))),
 ADD CONSTRAINT reservation_policy_evidence CHECK(
 (booking_policy_version IS NULL AND conditions_accepted_at IS NULL AND non_cancellable_accepted IS NULL)
 OR (booking_policy_version IS NOT NULL AND booking_policy_version>0 AND conditions_accepted_at IS NOT NULL AND isfinite(conditions_accepted_at) AND non_cancellable_accepted IS NOT NULL)),
 ADD CONSTRAINT reservation_pending_rules_positive CHECK(pending_usage_rules_version>0);
SET CONSTRAINTS ALL DEFERRED;
GRANT UPDATE(usage_rules_unit_id,pending_usage_rules_version) ON domain.reservation TO quenda_domain;
ALTER TABLE domain.reservation_event DROP CONSTRAINT reservation_event_kind_check;
ALTER TABLE domain.reservation_event ADD CONSTRAINT reservation_event_kind_check
 CHECK(kind IN ('CONFIRMADA','MODIFICADA','CANCELADA','NORMAS_ACEPTADAS'));

CREATE OR REPLACE FUNCTION domain.reservation_snapshot(r domain.reservation) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT jsonb_build_object('unitId',r.unit_id,'calendarVersion',r.calendar_version,
 'startsAt',r.starts_at,'endsAt',r.ends_at,'status',r.status,'revision',r.revision,
 'cancellationMinutes',r.cancellation_minutes,'timezone',r.timezone,
 'usageRulesVersion',r.usage_rules_version,'rulesAcceptedAt',r.rules_accepted_at,
 'bookingPolicyVersion',r.booking_policy_version,'conditionsAcceptedAt',r.conditions_accepted_at,
 'nonCancellableAccepted',r.non_cancellable_accepted,
 'usageRulesUnitId',r.usage_rules_unit_id,'pendingUsageRulesVersion',r.pending_usage_rules_version)
$$;

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
 IF NOT latest.after_state ? 'usageRulesVersion' AND current_reservation.usage_rules_version IS NULL
 AND current_reservation.booking_policy_version IS NULL THEN
 expected:=expected-ARRAY['usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted']; END IF;
 IF NOT latest.after_state ? 'usageRulesUnitId' AND current_reservation.pending_usage_rules_version IS NULL
 AND (current_reservation.usage_rules_unit_id IS NULL OR current_reservation.usage_rules_unit_id=current_reservation.unit_id) THEN
 expected:=expected-ARRAY['usageRulesUnitId','pendingUsageRulesVersion']; END IF;
 IF latest.revision<>current_reservation.revision OR latest.after_state IS DISTINCT FROM expected THEN
 RAISE EXCEPTION 'Inconsistent event snapshot' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION domain.guard_reservation_acceptance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_rules integer; current_policy integer; current_cancellation integer;
 moved boolean; same_evidence boolean; same_policy boolean; expected_pending integer;
BEGIN
 IF session_user='quenda_migrator' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  moved:=(NEW.unit_id,NEW.starts_at,NEW.ends_at) IS DISTINCT FROM (OLD.unit_id,OLD.starts_at,OLD.ends_at);
  same_evidence:=(NEW.usage_rules_unit_id,NEW.usage_rules_version,NEW.rules_accepted_at)
   IS NOT DISTINCT FROM (OLD.usage_rules_unit_id,OLD.usage_rules_version,OLD.rules_accepted_at);
  same_policy:=(NEW.cancellation_minutes,NEW.booking_policy_version,NEW.conditions_accepted_at,NEW.non_cancellable_accepted)
   IS NOT DISTINCT FROM (OLD.cancellation_minutes,OLD.booking_policy_version,OLD.conditions_accepted_at,OLD.non_cancellable_accepted);
  IF NOT moved THEN
   -- Cancellation never creates, removes or changes consent.
   IF same_evidence AND same_policy AND NEW.pending_usage_rules_version IS NOT DISTINCT FROM OLD.pending_usage_rules_version THEN RETURN NEW; END IF;
   -- Holder-only acceptance of the pinned reference, independent of later
   -- publications and of the cancellation policy accepted before relocation.
   IF actor IS NOT DISTINCT FROM NEW.account_id AND NEW.status='CONFIRMADA' AND OLD.status='CONFIRMADA'
   AND OLD.pending_usage_rules_version IS NOT NULL AND NEW.pending_usage_rules_version IS NULL
   AND (NEW.usage_rules_unit_id,NEW.usage_rules_version) IS NOT DISTINCT FROM (OLD.unit_id,OLD.pending_usage_rules_version)
   AND NEW.rules_accepted_at IS NOT NULL AND same_policy
   AND (NEW.calendar_version,NEW.timezone) IS NOT DISTINCT FROM (OLD.calendar_version,OLD.timezone) THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Invalid consent-only change' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>'CONFIRMADA' OR OLD.status<>'CONFIRMADA' THEN
   RAISE EXCEPTION 'Invalid relocation status' USING ERRCODE='23514'; END IF;
  SELECT c.usage_rules_version,c.booking_policy_version,c.cancellation_minutes INTO current_rules,current_policy,current_cancellation
  FROM domain.reservation_conditions(NEW.tenant_id,NEW.unit_id) c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing destination conditions' USING ERRCODE='23514'; END IF;
  expected_pending:=CASE WHEN NEW.usage_rules_unit_id=NEW.unit_id AND NEW.usage_rules_version=current_rules THEN NULL ELSE current_rules END;
  IF same_evidence AND same_policy AND NEW.pending_usage_rules_version IS NOT DISTINCT FROM expected_pending
  AND domain.lock_permission('RESERVATION_MANAGE',OLD.unit_id) AND domain.lock_permission('RESERVATION_MANAGE',NEW.unit_id) THEN RETURN NEW; END IF;
 ELSE
  SELECT c.usage_rules_version,c.booking_policy_version,c.cancellation_minutes INTO current_rules,current_policy,current_cancellation
  FROM domain.reservation_conditions(NEW.tenant_id,NEW.unit_id) c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing destination conditions' USING ERRCODE='23514'; END IF;
 END IF;
 -- Creation or a real holder modification uses current complete conditions.
 IF actor IS DISTINCT FROM NEW.account_id OR NEW.usage_rules_unit_id IS DISTINCT FROM NEW.unit_id
 OR NEW.pending_usage_rules_version IS NOT NULL OR NEW.usage_rules_version IS NULL OR NEW.rules_accepted_at IS NULL
 OR NEW.booking_policy_version IS NULL OR NEW.conditions_accepted_at IS NULL OR NEW.non_cancellable_accepted IS NULL
 OR (NEW.usage_rules_version,NEW.booking_policy_version,NEW.cancellation_minutes)
 IS DISTINCT FROM (current_rules,current_policy,current_cancellation) THEN
 RAISE EXCEPTION 'Explicit current holder acceptance required' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.pending_usage_rules_version IS NOT NULL AND same_evidence THEN
 RAISE EXCEPTION 'Pending holder acceptance required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

DROP FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text,boolean);
CREATE FUNCTION domain.append_reservation_event(reservation uuid,event uuid,correlation uuid,motive text,administrative_operation boolean DEFAULT false,acceptance_operation boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_reservation domain.reservation%ROWTYPE; previous domain.reservation_event%ROWTYPE;
 snapshot jsonb; event_kind text; old_snapshot jsonb; consent_fields text[]:=ARRAY['revision','usageRulesUnitId','usageRulesVersion','rulesAcceptedAt','pendingUsageRulesVersion'];
BEGIN
 SELECT * INTO current_reservation FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation FOR UPDATE;
 IF NOT FOUND OR actor IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF (current_reservation.account_id<>actor OR administrative_operation)
 AND NOT domain.lock_permission('RESERVATION_MANAGE',current_reservation.unit_id) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF (current_reservation.account_id<>actor OR administrative_operation) AND (motive IS NULL OR length(btrim(motive))=0) THEN
  RAISE EXCEPTION 'Administrative reason required' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM domain.reservation_event e WHERE e.tenant_id=tenant AND e.reservation_id=reservation ORDER BY revision DESC LIMIT 1;
 IF current_reservation.revision<>coalesce(previous.revision,0)+1 OR previous.kind='CANCELADA' THEN
  RAISE EXCEPTION 'Invalid event revision' USING ERRCODE='23514'; END IF;
 IF previous.id IS NULL AND current_reservation.status<>'CONFIRMADA' THEN
  RAISE EXCEPTION 'Invalid initial event' USING ERRCODE='23514'; END IF;
 snapshot:=domain.reservation_snapshot(current_reservation);
 IF acceptance_operation THEN
  IF previous.id IS NULL OR actor<>current_reservation.account_id OR administrative_operation OR motive IS NOT NULL
  OR current_reservation.status<>'CONFIRMADA' OR current_reservation.pending_usage_rules_version IS NOT NULL
  OR current_reservation.usage_rules_unit_id IS DISTINCT FROM current_reservation.unit_id
  OR previous.after_state->>'pendingUsageRulesVersion' IS NULL
  OR current_reservation.usage_rules_version IS DISTINCT FROM (previous.after_state->>'pendingUsageRulesVersion')::integer
  OR (snapshot-consent_fields) IS DISTINCT FROM (previous.after_state-consent_fields) THEN
   RAISE EXCEPTION 'Invalid holder consent event' USING ERRCODE='23514'; END IF;
  event_kind:='NORMAS_ACEPTADAS';
 ELSE
  event_kind:=CASE WHEN previous.id IS NULL THEN 'CONFIRMADA' WHEN current_reservation.status='CANCELADA' THEN 'CANCELADA' ELSE 'MODIFICADA' END;
  -- An evidence-only revision must be identified as consent, not reported as a
  -- relocated booking or used to generate duplicate modification notices.
  IF event_kind='MODIFICADA' AND previous.after_state->>'pendingUsageRulesVersion' IS NOT NULL
  AND current_reservation.pending_usage_rules_version IS NULL
  AND (snapshot-consent_fields) IS NOT DISTINCT FROM (previous.after_state-consent_fields) THEN
   RAISE EXCEPTION 'Consent event required' USING ERRCODE='23514'; END IF;
 END IF;
 IF previous.id IS NOT NULL AND (current_reservation.account_id<>actor OR administrative_operation) THEN
  IF NOT domain.lock_permission('RESERVATION_MANAGE',(previous.after_state->>'unitId')::uuid) THEN
   RAISE EXCEPTION 'Forbidden source unit' USING ERRCODE='42501'; END IF;
  old_snapshot:=jsonb_build_object('usageRulesVersion',NULL,'rulesAcceptedAt',NULL,'bookingPolicyVersion',NULL,'conditionsAcceptedAt',NULL,'nonCancellableAccepted',NULL)
    || previous.after_state;
  IF NOT old_snapshot ? 'usageRulesUnitId' THEN
   old_snapshot:=old_snapshot || jsonb_build_object('usageRulesUnitId',CASE WHEN old_snapshot->>'usageRulesVersion' IS NULL THEN NULL ELSE old_snapshot->>'unitId' END);
  END IF;
  IF (snapshot->'usageRulesUnitId',snapshot->'cancellationMinutes',snapshot->'usageRulesVersion',snapshot->'rulesAcceptedAt',snapshot->'bookingPolicyVersion',snapshot->'conditionsAcceptedAt',snapshot->'nonCancellableAccepted')
  IS DISTINCT FROM (old_snapshot->'usageRulesUnitId',old_snapshot->'cancellationMinutes',old_snapshot->'usageRulesVersion',old_snapshot->'rulesAcceptedAt',old_snapshot->'bookingPolicyVersion',old_snapshot->'conditionsAcceptedAt',old_snapshot->'nonCancellableAccepted') THEN
   RAISE EXCEPTION 'Administrative operation cannot accept conditions' USING ERRCODE='23514'; END IF;
 END IF;
 INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,reason,before_state,after_state,administrative)
 VALUES(tenant,event,reservation,current_reservation.revision,event_kind,actor,correlation,motive,previous.after_state,snapshot,administrative_operation OR current_reservation.account_id<>actor);
 IF NOT acceptance_operation THEN
  INSERT INTO domain.reservation_notice(tenant_id,event_id,account_id) VALUES(tenant,event,current_reservation.account_id);
  INSERT INTO domain.reservation_email(tenant_id,event_id) VALUES(tenant,event);
 END IF;
END $$;
REVOKE ALL ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text,boolean,boolean) TO quenda_domain;
DROP FUNCTION domain.own_reservations(uuid,uuid);
CREATE FUNCTION domain.own_reservations(after_id uuid,after_tenant uuid)
RETURNS TABLE(tenant_id uuid,id uuid,unit_id uuid,starts_at timestamptz,ends_at timestamptz,status text,
 revision integer,calendar_version integer,cancellation_minutes integer,timezone text,municipality text,unit_name text,
 usage_rules_version integer,rules_accepted_at timestamptz,booking_policy_version integer,conditions_accepted_at timestamptz,
 non_cancellable_accepted boolean,usage_rules_unit_id uuid,pending_usage_rules_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.unit_id,r.starts_at,r.ends_at,r.status,r.revision,r.calendar_version,r.cancellation_minutes,r.timezone,
 m.name,u.name,r.usage_rules_version,r.rules_accepted_at,r.booking_policy_version,r.conditions_accepted_at,r.non_cancellable_accepted,
 r.usage_rules_unit_id,r.pending_usage_rules_version
 FROM domain.reservation r JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND (after_id IS NULL OR (r.id,r.tenant_id)>(after_id,after_tenant))
 ORDER BY r.id,r.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservations(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservations(uuid,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.accepted_usage_rules(reservation_id_arg uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r domain.reservation%ROWTYPE; content text;
BEGIN
 SELECT b.* INTO r FROM domain.reservation b WHERE b.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND b.id=reservation_id_arg;
 IF NOT FOUND OR NOT coalesce((r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_READ',r.unit_id) OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)),false) THEN
 RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT text_content INTO content FROM domain.unit_usage_rules WHERE (tenant_id,unit_id,version)=(r.tenant_id,r.usage_rules_unit_id,r.usage_rules_version);
 RETURN content;
END $$;
REVOKE ALL ON FUNCTION domain.accepted_usage_rules(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.accepted_usage_rules(uuid) TO quenda_domain;

CREATE FUNCTION domain.pending_usage_rules(reservation_id_arg uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r domain.reservation%ROWTYPE; content text;
BEGIN
 SELECT b.* INTO r FROM domain.reservation b WHERE b.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND b.id=reservation_id_arg;
 IF NOT FOUND OR NOT coalesce((r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_READ',r.unit_id) OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)),false) THEN
 RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT text_content INTO content FROM domain.unit_usage_rules WHERE (tenant_id,unit_id,version)=(r.tenant_id,r.unit_id,r.pending_usage_rules_version);
 RETURN content;
END $$;
REVOKE ALL ON FUNCTION domain.pending_usage_rules(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.pending_usage_rules(uuid) TO quenda_domain;

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
  'revision',r.revision,'calendarVersion',r.calendar_version,'cancellationMinutes',r.cancellation_minutes,'timeZone',r.timezone,
  'usageRulesUnitId',r.usage_rules_unit_id,'usageRulesVersion',r.usage_rules_version,'rulesAcceptedAt',r.rules_accepted_at,
  'bookingPolicyVersion',r.booking_policy_version,'conditionsAcceptedAt',r.conditions_accepted_at,'nonCancellableAccepted',r.non_cancellable_accepted,
  'usageRulesText',accepted.text_content,'pendingUsageRulesVersion',r.pending_usage_rules_version,'pendingUsageRulesText',pending.text_content) ORDER BY r.id),'[]'::jsonb)
 INTO items FROM (SELECT * FROM domain.reservation r WHERE r.tenant_id=tenant AND (unit IS NULL OR r.unit_id=unit)
  AND r.starts_at<last_instant AND r.ends_at>first_instant ORDER BY r.id LIMIT 10001) r
 LEFT JOIN domain.unit_usage_rules accepted ON (accepted.tenant_id,accepted.unit_id,accepted.version)=(r.tenant_id,r.usage_rules_unit_id,r.usage_rules_version)
 LEFT JOIN domain.unit_usage_rules pending ON (pending.tenant_id,pending.unit_id,pending.version)=(r.tenant_id,r.unit_id,r.pending_usage_rules_version);
 IF jsonb_array_length(items)>10000 THEN RAISE EXCEPTION 'Export period too large' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('format','quenda.reservations','version',3,'tenantId',tenant,'unitId',unit,'generatedAt',observed,
  'period',jsonb_build_object('from',from_date,'to',to_date,'timeZone',zone,'selection','overlap'),
  'entities',jsonb_build_array('reservations'),'reservations',items);
END $$;
REVOKE ALL ON FUNCTION domain.reservation_export(date,date,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.reservation_export(date,date,uuid) TO quenda_domain;

DROP FUNCTION domain.own_reservation_notices(uuid,uuid);
CREATE FUNCTION domain.own_reservation_notices(after_event uuid,after_tenant uuid)
RETURNS TABLE(event_id uuid,tenant_id uuid,reservation_id uuid,revision integer,kind text,occurred_at timestamptz,
 unit_id uuid,starts_at timestamptz,ends_at timestamptz,timezone text,pending_usage_rules_version integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT n.event_id,n.tenant_id,e.reservation_id,e.revision,e.kind,e.occurred_at,
  (e.after_state->>'unitId')::uuid,(e.after_state->>'startsAt')::timestamptz,
  (e.after_state->>'endsAt')::timestamptz,e.after_state->>'timezone',(e.after_state->>'pendingUsageRulesVersion')::integer
 FROM domain.reservation_notice n
 JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(n.tenant_id,n.event_id)
 WHERE n.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND ($1 IS NULL OR (n.event_id,n.tenant_id)>($1,$2))
 ORDER BY n.event_id,n.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservation_notices(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservation_notices(uuid,uuid) TO quenda_domain;
