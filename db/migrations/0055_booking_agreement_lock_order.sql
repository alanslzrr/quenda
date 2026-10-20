-- Lock existing attributions, unit gates and current/future assignments in UUID order before the
-- caller locks/mutates the reservation. SERIALIZABLE rechecks a changed booking.
CREATE FUNCTION domain.lock_booking_agreements(reservation uuid,destination uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); booking domain.reservation; locked uuid;
BEGIN
 SELECT r.* INTO booking FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF booking.account_id IS DISTINCT FROM actor AND NOT domain.lock_permission('RESERVATION_MANAGE',booking.unit_id) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 FOR locked IN SELECT a.id FROM domain.agreement a WHERE
  EXISTS(SELECT 1 FROM domain.agreement_consumption c WHERE c.agreement_id=a.id AND c.tenant_id=tenant AND c.reservation_id=reservation AND NOT c.released)
  OR EXISTS(SELECT 1 FROM domain.unit_agreement_gate g WHERE g.agreement_id=a.id AND g.tenant_id=tenant AND (g.unit_id=booking.unit_id OR g.unit_id=destination))
  OR EXISTS(SELECT 1 FROM domain.agreement_assignment x WHERE x.agreement_id=a.id AND x.tenant_id=tenant
    AND (x.unit_id=booking.unit_id OR x.unit_id=destination) AND NOT isempty(x.effective_period) AND upper(x.effective_period)>clock_timestamp())
  ORDER BY a.id FOR SHARE
 LOOP NULL; END LOOP;
END $$;
REVOKE ALL ON FUNCTION domain.lock_booking_agreements(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_booking_agreements(uuid,uuid) TO quenda_domain;
