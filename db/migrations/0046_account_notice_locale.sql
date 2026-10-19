CREATE TABLE domain.account_preferences (
 account_id text PRIMARY KEY REFERENCES auth."user"(id),
 locale text CHECK(locale IN ('es','gl'))
);
ALTER TABLE domain.account_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.account_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY account_preferences_maintenance ON domain.account_preferences TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY account_preferences_self ON domain.account_preferences TO quenda_domain
 USING(account_id=nullif(current_setting('quenda.account_id',true),''))
 WITH CHECK(account_id=nullif(current_setting('quenda.account_id',true),''));
GRANT SELECT,INSERT ON domain.account_preferences TO quenda_domain;
GRANT UPDATE(locale) ON domain.account_preferences TO quenda_domain;
ALTER TABLE domain.reservation_email ADD COLUMN locale text CHECK(locale IN ('es','gl'));
CREATE FUNCTION domain.capture_reservation_email_locale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 SELECT p.locale INTO NEW.locale FROM domain.reservation_notice n
 JOIN domain.account_preferences p ON p.account_id=n.account_id
 WHERE n.tenant_id=NEW.tenant_id AND n.event_id=NEW.event_id;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION domain.capture_reservation_email_locale() FROM PUBLIC;
CREATE TRIGGER reservation_email_locale BEFORE INSERT ON domain.reservation_email FOR EACH ROW EXECUTE FUNCTION domain.capture_reservation_email_locale();

DROP FUNCTION domain.claim_reservation_email(integer,integer);
CREATE FUNCTION domain.claim_reservation_email(lease_seconds integer,max_attempts integer)
RETURNS TABLE(tenant_id uuid,event_id uuid,token uuid,attempt integer,recipient text,reservation_id uuid,revision integer,kind text,occurred_at timestamptz,after_state jsonb,locale text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job domain.reservation_email%ROWTYPE; now_at timestamptz:=clock_timestamp(); next_token uuid;
BEGIN
 IF lease_seconds NOT BETWEEN 5 AND 3600 OR max_attempts NOT BETWEEN 1 AND 10 OR lease_seconds IS NULL OR max_attempts IS NULL THEN
  RAISE EXCEPTION 'Invalid worker limits' USING ERRCODE='23514';
 END IF;
 -- Reap abandoned leases before claiming; no external send occurs in this transaction.
 FOR job IN SELECT q.* FROM domain.reservation_email q WHERE (q.lease_until<=now_at OR (q.lease_token IS NULL AND q.attempts>=max_attempts))
  AND q.accepted_at IS NULL AND q.exhausted_at IS NULL ORDER BY q.lease_until LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  UPDATE domain.reservation_email_attempt a SET outcome='EXPIRED',finished_at=now_at WHERE a.token=job.lease_token AND a.outcome IS NULL;
  UPDATE domain.reservation_email q SET lease_token=NULL,lease_until=NULL,
   exhausted_at=CASE WHEN q.attempts>=max_attempts THEN now_at ELSE NULL END
   WHERE (q.tenant_id,q.event_id)=(job.tenant_id,job.event_id);
 END LOOP;
 SELECT q.* INTO job FROM domain.reservation_email q
 JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(q.tenant_id,q.event_id)
 WHERE q.accepted_at IS NULL AND q.exhausted_at IS NULL AND q.lease_token IS NULL AND q.next_attempt_at<=now_at
 AND q.attempts<max_attempts AND NOT EXISTS(
  SELECT 1 FROM domain.reservation_email p JOIN domain.reservation_event pe ON (pe.tenant_id,pe.id)=(p.tenant_id,p.event_id)
  WHERE pe.tenant_id=e.tenant_id AND pe.reservation_id=e.reservation_id AND pe.revision<e.revision
  AND p.accepted_at IS NULL AND p.exhausted_at IS NULL)
 ORDER BY q.created_at,q.tenant_id,q.event_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 next_token:=gen_random_uuid();
 UPDATE domain.reservation_email q SET attempts=q.attempts+1,lease_token=next_token,lease_until=now_at+lease_seconds*interval '1 second'
 WHERE (q.tenant_id,q.event_id)=(job.tenant_id,job.event_id);
 INSERT INTO domain.reservation_email_attempt(tenant_id,event_id,attempt,token,started_at)
 VALUES(job.tenant_id,job.event_id,job.attempts+1,next_token,now_at);
 RETURN QUERY SELECT q.tenant_id,q.event_id,next_token,q.attempts,u.email,e.reservation_id,e.revision,e.kind,e.occurred_at,e.after_state,q.locale
 FROM domain.reservation_email q JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(q.tenant_id,q.event_id)
 JOIN domain.reservation_notice n ON (n.tenant_id,n.event_id)=(q.tenant_id,q.event_id)
 JOIN auth."user" u ON u.id=n.account_id
 WHERE (q.tenant_id,q.event_id)=(job.tenant_id,job.event_id);
END $$;

REVOKE ALL ON FUNCTION domain.claim_reservation_email(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.claim_reservation_email(integer,integer) TO quenda_worker;
