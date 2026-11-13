-- Reading screens no longer spends the budget for changing data. A management
-- page load issues several authenticated reads, so a shared budget of 60 per
-- minute ran out under ordinary navigation. Reads now have their own bucket of
-- 600 per minute; commands keep theirs and rise to 120 per minute. Both stay
-- one bounded row per account, shared by every replica.
ALTER TABLE domain.administrative_rate_limit DROP CONSTRAINT administrative_rate_limit_attempts_check;
ALTER TABLE domain.administrative_rate_limit ADD CONSTRAINT administrative_rate_limit_attempts_check CHECK (attempts BETWEEN 1 AND 121);

CREATE OR REPLACE FUNCTION domain.consume_administrative_attempt(subject text)
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
    attempts = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN 1 ELSE least(bucket.attempts + 1, 121) END
  RETURNING window_started_at, attempts INTO current_window, current_attempts;
  RETURN QUERY SELECT current_attempts <= 120,
    greatest(1, least(60, ceil(extract(epoch FROM current_window + interval '60 seconds' - clock_timestamp()))::integer));
END
$$;

CREATE TABLE domain.read_rate_limit (
  account_id text PRIMARY KEY REFERENCES auth."user"(id),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 601)
);
ALTER TABLE domain.read_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.read_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY read_rate_maintenance ON domain.read_rate_limit TO quenda_migrator USING (true) WITH CHECK (true);

CREATE FUNCTION domain.consume_read_attempt(subject text)
RETURNS TABLE (allowed boolean, retry_after integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  instant timestamptz := clock_timestamp();
  current_window timestamptz;
  current_attempts integer;
BEGIN
  INSERT INTO domain.read_rate_limit AS bucket (account_id, window_started_at, attempts)
  VALUES (subject, instant, 1)
  ON CONFLICT (account_id) DO UPDATE SET
    window_started_at = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN instant ELSE bucket.window_started_at END,
    attempts = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN 1 ELSE least(bucket.attempts + 1, 601) END
  RETURNING window_started_at, attempts INTO current_window, current_attempts;
  RETURN QUERY SELECT current_attempts <= 600,
    greatest(1, least(60, ceil(extract(epoch FROM current_window + interval '60 seconds' - clock_timestamp()))::integer));
END
$$;
REVOKE ALL ON FUNCTION domain.consume_read_attempt(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.consume_read_attempt(text) TO quenda_domain;
