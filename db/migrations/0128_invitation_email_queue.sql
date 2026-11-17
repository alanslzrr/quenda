-- Notification mail for invitations addressed to an email (administrator,
-- manager, initial administrator, recovery substitute, operator and global
-- privacy). The message is the same whether or not an account uses the
-- address, names no inviter and carries no token: acceptance stays in the
-- application with the verified email and MFA.
--
-- * A trigger queues one message when an address-only invitation is created.
--   Invitations addressed to an account (older rows and manager scope
--   replacements) are not mailed.
-- * Revocation, acceptance, a cleared or changed address and deletion of the
--   invitation remove its queued message in the same transaction. The worker
--   also drops a message whose invitation is no longer acceptable (expired,
--   invalidated issuer) instead of sending it.
-- * A row keeps the address only while delivery is still possible: delivery
--   deletes the row and exhaustion clears the address. An exhausted row only
--   feeds the health counters and disappears once its invitation ends.
-- * Claims use the same lease, attempt and retry limits as reservation mail,
--   through SECURITY DEFINER functions granted only to the worker role. The
--   web role never reads the queue.
-- * At most 100 messages are queued per municipality, and 100 for platform
--   invitations, in a fixed 24-hour window. Beyond that the invitation is
--   still created and can be accepted in the application, but no message is
--   queued. The count does not depend on whether accounts exist.

CREATE TABLE domain.invitation_email (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('ADMINISTRATOR','MANAGER','OPERATOR','PRIVACY')),
 tenant_id uuid REFERENCES domain.municipality(id),
 invitation_id uuid NOT NULL,
 recipient_email text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease_token uuid UNIQUE,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 exhausted_at timestamptz,
 UNIQUE(kind,invitation_id),
 CHECK((tenant_id IS NULL)=(kind IN ('OPERATOR','PRIVACY'))),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((recipient_email IS NULL)=(exhausted_at IS NOT NULL)),
 CHECK(exhausted_at IS NULL OR lease_token IS NULL),
 CHECK(recipient_email IS NULL OR (recipient_email=lower(btrim(recipient_email))
  AND length(recipient_email) BETWEEN 3 AND 320 AND recipient_email ~ '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+$'))
);
CREATE INDEX invitation_email_pending ON domain.invitation_email(next_attempt_at,created_at) WHERE exhausted_at IS NULL;
CREATE TABLE domain.invitation_email_quota (
 scope text PRIMARY KEY,
 window_started_at timestamptz NOT NULL,
 queued integer NOT NULL CHECK(queued BETWEEN 0 AND 101)
);
ALTER TABLE domain.invitation_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.invitation_email FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.invitation_email_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.invitation_email_quota FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_email_maintenance ON domain.invitation_email TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_email_quota_maintenance ON domain.invitation_email_quota TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.invitation_email,domain.invitation_email_quota FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.queue_invitation_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE category text:=TG_ARGV[0];
DECLARE tenant uuid;
DECLARE instant timestamptz:=clock_timestamp();
DECLARE queued integer;
BEGIN
 IF NEW.account_id IS NOT NULL OR NEW.recipient_email IS NULL OR NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
 IF category IN ('ADMINISTRATOR','MANAGER') THEN tenant:=(to_jsonb(NEW)->>'tenant_id')::uuid; END IF;
 INSERT INTO domain.invitation_email_quota AS q(scope,window_started_at,queued) VALUES(coalesce(tenant::text,'platform'),instant,1)
 ON CONFLICT(scope) DO UPDATE SET
  window_started_at=CASE WHEN q.window_started_at+interval '24 hours'<=instant THEN instant ELSE q.window_started_at END,
  queued=CASE WHEN q.window_started_at+interval '24 hours'<=instant THEN 1 ELSE least(q.queued+1,101) END
 RETURNING q.queued INTO queued;
 IF queued>100 THEN RETURN NULL; END IF;
 INSERT INTO domain.invitation_email(kind,tenant_id,invitation_id,recipient_email) VALUES(category,tenant,NEW.id,NEW.recipient_email);
 RETURN NULL;
END $$;

CREATE FUNCTION domain.cancel_invitation_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM domain.invitation_email WHERE kind=TG_ARGV[0] AND invitation_id=OLD.id;
 ELSIF NEW.revoked_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.account_id IS NOT NULL
  OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email THEN
  DELETE FROM domain.invitation_email WHERE kind=TG_ARGV[0] AND invitation_id=NEW.id;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.queue_invitation_email(),domain.cancel_invitation_email() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE TRIGGER administrator_invitation_email AFTER INSERT ON domain.administrator_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.queue_invitation_email('ADMINISTRATOR');
CREATE TRIGGER manager_invitation_email AFTER INSERT ON domain.manager_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.queue_invitation_email('MANAGER');
CREATE TRIGGER operator_invitation_email AFTER INSERT ON domain.platform_operator_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.queue_invitation_email('OPERATOR');
CREATE TRIGGER privacy_invitation_email AFTER INSERT ON domain.global_privacy_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.queue_invitation_email('PRIVACY');
CREATE TRIGGER administrator_invitation_email_end AFTER UPDATE OR DELETE ON domain.administrator_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.cancel_invitation_email('ADMINISTRATOR');
CREATE TRIGGER manager_invitation_email_end AFTER UPDATE OR DELETE ON domain.manager_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.cancel_invitation_email('MANAGER');
CREATE TRIGGER operator_invitation_email_end AFTER UPDATE OR DELETE ON domain.platform_operator_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.cancel_invitation_email('OPERATOR');
CREATE TRIGGER privacy_invitation_email_end AFTER UPDATE OR DELETE ON domain.global_privacy_invitation
 FOR EACH ROW EXECUTE FUNCTION domain.cancel_invitation_email('PRIVACY');

-- The acceptance deadline of an invitation that the addressed account could
-- still accept now, or NULL. It mirrors the acceptance checks: pending, not
-- expired, addressed to that email and issued by an authority still in force.
CREATE FUNCTION domain.invitation_email_deadline(category text,tenant uuid,invitation uuid,address text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE administrator_item domain.administrator_invitation; manager_item domain.manager_invitation;
 operator_item domain.platform_operator_invitation; privacy_item domain.global_privacy_invitation;
 instant timestamptz:=clock_timestamp();
BEGIN
 IF address IS NULL THEN RETURN NULL; END IF;
 IF category='ADMINISTRATOR' THEN
  SELECT * INTO administrator_item FROM domain.administrator_invitation WHERE tenant_id=tenant AND id=invitation
   AND account_id IS NULL AND recipient_email=address AND accepted_at IS NULL AND revoked_at IS NULL
   AND expires_at>instant AND (role_expires_at IS NULL OR role_expires_at>instant);
  IF NOT FOUND OR NOT domain.responsible_account_enabled(administrator_item.invited_by) THEN RETURN NULL; END IF;
  IF administrator_item.grant_source='MUNICIPAL' THEN
   IF NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant AND a.account_id=administrator_item.invited_by
    AND a.invitation_id=administrator_item.issuer_invitation_id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>instant)) THEN RETURN NULL; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM domain.platform_operator p WHERE p.account_id=administrator_item.invited_by AND p.revoked_at IS NULL) THEN RETURN NULL; END IF;
   IF administrator_item.grant_source='PLATFORM' AND EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant) THEN RETURN NULL; END IF;
   IF administrator_item.grant_source='RECOVERY' AND EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant
    AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>instant) AND domain.responsible_account_enabled(a.account_id)) THEN RETURN NULL; END IF;
  END IF;
  RETURN administrator_item.expires_at;
 ELSIF category='MANAGER' THEN
  SELECT * INTO manager_item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation
   AND account_id IS NULL AND recipient_email=address AND accepted_at IS NULL AND revoked_at IS NULL
   AND expires_at>instant AND (role_expires_at IS NULL OR role_expires_at>instant);
  IF NOT FOUND OR NOT domain.responsible_account_enabled(manager_item.invited_by) OR NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a
   WHERE a.tenant_id=tenant AND a.account_id=manager_item.invited_by AND a.invitation_id=manager_item.issuer_invitation_id
    AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>instant)) THEN RETURN NULL; END IF;
  RETURN manager_item.expires_at;
 ELSIF category='OPERATOR' THEN
  SELECT * INTO operator_item FROM domain.platform_operator_invitation WHERE id=invitation
   AND account_id IS NULL AND recipient_email=address AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>instant;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM domain.platform_operator p WHERE p.account_id=operator_item.invited_by AND p.revoked_at IS NULL
   AND p.created_at=operator_item.issuer_granted_at AND domain.responsible_account_enabled(p.account_id)) THEN RETURN NULL; END IF;
  RETURN operator_item.expires_at;
 ELSIF category='PRIVACY' THEN
  SELECT * INTO privacy_item FROM domain.global_privacy_invitation WHERE id=invitation
   AND account_id IS NULL AND recipient_email=address AND accepted_at IS NULL AND revoked_at IS NULL
   AND expires_at>instant AND (role_expires_at IS NULL OR role_expires_at>instant);
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM domain.platform_operator p WHERE p.account_id=privacy_item.invited_by AND p.revoked_at IS NULL
   AND p.created_at=privacy_item.issuer_granted_at AND domain.responsible_account_enabled(p.account_id)) THEN RETURN NULL; END IF;
  RETURN privacy_item.expires_at;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.invitation_email_deadline(text,uuid,uuid,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

-- Autocommit claim, like reservation mail: no external I/O happens inside it.
-- A message whose invitation can no longer be accepted is removed instead of
-- being leased, so an expired, revoked or replaced invitation is never sent.
CREATE FUNCTION domain.claim_invitation_email(lease_seconds integer,max_attempts integer)
RETURNS TABLE(token uuid,attempt integer,kind text,recipient text,municipality text,timezone text,expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job domain.invitation_email%ROWTYPE; now_at timestamptz:=clock_timestamp(); next_token uuid; deadline timestamptz;
BEGIN
 IF lease_seconds IS NULL OR max_attempts IS NULL OR lease_seconds NOT BETWEEN 5 AND 3600 OR max_attempts NOT BETWEEN 1 AND 10 THEN
  RAISE EXCEPTION 'Invalid worker limits' USING ERRCODE='23514';
 END IF;
 -- Reap abandoned leases; an exhausted message keeps no address.
 FOR job IN SELECT q.* FROM domain.invitation_email q WHERE q.exhausted_at IS NULL
  AND (q.lease_until<=now_at OR (q.lease_token IS NULL AND q.attempts>=max_attempts))
  ORDER BY q.lease_until LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  UPDATE domain.invitation_email q SET lease_token=NULL,lease_until=NULL,
   exhausted_at=CASE WHEN q.attempts>=max_attempts THEN now_at END,
   recipient_email=CASE WHEN q.attempts>=max_attempts THEN NULL ELSE q.recipient_email END
  WHERE q.id=job.id;
 END LOOP;
 -- Exhausted messages only count for health until their invitation ends.
 DELETE FROM domain.invitation_email q WHERE q.id IN (SELECT e.id FROM domain.invitation_email e WHERE e.exhausted_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM domain.administrator_invitation i WHERE e.kind='ADMINISTRATOR' AND (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id)
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now_at)
  AND NOT EXISTS(SELECT 1 FROM domain.manager_invitation i WHERE e.kind='MANAGER' AND (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id)
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now_at)
  AND NOT EXISTS(SELECT 1 FROM domain.platform_operator_invitation i WHERE e.kind='OPERATOR' AND i.id=e.invitation_id
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now_at)
  AND NOT EXISTS(SELECT 1 FROM domain.global_privacy_invitation i WHERE e.kind='PRIVACY' AND i.id=e.invitation_id
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now_at)
  ORDER BY e.exhausted_at LIMIT 100 FOR UPDATE SKIP LOCKED);
 FOR job IN SELECT q.* FROM domain.invitation_email q WHERE q.exhausted_at IS NULL AND q.lease_token IS NULL
  AND q.next_attempt_at<=now_at AND q.attempts<max_attempts ORDER BY q.created_at,q.id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  deadline:=domain.invitation_email_deadline(job.kind,job.tenant_id,job.invitation_id,job.recipient_email);
  IF deadline IS NULL THEN
   DELETE FROM domain.invitation_email q WHERE q.id=job.id;
   CONTINUE;
  END IF;
  next_token:=gen_random_uuid();
  UPDATE domain.invitation_email q SET attempts=q.attempts+1,lease_token=next_token,lease_until=now_at+lease_seconds*interval '1 second'
   WHERE q.id=job.id;
  RETURN QUERY SELECT next_token,job.attempts+1,job.kind,job.recipient_email,m.name,coalesce(m.timezone,'UTC'),deadline
   FROM (SELECT 1) one LEFT JOIN domain.municipality m ON m.id=job.tenant_id;
  RETURN;
 END LOOP;
END $$;

CREATE FUNCTION domain.finish_invitation_email(claim uuid,accepted boolean,max_attempts integer,retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job domain.invitation_email%ROWTYPE; now_at timestamptz:=clock_timestamp();
BEGIN
 IF accepted IS NULL OR max_attempts IS NULL OR max_attempts NOT BETWEEN 1 AND 10 OR retry_seconds IS NULL OR retry_seconds NOT BETWEEN 1 AND 86400 THEN
  RAISE EXCEPTION 'Invalid worker limits' USING ERRCODE='23514';
 END IF;
 SELECT q.* INTO job FROM domain.invitation_email q WHERE q.lease_token=claim AND q.lease_until>now_at AND q.exhausted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 -- A delivered message keeps nothing: the address leaves the queue with it.
 IF accepted THEN
  DELETE FROM domain.invitation_email q WHERE q.id=job.id;
  RETURN true;
 END IF;
 UPDATE domain.invitation_email q SET lease_token=NULL,lease_until=NULL,
  exhausted_at=CASE WHEN q.attempts>=max_attempts THEN now_at END,
  recipient_email=CASE WHEN q.attempts>=max_attempts THEN NULL ELSE q.recipient_email END,
  next_attempt_at=now_at+retry_seconds*interval '1 second'
 WHERE q.id=job.id;
 RETURN true;
END $$;

-- Operational counts only: the worker cannot list recipients or invitations.
CREATE FUNCTION domain.invitation_email_health()
RETURNS TABLE(pending bigint,leased bigint,exhausted bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT count(*) FILTER(WHERE exhausted_at IS NULL),
  count(*) FILTER(WHERE lease_token IS NOT NULL AND exhausted_at IS NULL),
  count(*) FILTER(WHERE exhausted_at IS NOT NULL)
 FROM domain.invitation_email
$$;
REVOKE ALL ON FUNCTION domain.claim_invitation_email(integer,integer),domain.finish_invitation_email(uuid,boolean,integer,integer),domain.invitation_email_health()
 FROM PUBLIC,quenda_domain,quenda_auth;
GRANT EXECUTE ON FUNCTION domain.claim_invitation_email(integer,integer),domain.finish_invitation_email(uuid,boolean,integer,integer),domain.invitation_email_health()
 TO quenda_worker;
