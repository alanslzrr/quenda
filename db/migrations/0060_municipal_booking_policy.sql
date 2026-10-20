ALTER TABLE domain.municipality ADD COLUMN booking_policy_version integer NOT NULL DEFAULT 1 CHECK(booking_policy_version>0);
CREATE TABLE domain.municipal_booking_policy_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 version integer NOT NULL,
 previous_advance_days integer NOT NULL,
 advance_days integer NOT NULL,
 previous_cancellation_minutes integer NOT NULL,
 cancellation_minutes integer NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,version)
);
ALTER TABLE domain.municipal_booking_policy_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_booking_policy_event FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_policy_event_maintenance ON domain.municipal_booking_policy_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.municipal_booking_policy_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE FUNCTION domain.save_municipal_booking_policy(expected integer,advance integer,cancellation integer,reason text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous domain.municipality%ROWTYPE;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_current_administrator()
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected<1 OR advance IS NULL OR advance<0 OR cancellation IS NULL OR cancellation<0
 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500 OR correlation IS NULL
 THEN RAISE EXCEPTION 'Invalid policy' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR previous.booking_policy_version<>expected THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM domain.reservable_unit u JOIN domain.unit_calendar_version v
 ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.calendar_version)
 WHERE u.tenant_id=tenant AND v.advance_days>advance) THEN RETURN NULL; END IF;
 UPDATE domain.municipality SET advance_days=advance,cancellation_minutes=cancellation,booking_policy_version=expected+1 WHERE id=tenant;
 INSERT INTO domain.municipal_booking_policy_event(tenant_id,actor_id,version,previous_advance_days,advance_days,previous_cancellation_minutes,cancellation_minutes,reason,correlation_id)
 VALUES(tenant,actor,expected+1,previous.advance_days,advance,previous.cancellation_minutes,cancellation,btrim(reason),correlation);
 RETURN expected+1;
END $$;
REVOKE ALL ON FUNCTION domain.save_municipal_booking_policy(integer,integer,integer,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.save_municipal_booking_policy(integer,integer,integer,text,uuid) TO quenda_domain;
