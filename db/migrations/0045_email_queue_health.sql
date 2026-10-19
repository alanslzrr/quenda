-- Operational counts only: the worker cannot enumerate recipients or bookings.
CREATE FUNCTION domain.reservation_email_health()
RETURNS TABLE(pending bigint,leased bigint,exhausted bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT count(*) FILTER(WHERE accepted_at IS NULL AND exhausted_at IS NULL),
  count(*) FILTER(WHERE lease_token IS NOT NULL AND accepted_at IS NULL AND exhausted_at IS NULL),
  count(*) FILTER(WHERE exhausted_at IS NOT NULL)
 FROM domain.reservation_email
$$;
REVOKE ALL ON FUNCTION domain.reservation_email_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.reservation_email_health() TO quenda_worker;
