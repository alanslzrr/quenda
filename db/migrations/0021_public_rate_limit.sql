CREATE TABLE domain.public_rate_limit (
 subject_hash text PRIMARY KEY CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 window_started_at timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 61)
);
CREATE INDEX public_limit_expiry ON domain.public_rate_limit(window_started_at);
ALTER TABLE domain.public_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.public_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY public_limit_maintenance ON domain.public_rate_limit TO quenda_migrator USING(true) WITH CHECK(true);
CREATE FUNCTION domain.consume_public_attempt(subject text)
RETURNS TABLE(allowed boolean,retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE instant timestamptz:=clock_timestamp();
DECLARE current_window timestamptz;
DECLARE current_attempts integer;
BEGIN
 INSERT INTO domain.public_rate_limit AS bucket(subject_hash,window_started_at,attempts) VALUES(subject,instant,1)
 ON CONFLICT(subject_hash) DO UPDATE SET
 window_started_at=CASE WHEN bucket.window_started_at+interval '60 seconds'<=instant THEN instant ELSE bucket.window_started_at END,
 attempts=CASE WHEN bucket.window_started_at+interval '60 seconds'<=instant THEN 1 ELSE least(bucket.attempts+1,61) END
 RETURNING window_started_at,attempts INTO current_window,current_attempts;
 -- Bounded, nonblocking cleanup: expired counters do not accumulate forever
 -- during traffic, and a request never waits on another active counter here.
 DELETE FROM domain.public_rate_limit WHERE subject_hash IN (
 SELECT b.subject_hash FROM domain.public_rate_limit b WHERE b.window_started_at<instant-interval '10 minutes'
 ORDER BY b.window_started_at LIMIT 100 FOR UPDATE SKIP LOCKED);
 RETURN QUERY SELECT current_attempts<=60,
 greatest(1,least(60,ceil(extract(epoch FROM current_window+interval '60 seconds'-clock_timestamp()))::integer));
END $$;
REVOKE ALL ON FUNCTION domain.consume_public_attempt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.consume_public_attempt(text) TO quenda_domain;
