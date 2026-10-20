-- A technical email challenge proves control of the address. It never grants a
-- session or revives permissions; authentication still follows reactivation.
CREATE TABLE auth.account_reactivation_challenge (
 token_digest text PRIMARY KEY CHECK(token_digest ~ '^[a-f0-9]{64}$'),
 account_id text NOT NULL REFERENCES auth."user"(id),
 email text NOT NULL,
 deactivated_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 consumed_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX account_reactivation_challenge_account ON auth.account_reactivation_challenge(account_id);
CREATE INDEX account_reactivation_challenge_expiry ON auth.account_reactivation_challenge(expires_at);
ALTER TABLE auth.account_reactivation_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_reactivation_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY account_reactivation_challenge_maintenance ON auth.account_reactivation_challenge TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY account_reactivation_challenge_authentication ON auth.account_reactivation_challenge TO quenda_auth USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON auth.account_reactivation_challenge TO quenda_auth;
REVOKE ALL ON auth.account_reactivation_challenge FROM PUBLIC,quenda_domain,quenda_worker;

CREATE TABLE auth.account_reactivation_rate_limit (
 bucket text PRIMARY KEY CHECK(length(bucket) BETWEEN 1 AND 100),
 window_started_at timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts>0)
);
CREATE INDEX account_reactivation_rate_limit_expiry ON auth.account_reactivation_rate_limit(window_started_at);
ALTER TABLE auth.account_reactivation_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_reactivation_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY account_reactivation_rate_limit_maintenance ON auth.account_reactivation_rate_limit TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.account_reactivation_rate_limit FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.consume_reactivation_attempt(bucket_key text,maximum integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_attempts integer; instant timestamptz:=clock_timestamp();
BEGIN
 IF maximum NOT IN (5,20,30) OR length(bucket_key)>100 THEN
  RAISE EXCEPTION 'Invalid reactivation limit' USING ERRCODE='22023';
 END IF;
 DELETE FROM auth.account_reactivation_rate_limit WHERE bucket IN (
  SELECT bucket FROM auth.account_reactivation_rate_limit
  WHERE window_started_at<instant-interval '1 day' ORDER BY window_started_at LIMIT 100
 );
 DELETE FROM auth.account_reactivation_challenge WHERE token_digest IN (
  SELECT token_digest FROM auth.account_reactivation_challenge
  WHERE expires_at<=instant ORDER BY expires_at LIMIT 100
 );
 INSERT INTO auth.account_reactivation_rate_limit AS bucket(bucket,window_started_at,attempts)
 VALUES(bucket_key,instant,1)
 ON CONFLICT(bucket) DO UPDATE SET
  window_started_at=CASE WHEN bucket.window_started_at+interval '15 minutes'<=instant THEN instant ELSE bucket.window_started_at END,
  attempts=CASE WHEN bucket.window_started_at+interval '15 minutes'<=instant THEN 1 ELSE least(bucket.attempts+1,maximum+1) END
 RETURNING attempts INTO current_attempts;
 RETURN current_attempts<=maximum;
END $$;
REVOKE ALL ON FUNCTION auth.consume_reactivation_attempt(text,integer) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.consume_reactivation_attempt(text,integer) TO quenda_auth;

CREATE TABLE auth.account_reactivation_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_id text NOT NULL REFERENCES auth."user"(id),
 previous_deactivated_at timestamptz NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL UNIQUE
);
ALTER TABLE auth.account_reactivation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_reactivation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY account_reactivation_event_maintenance ON auth.account_reactivation_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.account_reactivation_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.lock_reactivation_account(subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable reactivation required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM auth.account_lifecycle
 WHERE account_id=subject AND deactivated_at IS NOT NULL AND suspended_at IS NULL
 FOR UPDATE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION auth.lock_reactivation_account(text) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.lock_reactivation_account(text) TO quenda_auth;

CREATE FUNCTION auth.complete_account_reactivation(digest text,subject text,correlation uuid)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous timestamptz; instant timestamptz:=clock_timestamp();
BEGIN
 IF correlation IS NULL OR NOT auth.lock_reactivation_account(subject) THEN RETURN NULL; END IF;
 SELECT deactivated_at INTO previous FROM auth.account_lifecycle WHERE account_id=subject;
 UPDATE auth.account_reactivation_challenge SET consumed_at=instant
 WHERE token_digest=digest AND account_id=subject AND deactivated_at=previous
 AND consumed_at IS NULL AND expires_at>instant AND attempts<=5
 AND email=(SELECT u.email FROM auth."user" u WHERE u.id=subject AND u."emailVerified");
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Invalidate any other challenge from this deactivation cycle atomically.
 UPDATE auth.account_reactivation_challenge SET consumed_at=instant
 WHERE account_id=subject AND consumed_at IS NULL;
 PERFORM domain.invalidate_account_authority(subject);
 UPDATE auth.account_lifecycle SET deactivated_at=NULL,session_generation=session_generation+1
 WHERE account_id=subject;
 INSERT INTO auth.account_reactivation_event(subject_id,previous_deactivated_at,occurred_at,correlation_id)
 VALUES(subject,previous,instant,correlation);
 RETURN instant;
END $$;
REVOKE ALL ON FUNCTION auth.complete_account_reactivation(text,text,uuid) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.complete_account_reactivation(text,text,uuid) TO quenda_auth;
