-- Each duration reports how many published units admit it, using the search admission rule.
DROP FUNCTION domain.public_booking_durations(uuid);
CREATE FUNCTION domain.public_booking_durations(tenant uuid)
RETURNS TABLE(minutes integer,units integer,has_more boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH settings AS (
 SELECT u.id,(c.calendar->>'minimumMinutes')::integer lo,
 (c.calendar->>'maximumMinutes')::integer hi,(c.calendar->>'stepMinutes')::integer step
 FROM domain.reservable_unit u CROSS JOIN LATERAL domain.public_unit_calendar(tenant,u.id) c
 WHERE u.tenant_id=tenant
 ), choices AS (
 SELECT DISTINCT lo+step*n AS minutes FROM settings
 CROSS JOIN LATERAL generate_series(0,LEAST((hi-lo)/step,47)) n
 ), page AS (SELECT choices.minutes FROM choices ORDER BY choices.minutes LIMIT 49)
 SELECT page.minutes,
 (SELECT count(*)::integer FROM settings s
 WHERE page.minutes BETWEEN s.lo AND s.hi AND page.minutes%s.step=0),
 EXISTS(SELECT 1 FROM settings WHERE (hi-lo)/step>=48) OR (SELECT count(*) FROM page)>48
 FROM page ORDER BY page.minutes LIMIT 48
$$;

REVOKE ALL ON FUNCTION domain.public_booking_durations(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_booking_durations(uuid) TO quenda_domain;
