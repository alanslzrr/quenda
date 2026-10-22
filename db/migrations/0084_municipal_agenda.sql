-- Planning metadata does not grant catalog editing or expose reservation owners.
CREATE FUNCTION domain.agenda_units(after_id uuid)
RETURNS TABLE(id uuid,name text) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name FROM domain.reservable_unit u
 WHERE u.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND domain.account_enabled(nullif(current_setting('quenda.account_id',true),''))
 AND (after_id IS NULL OR u.id>after_id)
 AND (domain.lock_permission('RESERVATION_READ',u.id) OR domain.lock_permission('RESERVATION_MANAGE',u.id) OR domain.lock_permission('UNIT_BLOCK',u.id))
 ORDER BY u.id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.agenda_units(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.agenda_units(uuid) TO quenda_domain;

-- Staff may exclude one hold only when authorized to relocate its source and destination.
CREATE FUNCTION domain.administrative_reservation_available_slots(tenant uuid,unit uuid,reservation uuid,starts timestamptz[],ends timestamptz[])
RETURNS TABLE(slot_index integer) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT candidate.ordinality::integer
 FROM unnest(starts,ends) WITH ORDINALITY AS candidate(starts_at,ends_at,ordinality)
 WHERE tenant=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND domain.account_enabled(nullif(current_setting('quenda.account_id',true),''))
 AND domain.lock_permission('RESERVATION_MANAGE',unit)
 AND EXISTS(SELECT 1 FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation
   AND domain.lock_permission('RESERVATION_MANAGE',r.unit_id) AND r.status='CONFIRMADA' AND r.starts_at>now())
 AND cardinality(starts)=cardinality(ends)
 AND candidate.starts_at IS NOT NULL AND candidate.ends_at IS NOT NULL
 AND isfinite(candidate.starts_at) AND isfinite(candidate.ends_at) AND candidate.starts_at<candidate.ends_at
 AND EXISTS(SELECT 1 FROM domain.public_unit_calendar(tenant,unit))
 AND NOT EXISTS(SELECT 1 FROM domain.occupancy o WHERE o.tenant_id=tenant AND o.unit_id=unit
   AND o.released_at IS NULL AND o.reservation_id IS DISTINCT FROM reservation
   AND o.period && tstzrange(candidate.starts_at,candidate.ends_at,'[)'))
 ORDER BY candidate.ordinality
$$;
REVOKE ALL ON FUNCTION domain.administrative_reservation_available_slots(uuid,uuid,uuid,timestamptz[],timestamptz[]) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.administrative_reservation_available_slots(uuid,uuid,uuid,timestamptz[],timestamptz[]) TO quenda_domain;
