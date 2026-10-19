CREATE TABLE domain.administrative_rate_limit (
  account_id text PRIMARY KEY REFERENCES auth."user"(id),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 61)
);
ALTER TABLE domain.administrative_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.administrative_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_maintenance ON domain.administrative_rate_limit TO quenda_migrator USING (true) WITH CHECK (true);

-- No web table privileges. One bounded row per account; failed operations still
-- consume attempts. A new window starts after sixty seconds, never per replica.
CREATE FUNCTION domain.consume_administrative_attempt(subject text)
RETURNS TABLE (allowed boolean, retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  instant timestamptz := clock_timestamp();
  current_window timestamptz;
  current_attempts integer;
BEGIN
  INSERT INTO domain.administrative_rate_limit AS bucket (account_id, window_started_at, attempts)
  VALUES (subject, instant, 1)
  ON CONFLICT (account_id) DO UPDATE SET
    window_started_at = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN instant ELSE bucket.window_started_at END,
    attempts = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN 1 ELSE least(bucket.attempts + 1, 61) END
  RETURNING window_started_at, attempts INTO current_window, current_attempts;
  RETURN QUERY SELECT current_attempts <= 60,
    greatest(1, ceil(extract(epoch FROM current_window + interval '60 seconds' - instant))::integer);
END
$$;
REVOKE ALL ON FUNCTION domain.consume_administrative_attempt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.consume_administrative_attempt(text) TO quenda_domain;
