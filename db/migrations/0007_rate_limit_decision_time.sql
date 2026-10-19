-- Concurrent callers may acquire the row lock in a different order from
-- their start times. Report remaining time at the decision, not at entry.
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
    attempts = CASE WHEN bucket.window_started_at + interval '60 seconds' <= instant THEN 1 ELSE least(bucket.attempts + 1, 61) END
  RETURNING window_started_at, attempts INTO current_window, current_attempts;
  RETURN QUERY SELECT current_attempts <= 60,
    greatest(1, least(60, ceil(extract(epoch FROM current_window + interval '60 seconds' - clock_timestamp()))::integer));
END
$$;
