-- Exclude only the authenticated holder's selected reservation. Neither public
-- callers nor municipal readers can use this projection to remove another hold.
CREATE FUNCTION domain.own_reservation_available_slots(tenant uuid,unit uuid,reservation uuid,starts timestamptz[],ends timestamptz[])
RETURNS TABLE(slot_index integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT candidate.ordinality::integer
 FROM unnest(starts,ends) WITH ORDINALITY AS candidate(starts_at,ends_at,ordinality)
 WHERE tenant=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND domain.account_enabled(nullif(current_setting('quenda.account_id',true),''))
 AND EXISTS(SELECT 1 FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation
   AND r.account_id=nullif(current_setting('quenda.account_id',true),'') AND r.status='CONFIRMADA'
   AND r.starts_at>now() AND now()<=r.starts_at-r.cancellation_minutes*interval '1 minute')
 AND cardinality(starts)=cardinality(ends)
 AND candidate.starts_at IS NOT NULL AND candidate.ends_at IS NOT NULL
 AND isfinite(candidate.starts_at) AND isfinite(candidate.ends_at) AND candidate.starts_at<candidate.ends_at
 AND EXISTS(SELECT 1 FROM domain.public_unit_calendar(tenant,unit))
 AND NOT EXISTS(SELECT 1 FROM domain.occupancy o WHERE o.tenant_id=tenant AND o.unit_id=unit
   AND o.released_at IS NULL AND o.reservation_id IS DISTINCT FROM reservation
   AND o.period && tstzrange(candidate.starts_at,candidate.ends_at,'[)'))
 ORDER BY candidate.ordinality
$$;
REVOKE ALL ON FUNCTION domain.own_reservation_available_slots(uuid,uuid,uuid,timestamptz[],timestamptz[]) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservation_available_slots(uuid,uuid,uuid,timestamptz[],timestamptz[]) TO quenda_domain;
