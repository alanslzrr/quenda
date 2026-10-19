CREATE TABLE domain.reservation_event (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 kind text NOT NULL CHECK(kind IN ('CONFIRMADA','MODIFICADA','CANCELADA')),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 correlation_id uuid NOT NULL,
 reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
 before_state jsonb,
 after_state jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,reservation_id,revision),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES domain.reservation(tenant_id,id)
);
CREATE TABLE domain.reservation_notice (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 account_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES domain.reservation_event(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES domain.municipal_profile(tenant_id,account_id)
);
CREATE INDEX reservation_notice_owner ON domain.reservation_notice(account_id,created_at,event_id);
CREATE TABLE domain.reservation_email (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES domain.reservation_event(tenant_id,id)
);
ALTER TABLE domain.reservation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_event FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_notice FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_email FORCE ROW LEVEL SECURITY;
CREATE POLICY event_maintenance ON domain.reservation_event TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY notice_maintenance ON domain.reservation_notice TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY email_maintenance ON domain.reservation_email TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY event_read ON domain.reservation_event FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM domain.reservation r WHERE (r.tenant_id,r.id)=(reservation_event.tenant_id,reservation_event.reservation_id)));
CREATE POLICY notice_read ON domain.reservation_notice FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND account_id=nullif(current_setting('quenda.account_id',true),''));
GRANT SELECT ON domain.reservation_event,domain.reservation_notice TO quenda_domain;

CREATE FUNCTION domain.append_reservation_event(reservation uuid,event uuid,correlation uuid,motive text) RETURNS void
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
 IF current_reservation.account_id<>actor AND (motive IS NULL OR length(btrim(motive))=0) THEN
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
 snapshot:=jsonb_build_object('unitId',current_reservation.unit_id,'calendarVersion',current_reservation.calendar_version,
  'startsAt',current_reservation.starts_at,'endsAt',current_reservation.ends_at,'status',current_reservation.status,
  'revision',current_reservation.revision,'cancellationMinutes',current_reservation.cancellation_minutes,'timezone',current_reservation.timezone);
 INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,reason,before_state,after_state)
 VALUES(tenant,event,reservation,current_reservation.revision,event_kind,actor,correlation,motive,previous.after_state,snapshot);
 INSERT INTO domain.reservation_notice(tenant_id,event_id,account_id) VALUES(tenant,event,current_reservation.account_id);
 INSERT INTO domain.reservation_email(tenant_id,event_id) VALUES(tenant,event);
END $$;
REVOKE ALL ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.append_reservation_event(uuid,uuid,uuid,text) TO quenda_domain;

CREATE FUNCTION domain.check_reservation_event_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE tenant uuid:=NEW.tenant_id; reservation uuid;
 current_reservation domain.reservation%ROWTYPE; latest domain.reservation_event%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='reservation' THEN reservation:=NEW.id; ELSE reservation:=NEW.reservation_id; END IF;
 SELECT * INTO latest FROM domain.reservation_event e WHERE e.tenant_id=tenant AND e.reservation_id=reservation ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO current_reservation FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation;
 IF latest.revision<>current_reservation.revision OR latest.after_state IS DISTINCT FROM
  jsonb_build_object('unitId',current_reservation.unit_id,'calendarVersion',current_reservation.calendar_version,
   'startsAt',current_reservation.starts_at,'endsAt',current_reservation.ends_at,'status',current_reservation.status,
   'revision',current_reservation.revision,'cancellationMinutes',current_reservation.cancellation_minutes,'timezone',current_reservation.timezone) THEN
  RAISE EXCEPTION 'Inconsistent event snapshot' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.check_reservation_event_snapshot() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER reservation_event_snapshot AFTER INSERT ON domain.reservation_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_reservation_event_snapshot();
CREATE CONSTRAINT TRIGGER reservation_event_current AFTER UPDATE ON domain.reservation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_reservation_event_snapshot();
