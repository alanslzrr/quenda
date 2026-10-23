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
RETURNS TABLE(minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT DISTINCT duration.minutes FROM domain.reservable_unit u
 CROSS JOIN LATERAL domain.public_unit_calendar(tenant,u.id) c
 CROSS JOIN LATERAL generate_series(
  (c.calendar->>'minimumMinutes')::integer,
  (c.calendar->>'maximumMinutes')::integer
 ) duration(minutes)
 WHERE u.tenant_id=tenant AND duration.minutes % (c.calendar->>'stepMinutes')::integer=0
 ORDER BY duration.minutes
$$;
REVOKE ALL ON FUNCTION domain.public_search_units(uuid,uuid),domain.public_booking_durations(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_search_units(uuid,uuid),domain.public_booking_durations(uuid) TO quenda_domain;
