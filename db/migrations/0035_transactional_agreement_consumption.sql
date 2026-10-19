CREATE TABLE domain.agreement_consumption_event (
 id uuid PRIMARY KEY,
 agreement_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 version integer NOT NULL,
 action text NOT NULL CHECK(action IN ('ATTRIBUTED','RELEASED')),
 week_start date NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 credential_id uuid REFERENCES domain.agreement_credential(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(agreement_id,subject_id) REFERENCES domain.agreement_subject(agreement_id,id),
 FOREIGN KEY(agreement_id,version) REFERENCES domain.agreement_version(agreement_id,version),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES domain.reservation(tenant_id,id)
);
CREATE INDEX agreement_consumption_event_booking ON domain.agreement_consumption_event(tenant_id,reservation_id,occurred_at);
ALTER TABLE domain.agreement_consumption_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_consumption_event FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_consumption_event_maintenance ON domain.agreement_consumption_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.agreement_consumption_event FROM PUBLIC,quenda_domain,quenda_auth;

CREATE FUNCTION domain.sync_reservation_consumption(reservation uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 booking domain.reservation%ROWTYPE;
 target domain.agreement_assignment%ROWTYPE;
 rule domain.agreement_version%ROWTYPE;
 old domain.agreement_consumption%ROWTYPE;
 subject uuid; credential uuid; week date; zone text; locked_agreement uuid;
BEGIN
 SELECT r.* INTO booking FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF booking.account_id IS DISTINCT FROM actor AND NOT domain.lock_permission('RESERVATION_MANAGE',booking.unit_id) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
 END IF;
 IF booking.status='CONFIRMADA' AND EXISTS(SELECT 1 FROM domain.unit_agreement_gate g WHERE g.tenant_id=tenant AND g.unit_id=booking.unit_id) THEN
  SELECT a.* INTO target FROM domain.agreement_assignment a
   WHERE a.tenant_id=tenant AND a.unit_id=booking.unit_id AND a.effective_period @> clock_timestamp()
   AND a.effective_period @> tstzrange(booking.starts_at,booking.ends_at,'[)');
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 -- A move locks origin and destination agreements in a common order.
 FOR locked_agreement IN
  SELECT a.id FROM domain.agreement a WHERE a.id=target.agreement_id OR EXISTS(
   SELECT 1 FROM domain.agreement_consumption c WHERE c.agreement_id=a.id AND c.tenant_id=tenant AND c.reservation_id=reservation AND NOT c.released)
  ORDER BY a.id FOR SHARE
 LOOP NULL; END LOOP;
 IF booking.status='CONFIRMADA' AND EXISTS(
  SELECT 1 FROM domain.agreement_consumption c WHERE c.tenant_id=tenant AND c.reservation_id=reservation AND NOT c.released
  AND NOT EXISTS(SELECT 1 FROM domain.agreement_activation a JOIN domain.agreement_version v
   ON (v.agreement_id,v.version)=(a.agreement_id,a.version)
   WHERE a.agreement_id=c.agreement_id AND v.status='ACTIVADO' AND a.effective_period @> clock_timestamp())
 ) THEN RAISE EXCEPTION 'Origin agreement unavailable' USING ERRCODE='23514'; END IF;
 IF target.agreement_id IS NOT NULL THEN
  SELECT v.* INTO rule FROM domain.agreement_version v
   WHERE v.agreement_id=target.agreement_id AND v.version=target.version FOR SHARE;
  IF rule.status<>'ACTIVADO' OR NOT (target.effective_period @> clock_timestamp()) THEN
   RAISE EXCEPTION 'Agreement unavailable' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM domain.agreement_activation a WHERE a.agreement_id=target.agreement_id AND a.version=target.version FOR SHARE;
  INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES(target.agreement_id,gen_random_uuid(),booking.account_id)
   ON CONFLICT(agreement_id,account_id) DO NOTHING;
  SELECT s.id INTO subject FROM domain.agreement_subject s WHERE s.agreement_id=target.agreement_id AND s.account_id=booking.account_id FOR UPDATE;
  IF rule.eligibility='acreditacion_vigente' THEN
   SELECT c.id INTO credential FROM domain.agreement_credential c
    JOIN domain.agreement_participant p ON p.agreement_id=c.agreement_id AND p.version=target.version AND p.tenant_id=c.issuer_tenant_id
    WHERE c.agreement_id=target.agreement_id AND c.subject_id=subject AND c.revoked_at IS NULL
    AND p.accreditation_issuer AND c.starts_at<=booking.starts_at AND c.ends_at>=booking.ends_at
    ORDER BY c.id LIMIT 1 FOR SHARE OF c;
   IF NOT FOUND THEN RAISE EXCEPTION 'Eligibility rejected' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT a.timezone INTO zone FROM domain.agreement a WHERE a.id=target.agreement_id;
  week:=date_trunc('week',booking.starts_at AT TIME ZONE zone)::date;
 END IF;
 FOR old IN SELECT c.* FROM domain.agreement_consumption c WHERE c.tenant_id=tenant AND c.reservation_id=reservation AND NOT c.released ORDER BY c.agreement_id FOR UPDATE LOOP
  UPDATE domain.agreement_consumption SET released=true WHERE agreement_id=old.agreement_id AND tenant_id=tenant AND reservation_id=reservation;
  INSERT INTO domain.agreement_consumption_event(id,agreement_id,subject_id,tenant_id,reservation_id,version,action,week_start,starts_at,ends_at,actor_id,correlation_id)
   VALUES(gen_random_uuid(),old.agreement_id,old.subject_id,tenant,reservation,old.attribution_version,'RELEASED',old.week_start,old.starts_at,old.ends_at,actor,correlation);
 END LOOP;
 IF target.agreement_id IS NULL THEN RETURN; END IF;
 IF rule.weekly_limit IS NOT NULL AND (SELECT count(*) FROM domain.agreement_consumption c
   WHERE c.agreement_id=target.agreement_id AND c.subject_id=subject AND c.week_start=week AND NOT c.released)>=rule.weekly_limit THEN
  RAISE EXCEPTION 'Quota rejected' USING ERRCODE='23514';
 END IF;
 INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start,released)
 VALUES(target.agreement_id,tenant,reservation,subject,target.version,booking.unit_id,booking.starts_at,booking.ends_at,week,false)
 ON CONFLICT(agreement_id,tenant_id,reservation_id) DO UPDATE SET
  subject_id=EXCLUDED.subject_id,attribution_version=EXCLUDED.attribution_version,unit_id=EXCLUDED.unit_id,
  starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,week_start=EXCLUDED.week_start,released=false;
 INSERT INTO domain.agreement_consumption_event(id,agreement_id,subject_id,tenant_id,reservation_id,version,action,week_start,starts_at,ends_at,credential_id,actor_id,correlation_id)
 VALUES(gen_random_uuid(),target.agreement_id,subject,tenant,reservation,target.version,'ATTRIBUTED',week,booking.starts_at,booking.ends_at,credential,actor,correlation);
END $$;
REVOKE ALL ON FUNCTION domain.sync_reservation_consumption(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.sync_reservation_consumption(uuid,uuid) TO quenda_domain;
