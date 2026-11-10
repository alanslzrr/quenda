-- Suspension requires taking part in a version that is in force or scheduled.
-- A municipality that only took part in a version already replaced or ended
-- no longer suspends the versions that followed it.
CREATE OR REPLACE FUNCTION domain.suspend_agreement(agreement uuid,revision integer,reason text,correlation uuid) RETURNS void
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
 stopped_at:=clock_timestamp();
 IF current_status<>'ACTIVADO' OR NOT EXISTS(SELECT 1 FROM domain.agreement_activation a
  JOIN domain.agreement_participant p ON (p.agreement_id,p.version)=(a.agreement_id,a.version)
  WHERE a.agreement_id=agreement AND p.tenant_id=tenant AND NOT isempty(a.effective_period) AND upper(a.effective_period)>stopped_at) THEN
  RAISE EXCEPTION 'Version not in force' USING ERRCODE='23514';
 END IF;
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
