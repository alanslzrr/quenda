-- Return only candidate ordinals, never reservation/block IDs or their owners.
CREATE FUNCTION domain.public_available_slots(tenant uuid,unit uuid,starts timestamptz[],ends timestamptz[])
RETURNS TABLE(slot_index integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT candidate.ordinality::integer
 FROM unnest(starts,ends) WITH ORDINALITY AS candidate(starts_at,ends_at,ordinality)
 WHERE cardinality(starts)=cardinality(ends)
 AND candidate.starts_at IS NOT NULL AND candidate.ends_at IS NOT NULL
 AND isfinite(candidate.starts_at) AND isfinite(candidate.ends_at) AND candidate.starts_at<candidate.ends_at
 AND EXISTS(SELECT 1 FROM domain.public_unit_calendar(tenant,unit))
 AND NOT EXISTS(SELECT 1 FROM domain.occupancy o WHERE o.tenant_id=tenant AND o.unit_id=unit
  AND o.released_at IS NULL AND o.period && tstzrange(candidate.starts_at,candidate.ends_at,'[)'))
 ORDER BY candidate.ordinality
$$;
REVOKE ALL ON FUNCTION domain.public_available_slots(uuid,uuid,timestamptz[],timestamptz[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.public_available_slots(uuid,uuid,timestamptz[],timestamptz[]) TO quenda_domain;
