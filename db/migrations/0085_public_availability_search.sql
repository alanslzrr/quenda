-- Public projections expose only published catalog data, never booking identities.
CREATE FUNCTION domain.public_search_units(tenant uuid, after_id uuid)
RETURNS TABLE(id uuid, name text, facility_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,f.name FROM domain.reservable_unit u
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE u.tenant_id=tenant AND (after_id IS NULL OR u.id>after_id)
 AND EXISTS(SELECT 1 FROM domain.public_unit_calendar(tenant,u.id))
 ORDER BY u.id LIMIT 21
$$;
CREATE FUNCTION domain.public_booking_durations(tenant uuid)
RETURNS TABLE(minutes integer,has_more boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH settings AS (
 SELECT DISTINCT (c.calendar->>'minimumMinutes')::integer lo,
 (c.calendar->>'maximumMinutes')::integer hi,(c.calendar->>'stepMinutes')::integer step
 FROM domain.reservable_unit u CROSS JOIN LATERAL domain.public_unit_calendar(tenant,u.id) c
 WHERE u.tenant_id=tenant
 ), choices AS (
 SELECT DISTINCT lo+step*n AS minutes FROM settings
 CROSS JOIN LATERAL generate_series(0,LEAST((hi-lo)/step,47)) n
 ), page AS (SELECT choices.minutes FROM choices ORDER BY choices.minutes LIMIT 49)
 SELECT page.minutes,EXISTS(SELECT 1 FROM settings WHERE (hi-lo)/step>=48)
 OR (SELECT count(*) FROM page)>48 FROM page ORDER BY page.minutes LIMIT 48
$$;

REVOKE ALL ON FUNCTION domain.public_search_units(uuid,uuid),domain.public_booking_durations(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_search_units(uuid,uuid),domain.public_booking_durations(uuid) TO quenda_domain;
