-- Names of the place of a reservation for its detail: municipality, facility and
-- space. Readable by the holder and by staff with current RESERVATION_READ or
-- RESERVATION_MANAGE over the unit, the same audience as the reservation itself.
-- Withdrawn facilities and spaces keep their names, so a reservation on a retired
-- space still shows where it was.
CREATE FUNCTION domain.reservation_place(reservation_id_arg uuid)
RETURNS TABLE(municipality_name text,facility_name text,unit_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r domain.reservation%ROWTYPE;
BEGIN
 SELECT b.* INTO r FROM domain.reservation b WHERE b.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND b.id=reservation_id_arg;
 IF NOT FOUND OR NOT coalesce((r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_READ',r.unit_id) OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)),false) THEN
 RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.name,f.name,u.name
  FROM domain.reservable_unit u
  JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
  JOIN domain.municipality m ON m.id=u.tenant_id
  WHERE (u.tenant_id,u.id)=(r.tenant_id,r.unit_id);
END $$;
REVOKE ALL ON FUNCTION domain.reservation_place(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.reservation_place(uuid) TO quenda_domain;
