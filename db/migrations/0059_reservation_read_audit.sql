CREATE TABLE domain.reservation_read_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(operation IN ('DETAIL','MUNICIPAL_LIST')),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES domain.reservation(tenant_id,id)
);
CREATE INDEX reservation_read_event_scope ON domain.reservation_read_event(tenant_id,reservation_id,occurred_at);
ALTER TABLE domain.reservation_read_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_read_event FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_read_event_maintenance ON domain.reservation_read_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.reservation_read_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.record_reservation_reads(reservations uuid[],operation text,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); item uuid; resource uuid;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR operation IS NULL OR operation NOT IN ('DETAIL','MUNICIPAL_LIST')
 OR correlation IS NULL OR coalesce(cardinality(reservations),0) NOT BETWEEN 1 AND 20
 OR EXISTS(SELECT 1 FROM unnest(reservations) r WHERE r IS NULL)
 OR (SELECT count(DISTINCT r) FROM unnest(reservations) r)<>cardinality(reservations)
 THEN RAISE EXCEPTION 'Invalid audit context' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT r FROM unnest(reservations) r ORDER BY r LOOP
  SELECT unit_id INTO resource FROM domain.reservation WHERE tenant_id=tenant AND id=item;
  IF NOT FOUND OR NOT (domain.lock_permission('RESERVATION_READ',resource) OR domain.lock_permission('RESERVATION_MANAGE',resource))
  THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  INSERT INTO domain.reservation_read_event(tenant_id,reservation_id,actor_id,operation,correlation_id)
  VALUES(tenant,item,actor,operation,correlation);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION domain.record_reservation_reads(uuid[],text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.record_reservation_reads(uuid[],text,uuid) TO quenda_domain;
