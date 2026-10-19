-- Internal calendar reconciliation projection: no account, reason or booking ID.
CREATE FUNCTION domain.calendar_reservation_intervals(unit uuid,after_start timestamptz)
RETURNS TABLE(starts_at timestamptz,ends_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_permission('CATALOG_MANAGE',unit) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT r.starts_at,r.ends_at FROM domain.reservation r
 WHERE r.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND r.unit_id=unit
 AND r.status='CONFIRMADA' AND r.ends_at>now() AND (after_start IS NULL OR r.starts_at>after_start)
 ORDER BY r.starts_at LIMIT 100;
END $$;
REVOKE ALL ON FUNCTION domain.calendar_reservation_intervals(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.calendar_reservation_intervals(uuid,timestamptz) TO quenda_domain;
