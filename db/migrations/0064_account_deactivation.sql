-- One lock per global identity coordinates commands, session creation and
-- deactivation without rewriting the identity or its municipal history.
CREATE TABLE auth.account_lifecycle (
 account_id text PRIMARY KEY REFERENCES auth."user"(id),
 deactivated_at timestamptz,
 session_generation bigint NOT NULL DEFAULT 0 CHECK(session_generation>=0)
);
ALTER TABLE auth.account_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_lifecycle FORCE ROW LEVEL SECURITY;
CREATE POLICY account_lifecycle_maintenance ON auth.account_lifecycle TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY account_lifecycle_authentication ON auth.account_lifecycle FOR SELECT TO quenda_auth USING(true);
GRANT SELECT ON auth.account_lifecycle TO quenda_auth;
REVOKE ALL ON auth.account_lifecycle FROM PUBLIC,quenda_domain,quenda_worker;
INSERT INTO auth.account_lifecycle(account_id) SELECT id FROM auth."user";

CREATE FUNCTION auth.initialize_account_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO auth.account_lifecycle(account_id) VALUES(NEW.id);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION auth.initialize_account_lifecycle() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER account_lifecycle_initialize AFTER INSERT ON auth."user"
 FOR EACH ROW EXECUTE FUNCTION auth.initialize_account_lifecycle();

CREATE FUNCTION domain.lock_active_account() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS (
  SELECT 1 FROM auth.account_lifecycle
  WHERE account_id=nullif(current_setting('quenda.account_id',true),'')
    AND deactivated_at IS NULL FOR SHARE
 )
$$;
REVOKE ALL ON FUNCTION domain.lock_active_account() FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.lock_active_account() TO quenda_domain;

CREATE FUNCTION auth.guard_active_account_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text;
BEGIN
 IF TG_TABLE_NAME='user' THEN subject:=NEW.id; ELSE subject:=NEW."userId"; END IF;
 IF TG_TABLE_NAME='session' AND TG_OP='INSERT' THEN
  -- Auth inserts use READ COMMITTED. A row-version change makes a deactivation
  -- with an older SERIALIZABLE snapshot retry and include the new session.
  UPDATE auth.account_lifecycle SET session_generation=session_generation+1
   WHERE account_id=subject AND deactivated_at IS NULL;
 ELSE
  PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject AND deactivated_at IS NULL FOR SHARE;
 END IF;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Account inactive' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth.guard_active_account_write() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER session_active_account BEFORE INSERT OR UPDATE ON auth.session
 FOR EACH ROW EXECUTE FUNCTION auth.guard_active_account_write();
CREATE TRIGGER account_active_account BEFORE INSERT OR UPDATE ON auth.account
 FOR EACH ROW EXECUTE FUNCTION auth.guard_active_account_write();
CREATE TRIGGER user_active_account BEFORE UPDATE ON auth."user"
 FOR EACH ROW EXECUTE FUNCTION auth.guard_active_account_write();
CREATE TRIGGER two_factor_active_account BEFORE INSERT OR UPDATE ON auth."twoFactor"
 FOR EACH ROW EXECUTE FUNCTION auth.guard_active_account_write();

-- Administrative edits act with the administrator's context, but a future
-- confirmed booking must also serialize with the holder's deactivation.
CREATE FUNCTION domain.guard_reservation_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='CONFIRMADA' AND NEW.starts_at>now() THEN
  PERFORM 1 FROM auth.account_lifecycle WHERE account_id=NEW.account_id AND deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Reservation holder inactive' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION domain.guard_reservation_account() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER reservation_active_account BEFORE INSERT OR UPDATE ON domain.reservation
 FOR EACH ROW EXECUTE FUNCTION domain.guard_reservation_account();
CREATE INDEX reservation_account_future_confirmed ON domain.reservation(account_id,starts_at)
 WHERE status='CONFIRMADA';

CREATE TABLE auth.account_deactivation_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_id text NOT NULL REFERENCES auth."user"(id),
 occurred_at timestamptz NOT NULL,
 correlation_id uuid NOT NULL,
 revoked_sessions integer NOT NULL CHECK(revoked_sessions>=0),
 UNIQUE(subject_id)
);
ALTER TABLE auth.account_deactivation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_deactivation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY account_deactivation_event_maintenance ON auth.account_deactivation_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.account_deactivation_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION domain.deactivate_current_account(correlation uuid)
RETURNS TABLE(outcome text,deactivated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 subject text:=nullif(current_setting('quenda.account_id',true),'');
 previous timestamptz;
 instant timestamptz;
 removed integer;
BEGIN
 IF subject IS NULL OR correlation IS NULL
    OR current_setting('transaction_isolation')<>'serializable'
    OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable account context required' USING ERRCODE='42501';
 END IF;
 SELECT l.deactivated_at INTO previous FROM auth.account_lifecycle l WHERE l.account_id=subject FOR UPDATE;
 IF NOT FOUND OR previous IS NOT NULL THEN
  RETURN QUERY SELECT 'INACTIVE'::text,previous;
  RETURN;
 END IF;
 IF EXISTS (SELECT 1 FROM domain.reservation r
            WHERE r.account_id=subject AND r.status='CONFIRMADA' AND r.starts_at>now()) THEN
  RETURN QUERY SELECT 'FUTURE_RESERVATIONS'::text,NULL::timestamptz;
  RETURN;
 END IF;
 -- Do not orphan management while no transfer/recovery procedure is defined.
 -- SERIALIZABLE predicate reads also serialize competing deactivations of the
 -- last two responsible accounts; one retries and then sees the remaining role.
 IF (EXISTS (SELECT 1 FROM domain.platform_operator p WHERE p.account_id=subject AND p.revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM domain.platform_operator p
       JOIN auth.account_lifecycle l ON l.account_id=p.account_id
       WHERE p.account_id<>subject AND p.revoked_at IS NULL AND l.deactivated_at IS NULL))
    OR EXISTS (SELECT 1 FROM domain.municipal_administrator a
       WHERE a.account_id=subject AND a.revoked_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at>now())
       AND NOT EXISTS (SELECT 1 FROM domain.municipal_administrator other
         JOIN auth.account_lifecycle l ON l.account_id=other.account_id
         WHERE other.tenant_id=a.tenant_id AND other.account_id<>subject
         AND other.revoked_at IS NULL AND (other.expires_at IS NULL OR other.expires_at>now())
         AND l.deactivated_at IS NULL)) THEN
  RETURN QUERY SELECT 'HANDOVER_REQUIRED'::text,NULL::timestamptz;
  RETURN;
 END IF;
 instant:=clock_timestamp();
 UPDATE auth.account_lifecycle SET deactivated_at=instant WHERE account_id=subject;
 DELETE FROM auth.session WHERE "userId"=subject;
 GET DIAGNOSTICS removed=ROW_COUNT;
 INSERT INTO auth.account_deactivation_event(subject_id,occurred_at,correlation_id,revoked_sessions)
  VALUES(subject,instant,correlation,removed);
 RETURN QUERY SELECT 'DEACTIVATED'::text,instant;
END $$;
REVOKE ALL ON FUNCTION domain.deactivate_current_account(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.deactivate_current_account(uuid) TO quenda_domain;
