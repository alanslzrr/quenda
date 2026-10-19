ALTER TABLE domain.reservation_email
 ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 ADD COLUMN lease_token uuid,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN accepted_at timestamptz,
 ADD COLUMN exhausted_at timestamptz,
 ADD CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 ADD CHECK(accepted_at IS NULL OR exhausted_at IS NULL);
CREATE INDEX reservation_email_pending ON domain.reservation_email(next_attempt_at,created_at)
 WHERE accepted_at IS NULL AND exhausted_at IS NULL;
CREATE TABLE domain.reservation_email_attempt (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>0),
 token uuid NOT NULL UNIQUE,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 outcome text CHECK(outcome IN ('ACCEPTED','FAILED','EXPIRED')),
 PRIMARY KEY(tenant_id,event_id,attempt),
 FOREIGN KEY(tenant_id,event_id) REFERENCES domain.reservation_email(tenant_id,event_id),
 CHECK((finished_at IS NULL)=(outcome IS NULL))
);
ALTER TABLE domain.reservation_email_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation_email_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY email_attempt_maintenance ON domain.reservation_email_attempt TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.reservation_email_attempt FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.claim_reservation_email(lease_seconds integer,max_attempts integer)
RETURNS TABLE(tenant_id uuid,event_id uuid,token uuid,attempt integer,recipient text,reservation_id uuid,revision integer,kind text,occurred_at timestamptz,after_state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job domain.reservation_email%ROWTYPE; now_at timestamptz:=clock_timestamp(); next_token uuid;
BEGIN
 IF lease_seconds NOT BETWEEN 5 AND 3600 OR max_attempts NOT BETWEEN 1 AND 10 OR lease_seconds IS NULL OR max_attempts IS NULL THEN
  RAISE EXCEPTION 'Invalid worker limits' USING ERRCODE='23514';
 END IF;
 -- Reap abandoned leases before claiming; no external send occurs in this transaction.
 FOR job IN SELECT q.* FROM domain.reservation_email q WHERE q.lease_until<=now_at
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
 RETURN QUERY SELECT q.tenant_id,q.event_id,next_token,q.attempts,u.email,e.reservation_id,e.revision,e.kind,e.occurred_at,e.after_state
 FROM domain.reservation_email q JOIN domain.reservation_event e ON (e.tenant_id,e.id)=(q.tenant_id,q.event_id)
 JOIN domain.reservation_notice n ON (n.tenant_id,n.event_id)=(q.tenant_id,q.event_id)
 JOIN auth."user" u ON u.id=n.account_id
 WHERE (q.tenant_id,q.event_id)=(job.tenant_id,job.event_id);
END $$;
CREATE FUNCTION domain.finish_reservation_email(claim uuid,accepted boolean,max_attempts integer,retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job domain.reservation_email%ROWTYPE; now_at timestamptz:=clock_timestamp();
BEGIN
 IF accepted IS NULL OR max_attempts IS NULL OR max_attempts NOT BETWEEN 1 AND 10 OR retry_seconds IS NULL OR retry_seconds NOT BETWEEN 1 AND 86400 THEN
  RAISE EXCEPTION 'Invalid worker limits' USING ERRCODE='23514';
 END IF;
 SELECT q.* INTO job FROM domain.reservation_email q WHERE q.lease_token=claim AND q.lease_until>now_at
 AND q.accepted_at IS NULL AND q.exhausted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE domain.reservation_email_attempt a SET finished_at=now_at,outcome=CASE WHEN accepted THEN 'ACCEPTED' ELSE 'FAILED' END WHERE a.token=claim;
 UPDATE domain.reservation_email q SET lease_token=NULL,lease_until=NULL,
  accepted_at=CASE WHEN accepted THEN now_at ELSE NULL END,
  exhausted_at=CASE WHEN NOT accepted AND q.attempts>=max_attempts THEN now_at ELSE NULL END,
  next_attempt_at=now_at+retry_seconds*interval '1 second'
 WHERE (q.tenant_id,q.event_id)=(job.tenant_id,job.event_id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.claim_reservation_email(integer,integer),domain.finish_reservation_email(uuid,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.claim_reservation_email(integer,integer),domain.finish_reservation_email(uuid,boolean,integer,integer) TO quenda_worker;
