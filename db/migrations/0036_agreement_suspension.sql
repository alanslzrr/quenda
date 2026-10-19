CREATE TABLE domain.agreement_lifecycle_event (
 id uuid PRIMARY KEY,
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 action text NOT NULL CHECK(action IN ('ACTIVATED','SUSPENDED')),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 actor_tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 reason text CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(agreement_id,version) REFERENCES domain.agreement_version(agreement_id,version),
 CHECK(action<>'SUSPENDED' OR reason IS NOT NULL)
);
CREATE INDEX agreement_lifecycle_event_version ON domain.agreement_lifecycle_event(agreement_id,version,occurred_at);
ALTER TABLE domain.agreement_lifecycle_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_lifecycle_event FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_lifecycle_event_maintenance ON domain.agreement_lifecycle_event TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_lifecycle_event_read ON domain.agreement_lifecycle_event FOR SELECT TO quenda_domain USING(domain.agreement_version_visible(agreement_id,version));
GRANT SELECT ON domain.agreement_lifecycle_event TO quenda_domain;

CREATE FUNCTION domain.suspend_agreement(agreement uuid,revision integer,reason text,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 current_status text; affected integer; stopped_at timestamptz;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision AND p.tenant_id=tenant) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR UPDATE;
 SELECT v.status INTO current_status FROM domain.agreement_version v WHERE v.agreement_id=agreement AND v.version=revision FOR UPDATE;
 IF current_status='SUSPENDIDO' THEN RETURN; END IF;
 IF current_status<>'ACTIVADO' THEN RAISE EXCEPTION 'Version not activated' USING ERRCODE='23514'; END IF;
 stopped_at:=clock_timestamp();
 FOR affected IN SELECT v.version FROM domain.agreement_version v WHERE v.agreement_id=agreement AND v.status='ACTIVADO' ORDER BY v.version FOR UPDATE LOOP
  UPDATE domain.agreement_activation a SET effective_period=CASE
   WHEN lower(a.effective_period)>=stopped_at THEN 'empty'::tstzrange
   ELSE tstzrange(lower(a.effective_period),stopped_at,'[)') END
   WHERE a.agreement_id=agreement AND a.version=affected AND NOT isempty(a.effective_period) AND upper(a.effective_period)>stopped_at;
  UPDATE domain.agreement_version SET status='SUSPENDIDO' WHERE agreement_id=agreement AND version=affected;
  INSERT INTO domain.agreement_lifecycle_event(id,agreement_id,version,action,actor_id,actor_tenant_id,reason,correlation_id)
   VALUES(gen_random_uuid(),agreement,affected,'SUSPENDED',actor,tenant,btrim(reason),correlation);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION domain.suspend_agreement(uuid,integer,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.suspend_agreement(uuid,integer,text,uuid) TO quenda_domain;
